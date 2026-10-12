// The outbound half of hub-to-hub sharing: what a partner hub receives when it reads our
// feed with the token we gave it. See docs/peer-sharing.md.
//
// Three rules hold for every page this builds:
//   1. Only kinds the link was granted (link.scopes) — the route refuses the rest.
//   2. Only the fields peer-kinds.js lists for that kind.
//   3. Only rows our OWN members put in the database. Everything here reads the
//      member-filled tables (systems, planets, players, ...); nothing reads peer_intel,
//      which is where partners' data lives. That is what stops intel from hopping on to a
//      third hub, and the peer-feed test pins it.
//
// Paging is by (changed_at, id), strictly increasing. updated_at is only to the second,
// so a cursor on the timestamp alone would either repeat or skip rows that share a second.
const db = require('../database');
const { shape } = require('./peer-kinds');
const { friendlyAllianceTags } = require('./friendly-alliance-tags');

const MAX_LIMIT = 500;
const TS = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}';
const CURSOR_RE = new RegExp(`^(${TS})\\|(\\d{1,15})$`);

function parseCursor(raw) {
    if (!raw) return { ts: '', id: 0 };
    const m = CURSOR_RE.exec(String(raw));
    return m ? { ts: m[1], id: Number(m[2]) } : null;
}

// The alliances our own hub accounts play in. friendlyAllianceTags() finds our tag from the
// Alliance Stats roster scrape; on a hub that has not scraped it yet that answer is empty,
// and "hide our alliance" must not quietly mean "hide nothing". So the accounts that log
// in here count as well.
const memberAllianceTagsStmt = db.prepare(`
    SELECT DISTINCT upper(a.tag) AS tag
    FROM app_users u JOIN players p ON p.name = u.game_name COLLATE NOCASE
    JOIN alliances a ON a.id = p.alliance_id
    WHERE a.tag IS NOT NULL AND a.tag <> ''
`);

// Tags whose players, fleets and battles this link does not see.
function excludedTags(link) {
    const tags = new Set((link.excludeTags || []).map(t => String(t).toUpperCase()));
    if (link.excludeFriendly) {
        for (const t of friendlyAllianceTags()) tags.add(String(t).toUpperCase());
        for (const r of memberAllianceTagsStmt.all()) tags.add(r.tag);
    }
    return [...tags];
}

const PAGE = `
    WHERE changed_at <> '' AND (changed_at > @ts OR (changed_at = @ts AND id > @id))
    ORDER BY changed_at, id LIMIT @limit
`;

// Each query returns one page WINDOW, unfiltered. Exclusion happens afterwards in
// isExcluded(): the cursor must advance past rows the filter drops, or a page made only of
// excluded rows would come back empty and look like the end of the feed.
const QUERIES = {
    systems: db.prepare(`
        WITH c AS (
            SELECT s.id, s.name, s.x, s.y,
                   max(COALESCE(datetime(s.updated_at), ''),
                       COALESCE((SELECT datetime(MAX(p.updated_at)) FROM planets p WHERE p.system_id = s.id), '')) AS changed_at
            FROM systems s
        )
        SELECT * FROM c ${PAGE}
    `),
    players: db.prepare(`
        WITH c AS (
            SELECT p.*, a.tag AS alliance_tag, COALESCE(datetime(p.updated_at), '') AS changed_at
            FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
        )
        SELECT * FROM c ${PAGE}
    `),
    alliances: db.prepare(`
        WITH c AS (SELECT a.*, COALESCE(datetime(a.updated_at), '') AS changed_at FROM alliances a)
        SELECT * FROM c ${PAGE}
    `),
    fleets: db.prepare(`
        WITH c AS (
            SELECT f.*, pl.name AS owner_name, a.tag AS owner_tag, COALESCE(datetime(f.updated_at), '') AS changed_at
            FROM fleets f LEFT JOIN players pl ON pl.id = f.owner_id LEFT JOIN alliances a ON a.id = pl.alliance_id
        )
        SELECT * FROM c ${PAGE}
    `),
    battle_reports: db.prepare(`
        WITH c AS (
            SELECT b.*, max(COALESCE(datetime(b.created_at), ''),
                            COALESCE(datetime(b.ship_detail_scraped_at), ''),
                            COALESCE(datetime(b.stats_snapshot_at), '')) AS changed_at
            FROM battle_reports b
        )
        SELECT * FROM c ${PAGE}
    `),
    // One row per player; attachFleetLocations adds that player's ranked fleets.
    fleet_locations: db.prepare(`
        WITH c AS (
            SELECT sf.player_id AS id, p.name AS owner_name, a.tag AS owner_tag,
                   COALESCE(datetime(MAX(sf.updated_at)), '') AS changed_at
            FROM strongest_fleet sf
            LEFT JOIN players p ON p.id = sf.player_id LEFT JOIN alliances a ON a.id = p.alliance_id
            GROUP BY sf.player_id
        )
        SELECT * FROM c ${PAGE}
    `),
    // Only rows that hold the attack report; covering, last_ontime and the Discord message
    // ids are never selected.
    incomings: db.prepare(`
        WITH c AS (
            SELECT rowid AS id, payload, COALESCE(datetime(updated_at), '') AS changed_at
            FROM incoming_msgs WHERE payload IS NOT NULL
        )
        SELECT * FROM c ${PAGE}
    `),
};

// incoming_msgs keeps the report as JSON; flatten it to the fields peer-kinds lists.
function incomingRow(r) {
    let p = {};
    try { p = JSON.parse(r.payload) || {}; } catch (e) { /* shared as an empty report */ }
    const a = p.attacker || {}, t = p.target || {}, s = p.ships || {};
    return {
        id: r.id, changed_at: r.changed_at,
        attacker_id: a.id, attacker_name: a.name, attacker_tag: a.tag,
        target_system_id: t.systemId, target_planet_index: t.planetIndex, target_planet_name: t.planetName,
        cv: p.cv, transports: s.transports, destroyers: s.destroyers, cruisers: s.cruisers, battleships: s.battleships,
        arrival_unix: p.arrivalUnix,
    };
}
const ROW_MAP = { incomings: incomingRow };

// Which tag columns decide whether a row is hidden from this link. Systems are never
// dropped whole — see attachPlanets.
const TAG_COLUMNS = {
    systems: [],
    players: ['alliance_tag'],
    alliances: ['tag'],
    fleets: ['owner_tag'],
    battle_reports: ['att_alliance_tag', 'def_alliance_tag'],
    fleet_locations: ['owner_tag'],
    incomings: ['attacker_tag'],
};

function isExcluded(kind, row, exSet) {
    return TAG_COLUMNS[kind].some(col => row[col] && exSet.has(String(row[col]).toUpperCase()));
}

const planetsForSystemsStmt = db.prepare(`
    SELECT p.system_id, p.planet_index, p.game_planet_id, p.name, p.owner_id, p.population, p.starbase,
           p.is_sieged, p.has_fleet, pl.name AS owner_name, a.tag AS owner_tag
    FROM planets p LEFT JOIN players pl ON pl.id = p.owner_id LEFT JOIN alliances a ON a.id = pl.alliance_id
    WHERE p.system_id IN (SELECT value FROM json_each(@ids))
    ORDER BY p.system_id, p.planet_index
`);

// Ownership and population are on the game's map for anyone with vision; starbase, fleet
// presence and siege state on an excluded alliance's planet are defence details, so those
// three are blanked rather than the planet dropped.
function attachPlanets(rows, exSet) {
    if (!rows.length) return;
    const bySystem = new Map(rows.map(r => [r.id, (r.planets = [])]));
    for (const p of planetsForSystemsStmt.all({ ids: JSON.stringify(rows.map(r => r.id)) })) {
        if (p.owner_tag && exSet.has(String(p.owner_tag).toUpperCase())) {
            p.starbase = null; p.has_fleet = null; p.is_sieged = null;
        }
        bySystem.get(p.system_id)?.push(p);
    }
}

const fleetsForPlayersStmt = db.prepare(`
    SELECT sf.player_id, sf.rank, sf.destroyers, sf.cruisers, sf.battleships, sf.cv,
           sf.system_id, s.name AS system_name, sf.planet_index, sf.planet_label
    FROM strongest_fleet sf LEFT JOIN systems s ON s.id = sf.system_id
    WHERE sf.player_id IN (SELECT value FROM json_each(@ids))
    ORDER BY sf.player_id, sf.rank
`);

function attachFleetLocations(rows) {
    if (!rows.length) return;
    const byPlayer = new Map(rows.map(r => [r.id, (r.fleets = [])]));
    for (const f of fleetsForPlayersStmt.all({ ids: JSON.stringify(rows.map(r => r.id)) })) {
        byPlayer.get(f.player_id)?.push(f);
    }
}

function buildFeedPage(link, kind, { after = '', limit = MAX_LIMIT } = {}) {
    if (!QUERIES[kind]) throw Object.assign(new Error('unknown kind'), { status: 400 });
    if (!link.scopes.includes(kind)) throw Object.assign(new Error('kind not shared with this link'), { status: 403 });
    const cursor = parseCursor(after);
    if (!cursor) throw Object.assign(new Error('bad cursor'), { status: 400 });
    const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) | 0 || MAX_LIMIT));
    const exSet = new Set(excludedTags(link));

    const window = QUERIES[kind].all({ ts: cursor.ts, id: cursor.id, limit: lim });
    const last = window[window.length - 1];
    const rows = window.map(ROW_MAP[kind] || (r => r)).filter(r => !isExcluded(kind, r, exSet));
    if (kind === 'systems') attachPlanets(rows, exSet);
    if (kind === 'fleet_locations') attachFleetLocations(rows);
    return {
        kind,
        items: rows.map(r => ({ key: String(r.id), changedAt: r.changed_at, data: shape(kind, r) })),
        next: last ? `${last.changed_at}|${last.id}` : (after || ''),
        more: window.length === lim,
    };
}

module.exports = { buildFeedPage, parseCursor, excludedTags, MAX_LIMIT };
