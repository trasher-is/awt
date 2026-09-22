const db = require('../database');

const deleteAllBattleReportsStmt = db.prepare(`DELETE FROM battle_reports`);
function deleteAllBattleReports() {
    return deleteAllBattleReportsStmt.run().changes;
}

const getPendingAnnouncementsStmt = db.prepare(
    `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`
);
function getPendingAnnouncements() {
    return getPendingAnnouncementsStmt.all();
}

const markAnnouncedStmt = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
function markAnnounced(id) {
    markAnnouncedStmt.run(id);
}

const getNewestStartedAtStmt = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`);
function getNewestStartedAt() {
    return getNewestStartedAtStmt.get().newest || null;
}

const getReportsNeedingShipDetailStmt = db.prepare(`
    SELECT id FROM battle_reports
    WHERE ship_detail_scraped_at IS NULL
    ORDER BY started_at DESC
    LIMIT ?
`);
function getReportsNeedingShipDetail(limit) {
    return getReportsNeedingShipDetailStmt.all(limit).map(r => r.id);
}

// Arity varies per call (ids length) — prepared fresh each call, same reasoning as
// systems.js's getSystemsByIds / players.js's markPlayersApiScanned.
function markShipDetailScraped(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE battle_reports SET ship_detail_scraped_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
}

// One-time legacy backfill: a report already marked ship_detail_scraped_at but with no
// system_id — either scraped before planet capture shipped, or by a stale browser tab
// still running the old scraper module (an already-open dashboard tab keeps running
// whatever JS it loaded at page-open time; it does not hot-reload on a server deploy).
// location_backfill_attempted_at guards against retrying this forever for a report whose
// page genuinely has no planet link (if any such report exists) — one attempt, then done,
// success or not.
const getReportsNeedingLocationBackfillStmt = db.prepare(`
    SELECT id FROM battle_reports
    WHERE ship_detail_scraped_at IS NOT NULL AND system_id IS NULL AND location_backfill_attempted_at IS NULL
    ORDER BY started_at DESC
    LIMIT ?
`);
function getReportsNeedingLocationBackfill(limit) {
    return getReportsNeedingLocationBackfillStmt.all(limit).map(r => r.id);
}

function markLocationBackfillAttempted(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE battle_reports SET location_backfill_attempted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
}

const updateShipDetailStmt = db.prepare(`
    UPDATE battle_reports SET
        att_destroyers=@att_destroyers, att_destroyers_lost=@att_destroyers_lost,
        att_cruisers=@att_cruisers, att_cruisers_lost=@att_cruisers_lost,
        att_battleships=@att_battleships, att_battleships_lost=@att_battleships_lost,
        att_transports=@att_transports, att_transports_lost=@att_transports_lost,
        att_colony_ships=@att_colony_ships, att_colony_ships_lost=@att_colony_ships_lost,
        att_starbases=@att_starbases, att_starbases_lost=@att_starbases_lost,
        def_destroyers=@def_destroyers, def_destroyers_lost=@def_destroyers_lost,
        def_cruisers=@def_cruisers, def_cruisers_lost=@def_cruisers_lost,
        def_battleships=@def_battleships, def_battleships_lost=@def_battleships_lost,
        def_transports=@def_transports, def_transports_lost=@def_transports_lost,
        def_colony_ships=@def_colony_ships, def_colony_ships_lost=@def_colony_ships_lost,
        def_starbases=@def_starbases, def_starbases_lost=@def_starbases_lost,
        win_chance=@win_chance,
        system_id=@system_id, planet_index=@planet_index,
        ship_detail_scraped_at=CURRENT_TIMESTAMP
    WHERE id=@id
`);
function updateShipDetail(id, detail) {
    updateShipDetailStmt.run({ id, ...detail });
}

// "Last seen" for a player: the most recent events of ANY kind that name them, on either
// side (attacker/defender in battle_reports; either party in news_events — see
// news-battle-matching.js's other_player_id/player_id convention), newest first. Two
// different sources with two different location shapes: battle_reports gives (system_id,
// planet_index) — the planets table's own primary key, from the report page header (no
// game_planet_id available there at all); news_events gives (system_id, game_planet_id)
// from the News-page row's own links, plus credited_player_id/population_delta for
// bombardment rows. Both are returned as-is; the caller resolves display text (see
// discord_bot.js's !lastseen), since resolving a human-readable planet name needs the
// systems/planets tables this repository doesn't own.
const recentPlanetsBattleReportsStmt = db.prepare(`
    SELECT started_at AS occurred_at, system_id, planet_index, NULL AS game_planet_id,
           id AS source_id, 'battle_report' AS source, NULL AS credited_player_id, NULL AS population_delta,
           NULL AS message_type,
           att_player_id, def_player_id, att_survived_cv, def_survived_cv,
           att_destroyers, att_destroyers_lost, def_destroyers, def_destroyers_lost,
           att_cruisers, att_cruisers_lost, def_cruisers, def_cruisers_lost,
           att_battleships, att_battleships_lost, def_battleships, def_battleships_lost,
           att_transports, att_transports_lost, def_transports, def_transports_lost,
           att_colony_ships, att_colony_ships_lost, def_colony_ships, def_colony_ships_lost,
           att_starbases, att_starbases_lost, def_starbases, def_starbases_lost
    FROM battle_reports
    WHERE (att_player_id = ? OR def_player_id = ?) AND system_id IS NOT NULL
    ORDER BY started_at DESC LIMIT ?
`);
const recentPlanetsNewsEventsStmt = db.prepare(`
    SELECT occurred_at, system_id, NULL AS planet_index, game_planet_id,
           id AS source_id, 'news_event' AS source, credited_player_id, population_delta, message_type
    FROM news_events
    WHERE (player_id = ? OR other_player_id = ?) AND system_id IS NOT NULL
    ORDER BY occurred_at DESC LIMIT ?
`);

const REMAINING_SHIP_TYPES = [
    { label: 'Destroyers', col: 'destroyers' },
    { label: 'Cruisers', col: 'cruisers' },
    { label: 'Battleships', col: 'battleships' },
    { label: 'Transports', col: 'transports' },
    { label: 'Colony Ships', col: 'colony_ships' },
    { label: 'Starbases', col: 'starbases' },
];

// Ship counts/CV in battle_reports are only ever populated together, by the ship-detail
// scraper (see battle-report-parser.js) — att_destroyers being null means that report's
// detail was never scraped, not that the fleet had zero destroyers. Computed here rather
// than in SQL (a 12-branch CASE-per-column wall is much harder to read/verify than this).
function computeRemainingFleet(row, playerId) {
    const prefix = row.att_player_id === playerId ? 'att_' : row.def_player_id === playerId ? 'def_' : null;
    if (!prefix) return null;
    const cv = row[`${prefix}survived_cv`];
    if (cv == null) return null; // ship detail never scraped for this report

    const byType = [];
    for (const t of REMAINING_SHIP_TYPES) {
        const count = row[`${prefix}${t.col}`];
        const lost = row[`${prefix}${t.col}_lost`];
        if (count == null || count <= 0) continue; // never had this ship type in the fight
        byType.push({ label: t.label, remaining: lost == null ? null : count - lost });
    }
    return { cv, byType };
}

// Best-known transports/colony-ships for a player, learned from their most recent
// ship-detail-scraped battle report on either side (war-tool groundwork, 2026-09-20): the
// StrongestFleet ranking only ever shows Destroyer/Cruiser/Battleship (transports and
// colony ships carry 0 combat value, per game-rules.md's Transports/Colony ships section,
// so a CV-based ranking has no reason to list them), so a battle report is the only place
// either count is ever observed. What comes back is what that player COMMITTED to that one
// fight, not their current whole fleet — a lower bound, not a live total — which is why
// it's returned with the report's own started_at rather than folded silently into
// strongest_fleet's fresher destroyer/cruiser/battleship numbers.
const getLatestShipCompositionExtraStmt = db.prepare(`
    SELECT
        CASE WHEN att_player_id = @playerId THEN att_transports ELSE def_transports END AS transports,
        CASE WHEN att_player_id = @playerId THEN att_colony_ships ELSE def_colony_ships END AS colony_ships,
        id AS source_id, started_at
    FROM battle_reports
    WHERE (att_player_id = @playerId OR def_player_id = @playerId)
      AND (CASE WHEN att_player_id = @playerId THEN att_destroyers ELSE def_destroyers END) IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 1
`);
function getLatestShipCompositionExtra(playerId) {
    return getLatestShipCompositionExtraStmt.get({ playerId }) || null;
}

function getRecentPlanets(playerId, limit = 5) {
    const candidates = [
        ...recentPlanetsBattleReportsStmt.all(playerId, playerId, limit).map(row => ({
            occurred_at: row.occurred_at, system_id: row.system_id, planet_index: row.planet_index,
            game_planet_id: row.game_planet_id, source_id: row.source_id, source: row.source,
            credited_player_id: row.credited_player_id, population_delta: row.population_delta,
            message_type: row.message_type, remaining_fleet: computeRemainingFleet(row, playerId),
        })),
        ...recentPlanetsNewsEventsStmt.all(playerId, playerId, limit).map(row => ({ ...row, remaining_fleet: null })),
    ];
    candidates.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
    return candidates.slice(0, limit);
}

// Distinguishes "never in a recorded battle at all" from "has battles, but none with a
// resolved location yet" (e.g. the ship-detail scrape sweep hasn't reached that report) —
// getRecentPlanets alone can't tell those apart since it only ever returns located rows.
const hasHistoryBattleReportsStmt = db.prepare(`SELECT 1 FROM battle_reports WHERE att_player_id = ? OR def_player_id = ? LIMIT 1`);
const hasHistoryNewsEventsStmt = db.prepare(`SELECT 1 FROM news_events WHERE player_id = ? OR other_player_id = ? LIMIT 1`);
function hasAnyBattleHistory(playerId) {
    return !!(hasHistoryBattleReportsStmt.get(playerId, playerId) || hasHistoryNewsEventsStmt.get(playerId, playerId));
}

const findByPlayerPairNearStmt = db.prepare(`
    SELECT id FROM battle_reports
    WHERE ((att_player_id = @a AND def_player_id = @b) OR (att_player_id = @b AND def_player_id = @a))
      AND started_at BETWEEN @from AND @to
    LIMIT 1
`);

// News-page events carry no planet reference (battle_reports has no planet/system column
// at all) — matching is by player pair + time proximity instead. Direction doesn't matter:
// either player could be attacker or defender in the stored report.
function findByPlayerPairNear(playerA, playerB, occurredAtIso, windowMinutes) {
    const center = new Date(occurredAtIso).getTime();
    const from = new Date(center - windowMinutes * 60000).toISOString();
    const to = new Date(center + windowMinutes * 60000).toISOString();
    const row = findByPlayerPairNearStmt.get({ a: playerA, b: playerB, from, to });
    return row ? row.id : null;
}

// A population drop may span several battles. Name an attacker only when every
// plausible report identifies that same player and confirms population kills against
// the observed owner. Zero-kill/failed combat cannot explain a loss; missing kill counts
// or identities remain possible competing evidence, so they prevent attribution.
// The interval starts strictly after the previous sync (same-second ordering is unknown)
// and ends now, with an absolute three-hour cap. julianday normalizes API ISO offsets
// and the planet row's SQLite UTC timestamp without accepting future reports.
const findRecentAttackerAtPlanetStmt = db.prepare(`
    SELECT id, att_player_id, att_player_name, att_alliance_tag, def_player_id,
           killed_population, started_at
    FROM battle_reports
    WHERE system_id = @systemId AND planet_index = @planetIndex
      AND (def_player_id = @defenderId OR def_player_id IS NULL)
      AND datetime(started_at) > datetime(@observedAfter)
      AND julianday(started_at) >= julianday('now', '-' || @windowMinutes || ' minutes')
      AND julianday(started_at) <= julianday('now')
      AND (killed_population IS NULL OR killed_population > 0)
      AND (winner IS NULL OR lower(winner) != 'defender')
      AND (att_has_won IS NULL OR att_has_won != 0)
      AND (def_has_won IS NULL OR def_has_won != 1)
    ORDER BY julianday(started_at) DESC, id DESC
`);
function findRecentAttackerAtPlanet(systemId, planetIndex, windowMinutes, { defenderId, observedAfter, observedLoss } = {}) {
    // An Unknown owner or missing previous timestamp gives no reliable victim/interval.
    if (!Number.isInteger(defenderId) || defenderId <= 0
        || typeof observedAfter !== 'string' || !observedAfter.trim()
        || !Number.isFinite(observedLoss) || observedLoss <= 0) return null;
    const reports = findRecentAttackerAtPlanetStmt.all({
        systemId, planetIndex, defenderId, observedAfter,
        windowMinutes: Math.min(180, Math.max(1, Math.round(Number(windowMinutes) || 0))),
    });
    if (!reports.length) return null;
    const attackerId = reports[0].att_player_id;
    if (!Number.isInteger(attackerId) || attackerId <= 0) return null;
    if (reports.some(report => report.def_player_id !== defenderId
        || !(report.killed_population > 0)
        || report.att_player_id !== attackerId
        || !report.att_player_name || !report.att_player_name.trim())) return null;
    // More observed deaths than the reports account for leave another cause/attacker
    // unresolved. The converse is valid: growth between scans can mask some kills.
    const confirmedKills = reports.reduce((total, report) => total + report.killed_population, 0);
    if (confirmedKills < observedLoss) return null;
    return reports[0];
}

// A plain recency lookup for the fleet-launch target dossier — "has anyone fought here
// lately", not the strict same-attacker/same-defender/kill-count reconciliation
// findRecentAttackerAtPlanet needs for population-drop attribution. Exact planet first
// (most relevant to "should I launch here"), then the wider system as context — a fight
// two planets over in the same system still says something about how contested it is.
const getRecentBattlesAtPlanetStmt = db.prepare(`
    SELECT id, started_at, winner, conquered_planet, killed_population, planet_index,
           att_player_name, att_alliance_tag, def_player_name, def_alliance_tag
    FROM battle_reports
    WHERE system_id = @systemId
      AND julianday('now') - julianday(started_at) <= @sinceDays
    ORDER BY (planet_index = @planetIndex) DESC, julianday(started_at) DESC
    LIMIT @limit
`);
function getRecentBattlesAtPlanet(systemId, planetIndex, { sinceDays = 1, limit = 5 } = {}) {
    if (!Number.isInteger(systemId) || systemId <= 0) return [];
    return getRecentBattlesAtPlanetStmt.all({
        systemId, planetIndex: Number.isInteger(planetIndex) ? planetIndex : -1,
        sinceDays: Math.min(30, Math.max(0.1, Number(sinceDays) || 1)),
        limit: Math.min(20, Math.max(1, Math.round(Number(limit) || 5))),
    });
}

// --- Battle Reports page: a unified, alliance-wide "what happened" feed ---
// Two very different signal sources merged into one chronological list:
//   1. battle_reports rows — a real combat encounter the game reported. Always "linked":
//      the row IS the report, so battle_report_id is just its own id.
//   2. planet_events POP_DROP rows (id 2) with NO matching battle_reports row nearby —
//      population fell but no combat report exists for it (a bombardment outside a full
//      encounter, or one the hub hasn't synced/matched yet). Shown unlinked.
// A POP_DROP row that DOES have a matching battle_reports row is dropped from the feed
// entirely rather than shown a second time — the battle_reports row for that same
// system/planet/time already covers it, with richer detail.
//
// The match window is wide (3h) on purpose: planet_events.timestamp is when the hub's own
// scan happened to observe the drop, not the true in-game event time (unlike a battle
// report's own started_at, which IS the real time) — see systems.js's logPlanetEvent.
const POP_DROP_MATCH_WINDOW_MINUTES = 180;

// datetime(br.started_at): started_at is stored verbatim from the game API (raw ISO8601,
// "...T...+02:00") while planet_events.timestamp (the other half of this merged feed, see
// unmatchedPopDropsStmt below) is SQLite's own space-separated CURRENT_TIMESTAMP format.
// Left un-normalized, occurred_at would carry two different string shapes depending on
// which row produced it — breaking both the frontend's date parser (sqlite-time.js assumes
// the space-separated shape) and the merged array's chronological sort in JS below, which
// compares occurred_at as a plain string (same failure class as the BETWEEN bug just below,
// caught by getBattleReportsFeed's own regression test the first time — see its comment).
const battleReportsFeedStmt = db.prepare(`
    SELECT br.id AS battle_report_id, datetime(br.started_at) AS occurred_at,
           br.system_id, br.planet_index, s.name AS system_name,
           br.att_player_name, br.att_alliance_tag,
           br.def_player_name, br.def_alliance_tag,
           br.killed_population, br.winner
    FROM battle_reports br
    LEFT JOIN systems s ON s.id = br.system_id
    WHERE br.system_id IS NOT NULL
    ORDER BY br.started_at DESC
    LIMIT ?
`);

const unmatchedPopDropsStmt = db.prepare(`
    SELECT pe.timestamp AS occurred_at, pe.system_id, pe.planet_index, s.name AS system_name,
           pe.old_value AS old_population, pe.new_value AS new_population,
           p.name AS owner_name
    FROM planet_events pe
    LEFT JOIN systems s ON s.id = pe.system_id
    LEFT JOIN planets pl ON pl.system_id = pe.system_id AND pl.planet_index = pe.planet_index
    LEFT JOIN players p ON p.id = pl.owner_id
    WHERE pe.event_type_id = 2
      AND NOT EXISTS (
          SELECT 1 FROM battle_reports br
          WHERE br.system_id = pe.system_id AND br.planet_index = pe.planet_index
            -- started_at is stored verbatim from the game API (ISO8601, "...T...Z") while
            -- datetime()'s own output is always space-separated ("YYYY-MM-DD HH:MM:SS") —
            -- comparing the raw column against a bare datetime() result is a string
            -- comparison across two different formats and silently never matches (T > ' '
            -- lexicographically, so started_at always sorted "after" the upper bound
            -- regardless of the real time). Wrapping started_at in datetime() too
            -- normalizes both sides to the same canonical form before comparing.
            AND datetime(br.started_at) BETWEEN datetime(pe.timestamp, '-' || @window || ' minutes')
                                             AND datetime(pe.timestamp, '+' || @window || ' minutes')
      )
    ORDER BY pe.timestamp DESC
    LIMIT @limit
`);

function getBattleReportsFeed(limit = 50) {
    const battles = battleReportsFeedStmt.all(limit).map(row => ({
        occurred_at: row.occurred_at,
        battle_report_id: row.battle_report_id,
        system_id: row.system_id, planet_index: row.planet_index, system_name: row.system_name,
        attacker_name: row.att_player_name, attacker_alliance_tag: row.att_alliance_tag,
        defender_name: row.def_player_name, defender_alliance_tag: row.def_alliance_tag,
        killed_population: row.killed_population, winner: row.winner,
        old_population: null, new_population: null,
    }));
    const drops = unmatchedPopDropsStmt.all({ window: POP_DROP_MATCH_WINDOW_MINUTES, limit }).map(row => ({
        occurred_at: row.occurred_at,
        battle_report_id: null,
        system_id: row.system_id, planet_index: row.planet_index, system_name: row.system_name,
        attacker_name: null, attacker_alliance_tag: null,
        defender_name: row.owner_name, defender_alliance_tag: null,
        killed_population: (row.old_population != null && row.new_population != null)
            ? row.old_population - row.new_population : null,
        winner: null,
        old_population: row.old_population, new_population: row.new_population,
    }));
    const merged = [...battles, ...drops];
    merged.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
    return merged.slice(0, limit);
}

// Search + sort variant of the feed above, for the Battle Reports panel's search box and
// sortable columns. Both underlying queries gain the same `q` LIKE filter (attacker/
// defender name+tag, or the affected owner's name for a bare pop-drop row, plus system
// name either way); with q='%' every row matches, so an empty search box reproduces the
// plain feed exactly. total_cv_lost is a real battle's att_lost_cv+def_lost_cv (COALESCEd
// to 0 so a NULL lost_cv doesn't poison the sum) — the "how big was this battle" figure
// the CV sort uses. A bare population-drop row has no CV at all (there was no report), so
// it always sorts last regardless of direction — same treatment as a null population on a
// pop sort.
//
// Search and export share the complete matching set before sorting/pagination. A source
// cap could silently omit older matches and make a "filtered" export incomplete.
const battleReportColumns = db.prepare('PRAGMA table_info(battle_reports)').all().map(column => column.name);

const battleReportsSearchSelect = `
    SELECT br.*, br.id AS battle_report_id, datetime(br.started_at) AS occurred_at,
           s.name AS system_name,
           (COALESCE(br.att_lost_cv, 0) + COALESCE(br.def_lost_cv, 0)) AS total_cv_lost
    FROM battle_reports br
    LEFT JOIN systems s ON s.id = br.system_id
`;
const battleReportsSearchStmt = db.prepare(`${battleReportsSearchSelect}
    WHERE br.system_id IS NOT NULL
      AND (
          @q = '%' OR br.att_player_name LIKE @q OR br.def_player_name LIKE @q
          OR br.att_alliance_tag LIKE @q OR br.def_alliance_tag LIKE @q
          OR s.name LIKE @q
      )
    ORDER BY datetime(br.started_at) DESC, br.id DESC
`);
const allBattleReportsExportStmt = db.prepare(`${battleReportsSearchSelect}
    ORDER BY datetime(br.started_at) DESC, br.id DESC
`);

const unmatchedPopDropsSearchStmt = db.prepare(`
    SELECT pe.timestamp AS occurred_at, pe.system_id, pe.planet_index, s.name AS system_name,
           pe.old_value AS old_population, pe.new_value AS new_population,
           p.name AS owner_name
    FROM planet_events pe
    LEFT JOIN systems s ON s.id = pe.system_id
    LEFT JOIN planets pl ON pl.system_id = pe.system_id AND pl.planet_index = pe.planet_index
    LEFT JOIN players p ON p.id = pl.owner_id
    WHERE pe.event_type_id = 2
      AND (p.name LIKE @q OR s.name LIKE @q)
      AND NOT EXISTS (
          SELECT 1 FROM battle_reports br
          WHERE br.system_id = pe.system_id AND br.planet_index = pe.planet_index
            AND datetime(br.started_at) BETWEEN datetime(pe.timestamp, '-' || @window || ' minutes')
                                             AND datetime(pe.timestamp, '+' || @window || ' minutes')
      )
    ORDER BY pe.timestamp DESC
    LIMIT @limit
`);

const SORT_KEYS = {
    occurred_at: 'occurred_at', cv: 'total_cv_lost', pop: 'killed_population',
    // "Largest fleet" sorts — a side's own committed CV, not what it lost. Lets a member
    // find the biggest attacking/defending fleets in the round regardless of outcome.
    att_cv: 'attacker_combat_value', def_cv: 'defender_combat_value',
};

function battleReportFeedRow(row, includeDetails = false) {
    return {
        ...(includeDetails ? {
            record_type: 'battle_report',
            ...Object.fromEntries(battleReportColumns.map(column => [column, row[column]])),
        } : {}),
        occurred_at: row.occurred_at,
        battle_report_id: row.battle_report_id,
        system_id: row.system_id, planet_index: row.planet_index, system_name: row.system_name,
        attacker_name: row.att_player_name, attacker_alliance_tag: row.att_alliance_tag,
        attacker_combat_value: row.att_combat_value, attacker_survived_cv: row.att_survived_cv,
        defender_name: row.def_player_name, defender_alliance_tag: row.def_alliance_tag,
        defender_combat_value: row.def_combat_value, defender_survived_cv: row.def_survived_cv,
        // Same precedence formatBattleEmbed uses: att_has_won/def_has_won are the real
        // signal when the API sent one; `winner` (a free-text name) is a fallback for a
        // report that never resolved a boolean side, and isn't itself trustworthy enough
        // to bold a specific column — a battle with neither is genuinely undecided.
        winner_side: row.att_has_won === 1 ? 'att' : row.def_has_won === 1 ? 'def' : null,
        killed_population: row.killed_population, winner: row.winner,
        total_cv_lost: row.total_cv_lost,
        old_population: null, new_population: null,
    };
}

function searchBattleReportsFeed({ q = '', sort = 'occurred_at', dir = 'desc', limit = 50, offset = 0, includeDetails = false } = {}) {
    const trimmed = (q || '').trim();
    const likeTerm = trimmed ? `%${trimmed}%` : '%';

    const battles = battleReportsSearchStmt.all({ q: likeTerm }).map(row => battleReportFeedRow(row, includeDetails));

    // A bare population-drop row has no attacker/defender name of its own to match
    // against — skip the query entirely (same shape as the plain feed's unfiltered pull)
    // when there's nothing to search for, since @q would just be the neutral '%' anyway.
    const dropRows = (trimmed ? unmatchedPopDropsSearchStmt : unmatchedPopDropsStmt)
        .all({ q: likeTerm, window: POP_DROP_MATCH_WINDOW_MINUTES, limit: -1 })
        .map(row => ({
            ...(includeDetails ? {
                record_type: 'population_drop',
                ...Object.fromEntries(battleReportColumns.map(column => [column, null])),
            } : {}),
            occurred_at: row.occurred_at,
            battle_report_id: null,
            system_id: row.system_id, planet_index: row.planet_index, system_name: row.system_name,
            attacker_name: null, attacker_alliance_tag: null,
            attacker_combat_value: null, attacker_survived_cv: null,
            defender_name: row.owner_name, defender_alliance_tag: null,
            defender_combat_value: null, defender_survived_cv: null,
            winner_side: null,
            killed_population: (row.old_population != null && row.new_population != null)
                ? row.old_population - row.new_population : null,
            winner: null,
            total_cv_lost: 0,
            old_population: row.old_population, new_population: row.new_population,
        }));

    const merged = sortBattleReportRows([...battles, ...dropRows], sort, dir);
    return { total: merged.length, rows: merged.slice(offset, offset + limit) };
}

function sortBattleReportRows(rows, sort, dir) {
    const key = SORT_KEYS[sort] || 'occurred_at';
    const direction = dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return -1 * direction;
        if (av > bv) return 1 * direction;
        return 0;
    });
}

function getBattleReportsExport({ scope = 'all', q = '', sort = 'occurred_at', dir = 'desc' } = {}) {
    const rows = scope === 'filtered'
        ? searchBattleReportsFeed({ q, sort, dir, limit: Infinity, includeDetails: true }).rows
        : sortBattleReportRows(allBattleReportsExportStmt.all().map(row => battleReportFeedRow(row, true)), sort, dir);
    // Derive stored columns from SQLite so a later additive migration cannot disappear
    // from exports. Include headers even when there are no matching records.
    const columns = [...new Set(['record_type', ...battleReportColumns,
        ...Object.keys(battleReportFeedRow({}, false))])];
    return { columns, rows };
}

// --- THE COST LEDGER (src/utils/battle-ledger.js) ---
// Every recorded battle reduced to the columns that answer "what did an attack at this
// strength ratio actually cost". Whole-archive on purpose: it is ~1k rows for a round, and
// a window would quietly change the answer as the round aged without anyone asking it to.
const getBattleLedgerRowsStmt = db.prepare(`
    SELECT att_combat_value, def_combat_value, att_has_won,
           att_pct_cv_lost, def_pct_cv_lost, att_lost_cv, def_lost_cv,
           win_chance, random_number, started_at
    FROM battle_reports
`);
function getBattleLedgerRows() {
    return getBattleLedgerRowsStmt.all();
}

module.exports = {
    deleteAllBattleReports,
    getPendingAnnouncements,
    markAnnounced,
    getNewestStartedAt,
    getReportsNeedingShipDetail,
    markShipDetailScraped,
    getReportsNeedingLocationBackfill,
    markLocationBackfillAttempted,
    updateShipDetail,
    findByPlayerPairNear,
    findRecentAttackerAtPlanet,
    getRecentBattlesAtPlanet,
    getRecentPlanets,
    getLatestShipCompositionExtra,
    hasAnyBattleHistory,
    getBattleReportsFeed,
    searchBattleReportsFeed,
    getBattleReportsExport,
    getBattleLedgerRows,
};
