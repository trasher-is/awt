// Storage for hub-to-hub sharing: who may read us (peer_links), whom we read
// (peer_sources), and what we received (peer_intel). See docs/peer-sharing.md.
const crypto = require('crypto');
const db = require('../database');
const { normaliseScopes } = require('../utils/peer-kinds');

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function parseJson(text, fallback) {
    try { const v = JSON.parse(text); return v ?? fallback; } catch (e) { return fallback; }
}

function cleanTags(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(list.map(t => String(t).trim().toUpperCase()).filter(t => /^[A-Z0-9_.\-]{1,12}$/.test(t)))].join(',');
}

// ─── OUTBOUND: partners that may read our feed ───────────────────────────────

function linkRow(r) {
    if (!r) return null;
    return {
        id: r.id, name: r.name, tokenHint: r.token_hint,
        scopes: normaliseScopes(parseJson(r.scopes, [])),
        excludeFriendly: !!r.exclude_friendly,
        excludeTags: r.exclude_tags ? r.exclude_tags.split(',').filter(Boolean) : [],
        enabled: !!r.enabled,
        createdAt: r.created_at, lastReadAt: r.last_read_at, readCount: r.read_count,
    };
}

// The token is shown once, here, and never again: only its hash is stored.
function createLink({ name, scopes, excludeFriendly = true, excludeTags = '' }) {
    const token = 'awtp_' + crypto.randomBytes(32).toString('base64url');
    const info = db.prepare(`
        INSERT INTO peer_links (name, token_hash, token_hint, scopes, exclude_friendly, exclude_tags)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(name).slice(0, 80), sha256(token), token.slice(-4),
        JSON.stringify(normaliseScopes(scopes)), excludeFriendly ? 1 : 0, cleanTags(excludeTags));
    return { link: getLink(info.lastInsertRowid), token };
}

function getLink(id) {
    return linkRow(db.prepare(`SELECT * FROM peer_links WHERE id = ?`).get(id));
}

function listLinks() {
    return db.prepare(`SELECT * FROM peer_links ORDER BY id`).all().map(linkRow);
}

function updateLink(id, patch) {
    const cur = db.prepare(`SELECT * FROM peer_links WHERE id = ?`).get(id);
    if (!cur) return null;
    db.prepare(`
        UPDATE peer_links SET name = ?, scopes = ?, exclude_friendly = ?, exclude_tags = ?, enabled = ? WHERE id = ?
    `).run(
        patch.name !== undefined ? String(patch.name).slice(0, 80) : cur.name,
        patch.scopes !== undefined ? JSON.stringify(normaliseScopes(patch.scopes)) : cur.scopes,
        patch.excludeFriendly !== undefined ? (patch.excludeFriendly ? 1 : 0) : cur.exclude_friendly,
        patch.excludeTags !== undefined ? cleanTags(patch.excludeTags) : cur.exclude_tags,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
        id);
    return getLink(id);
}

function deleteLink(id) {
    return db.prepare(`DELETE FROM peer_links WHERE id = ?`).run(id).changes > 0;
}

// Looked up by hash: the presented token is hashed and matched by index, so there is no
// string comparison of secrets to time.
function findEnabledLinkByToken(token) {
    if (typeof token !== 'string' || !token.startsWith('awtp_') || token.length > 200) return null;
    return linkRow(db.prepare(`SELECT * FROM peer_links WHERE token_hash = ? AND enabled = 1`).get(sha256(token)));
}

function touchLink(id) {
    db.prepare(`UPDATE peer_links SET last_read_at = CURRENT_TIMESTAMP, read_count = read_count + 1 WHERE id = ?`).run(id);
}

// ─── INBOUND: hubs we read from ──────────────────────────────────────────────

function sourceRow(r, { withToken = false } = {}) {
    if (!r) return null;
    const out = {
        id: r.id, name: r.name, baseUrl: r.base_url, enabled: !!r.enabled,
        tokenHint: r.token ? r.token.slice(-4) : null,
        offeredKinds: parseJson(r.offered_kinds, null),
        cursors: parseJson(r.cursors, {}),
        lastPullAt: r.last_pull_at, lastOkAt: r.last_ok_at, lastError: r.last_error,
        lastReceived: r.last_received, createdAt: r.created_at,
    };
    if (withToken) out.token = r.token;
    return out;
}

function createSource({ name, baseUrl, token }) {
    const info = db.prepare(`INSERT INTO peer_sources (name, base_url, token) VALUES (?, ?, ?)`)
        .run(String(name).slice(0, 80), baseUrl, String(token));
    return getSource(info.lastInsertRowid);
}

function getSource(id, opts) {
    return sourceRow(db.prepare(`SELECT * FROM peer_sources WHERE id = ?`).get(id), opts);
}

function listSources(opts) {
    const rows = db.prepare(`
        SELECT s.*, (SELECT COUNT(*) FROM peer_intel i WHERE i.source_id = s.id) AS item_count
        FROM peer_sources s ORDER BY s.id
    `).all();
    return rows.map(r => Object.assign(sourceRow(r, opts), { itemCount: r.item_count }));
}

function updateSource(id, patch) {
    const cur = db.prepare(`SELECT * FROM peer_sources WHERE id = ?`).get(id);
    if (!cur) return null;
    db.prepare(`UPDATE peer_sources SET name = ?, enabled = ?, token = ? WHERE id = ?`).run(
        patch.name !== undefined ? String(patch.name).slice(0, 80) : cur.name,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
        patch.token ? String(patch.token) : cur.token,
        id);
    return getSource(id);
}

// Removing a source removes everything it ever sent (ON DELETE CASCADE).
function deleteSource(id) {
    return db.prepare(`DELETE FROM peer_sources WHERE id = ?`).run(id).changes > 0;
}

function recordPull(id, { ok, error = null, received = 0, offeredKinds }) {
    db.prepare(`
        UPDATE peer_sources SET last_pull_at = CURRENT_TIMESTAMP,
            last_ok_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_ok_at END,
            last_error = ?, last_received = ?,
            offered_kinds = COALESCE(?, offered_kinds)
        WHERE id = ?
    `).run(ok ? 1 : 0, error ? String(error).slice(0, 300) : null, received,
        offeredKinds ? JSON.stringify(offeredKinds) : null, id);
}

// ─── RECEIVED INTEL ──────────────────────────────────────────────────────────

// Only a newer (or equally new) observation replaces what we hold for the same item from
// the same source, so a partner replaying an old page cannot roll our copy back.
const upsertIntelStmt = db.prepare(`
    INSERT INTO peer_intel (source_id, kind, item_key, changed_at, payload, received_at)
    VALUES (@sourceId, @kind, @key, @changedAt, @payload, CURRENT_TIMESTAMP)
    ON CONFLICT(source_id, kind, item_key) DO UPDATE SET
        changed_at = excluded.changed_at, payload = excluded.payload, received_at = CURRENT_TIMESTAMP
    WHERE excluded.changed_at >= peer_intel.changed_at
`);
const setCursorStmt = db.prepare(`UPDATE peer_sources SET cursors = json_set(cursors, '$.' || ?, ?) WHERE id = ?`);

// One page lands with its cursor in a single transaction: a crash between the two can
// neither lose a page nor skip one.
const storePage = db.transaction((sourceId, kind, items, nextCursor) => {
    let stored = 0;
    for (const it of items) {
        stored += upsertIntelStmt.run({ sourceId, kind, key: it.key, changedAt: it.changedAt, payload: JSON.stringify(it.data) }).changes;
    }
    if (nextCursor) setCursorStmt.run(kind, nextCursor, sourceId);
    return stored;
});

function queryIntel({ kind, sourceId = null, q = '', limit = 200 }) {
    const like = `%${String(q).toLowerCase()}%`;
    const rows = db.prepare(`
        SELECT i.source_id, s.name AS source_name, i.kind, i.item_key, i.changed_at, i.received_at, i.payload
        FROM peer_intel i JOIN peer_sources s ON s.id = i.source_id
        WHERE i.kind = @kind
          AND (@sourceId IS NULL OR i.source_id = @sourceId)
          AND (@q = '' OR lower(i.payload) LIKE @like OR i.item_key = @q)
        ORDER BY i.changed_at DESC
        LIMIT @limit
    `).all({ kind, sourceId, q: String(q), like, limit: Math.max(1, Math.min(1000, limit | 0)) });
    return rows.map(r => ({
        sourceId: r.source_id, sourceName: r.source_name, key: r.item_key,
        changedAt: r.changed_at, receivedAt: r.received_at, data: parseJson(r.payload, {}),
    }));
}

function intelCounts() {
    return db.prepare(`SELECT source_id, kind, COUNT(*) AS n FROM peer_intel GROUP BY source_id, kind`).all();
}

// Fleet sightings go stale fast and the hub already drops its own after 10 days; received
// ones follow the same rule so a partner who stops sharing does not leave ghosts behind.
function pruneIntel() {
    return db.prepare(`DELETE FROM peer_intel WHERE kind = 'fleets' AND changed_at <= datetime('now', '-10 days')`).run().changes;
}

module.exports = {
    sha256, cleanTags,
    createLink, getLink, listLinks, updateLink, deleteLink, findEnabledLinkByToken, touchLink,
    createSource, getSource, listSources, updateSource, deleteSource, recordPull,
    storePage, queryIntel, intelCounts, pruneIntel,
};
