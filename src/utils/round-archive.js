// Keeping what a round knew, after the round is wiped.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// "Nuke data" in the admin panel deletes players, alliances, systems, planets, fleets and
// events so the next round starts clean. That is correct — the map reshuffles and last
// round's coordinates are worse than no coordinates.
//
// But it also deletes the one thing that carries across rounds: WHO SOMEBODY IS. A player
// id is stable for the life of an account, and people rename between rounds. Chewie played
// Beta 2-3 as Elfenlied, id 39 throughout. Once the wipe has run, nothing in the hub can
// tell you that, and the person reading the intel panel has to remember it or ask.
//
// So the wipe now takes a snapshot first. Only the parts that mean something a round later
// are kept:
//
//   • players: id, name, alliance tag, points, level, planet count
//   • systems: id, name, and the coordinates they had at the time
//
// Nothing else. Fleets, planet ownership and events describe a map that no longer exists;
// keeping them would be hoarding, and it would make the archive grow without bound.
//
// System coordinates are kept even though they are worthless next round — they are what
// makes the archive readable as a record of the round that ended, and they cost one row
// per system. System NAMES and ids do carry over (Rana is [0;0] every round), so a future
// round can be checked against them.
//
// ─── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
// It does not open a transaction of its own when the caller already has one, and it never
// deletes anything. Archiving and wiping are one atomic step in src/routes/admin.js: if
// the snapshot fails the wipe does not happen.

/**
 * Snapshot the current round into the archive. Does NOT delete anything.
 *
 * Pass the same `db` the caller is using so this can run inside the caller's transaction —
 * archiving and wiping must be all-or-nothing.
 *
 * @returns {{roundId: number, players: number, systems: number, label: string}}
 */
function archiveRound(db, { label = null, note = null, now = null } = {}) {
    const stamp = now || new Date().toISOString().slice(0, 10);
    const finalLabel = (label && String(label).trim()) || `Round archived ${stamp}`;

    const info = db.prepare(
        `INSERT INTO rounds (label, note) VALUES (?, ?)`
    ).run(finalLabel, note == null ? null : String(note).slice(0, 500));
    const roundId = info.lastInsertRowid;

    // Straight INSERT ... SELECT: one statement, no round trip per row, and it cannot
    // drift out of step with the tables it reads.
    const players = db.prepare(`
        INSERT INTO round_players (round_id, player_id, name, alliance_tag, points, level, planet_count)
        SELECT ?, p.id, p.name, a.tag, p.points, p.level,
               (SELECT COUNT(*) FROM planets WHERE owner_id = p.id)
        FROM players p
        LEFT JOIN alliances a ON a.id = p.alliance_id
    `).run(roundId).changes;

    const systems = db.prepare(`
        INSERT INTO round_systems (round_id, system_id, name, x, y)
        SELECT ?, s.id, s.name, s.x, s.y FROM systems s
    `).run(roundId).changes;

    db.prepare(`UPDATE rounds SET player_count = ?, system_count = ? WHERE id = ?`)
        .run(players, systems, roundId);

    return { roundId, players, systems, label: finalLabel };
}

/**
 * Every name a player id has been seen under in an earlier round, newest round first.
 *
 * `currentName` is compared case-insensitively and dropped: a player who has not renamed
 * should show no history at all rather than their own name repeated once per round.
 */
function previousNames(db, playerId, { currentName = null } = {}) {
    const id = Number(playerId);
    if (!Number.isInteger(id)) return [];

    const rows = db.prepare(`
        SELECT r.id AS roundId, r.label, r.archived_at AS archivedAt,
               rp.name, rp.alliance_tag AS allianceTag, rp.points, rp.level
        FROM round_players rp
        JOIN rounds r ON r.id = rp.round_id
        WHERE rp.player_id = ?
        ORDER BY r.id DESC
    `).all(id);

    const seen = new Set();
    const out = [];
    for (const row of rows) {
        const key = String(row.name || '').toLowerCase();
        if (!key) continue;
        if (currentName && key === String(currentName).toLowerCase()) continue;
        // The same old name across three rounds is one fact, not three. Keep the most
        // recent round it was used in, which is the one that reads usefully.
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

/**
 * Players whose ARCHIVED name matches a query — the "who used to be called this" lookup.
 *
 * Returns the current name alongside, when the id still exists, because the useful answer
 * to "who was Elfenlied" is "Chewie", not "player 39".
 */
function findByFormerName(db, query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    return db.prepare(`
        SELECT rp.player_id AS playerId,
               rp.name      AS formerName,
               r.label      AS roundLabel,
               r.id         AS roundId,
               p.name       AS currentName,
               a.tag        AS currentAllianceTag
        FROM round_players rp
        JOIN rounds r ON r.id = rp.round_id
        LEFT JOIN players p ON p.id = rp.player_id
        LEFT JOIN alliances a ON a.id = p.alliance_id
        WHERE rp.name LIKE ?
        GROUP BY rp.player_id, LOWER(rp.name)
        ORDER BY r.id DESC, LENGTH(rp.name) ASC
        LIMIT ?
    `).all(`%${q}%`, limit);
}

// Like findByFormerName, but only returns hits for a player who still currently exists
// (used by the player search box, where a hit with no live account to show is noise).
function searchFormerNamesWithCurrentPlayer(db, query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    return db.prepare(`
        SELECT rp.player_id AS id, p.name, a.tag AS alliance_tag,
               rp.name AS former_name, r.label AS former_round
        FROM round_players rp
        JOIN rounds r ON r.id = rp.round_id
        LEFT JOIN players p ON p.id = rp.player_id
        LEFT JOIN alliances a ON a.id = p.alliance_id
        WHERE rp.name LIKE ? AND p.id IS NOT NULL
        GROUP BY rp.player_id
        ORDER BY r.id DESC
        LIMIT ?
    `).all(`%${q}%`, limit);
}

/** The archive index for the admin panel. */
function listRounds(db) {
    return db.prepare(`
        SELECT id, label, note, archived_at AS archivedAt,
               player_count AS players, system_count AS systems
        FROM rounds ORDER BY id DESC
    `).all();
}

/** One archived round, for looking at what it held. */
function roundDetail(db, roundId, { limit = 500 } = {}) {
    const id = Number(roundId);
    if (!Number.isInteger(id)) return null;
    const round = db.prepare(`
        SELECT id, label, note, archived_at AS archivedAt,
               player_count AS players, system_count AS systems
        FROM rounds WHERE id = ?
    `).get(id);
    if (!round) return null;

    round.playerRows = db.prepare(`
        SELECT player_id AS playerId, name, alliance_tag AS allianceTag, points, level,
               planet_count AS planetCount
        FROM round_players WHERE round_id = ?
        ORDER BY points DESC LIMIT ?
    `).all(id, limit);
    return round;
}

module.exports = { archiveRound, previousNames, findByFormerName, listRounds, roundDetail, searchFormerNamesWithCurrentPlayer };
