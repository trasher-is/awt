// Battle-report ingest: map the game REST API's report objects into flat rows, upsert
// them idempotently, and format the Discord embed for freshly discovered ones.
//
// Field names below are confirmed against a real production response (2026-08-30, GET
// https://astrowars.games/api/v1/BattleReport/search) — an earlier version of this file
// guessed field names from the OpenAPI spec alone (never observed against production),
// which silently mapped every attacker/defender field to NULL in every stored row: the
// spec-derived names were `firstParty`/`secondParty` with `experienceGained`/
// `levelGained`; the real API uses `attacker`/`defender` with `experiencePointsGained`/
// `playerLevelGained`. mapApiReport is still deliberately forgiving — a report whose
// fields do not match simply maps them to NULL, and a report without a usable id is
// skipped — one bad row must never abort a sync batch.
//
// `attacker` is mapped to att_ (the side that initiated the battle) and `defender` to
// def_. `conqueredPlanet` is a plain boolean in the real response — mapped with bool01,
// not int. The planet itself (solarSystemId/planetIndex) only arrived with the game's
// BattleReport change; see mapApiDetail below.

// Coercion helpers: the API is typed by its spec, but the payload has travelled through
// a member's browser. Anything that is not the expected shape becomes NULL, not a throw.
function int(v) {
    if (Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
    return null;
}

function real(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

function bool01(v) {
    if (v === true || v === 1) return 1;
    if (v === false || v === 0) return 0;
    return null;
}

function text(v) {
    return v == null ? null : String(v);
}

/**
 * Map one API battle-report object to a flat battle_reports row.
 * Returns null when the object has no usable id — callers skip it and move on.
 */
function mapApiReport(api) {
    if (!api || typeof api !== 'object' || Array.isArray(api)) return null;

    const id = int(api.id);
    if (id == null || id <= 0) return null;

    const att = (api.attacker && typeof api.attacker === 'object') ? api.attacker : {};
    const def = (api.defender && typeof api.defender === 'object') ? api.defender : {};

    const side = (s, prefix) => ({
        [`${prefix}alliance_id`]: int(s.allianceId),
        [`${prefix}alliance_tag`]: text(s.allianceTag),
        [`${prefix}player_id`]: int(s.playerId),
        [`${prefix}player_name`]: text(s.playerName),
        [`${prefix}has_won`]: bool01(s.hasWon),
        [`${prefix}luckiness`]: real(s.luckiness),
        [`${prefix}combat_value`]: int(s.combatValue),
        [`${prefix}survived_cv`]: int(s.survivedCombatValue ?? s.survivedCv),
        [`${prefix}lost_cv`]: int(s.lostCombatValue ?? s.lostCv),
        [`${prefix}pct_cv_lost`]: real(s.percentageCombatValueLost ?? s.pctCvLost),
        [`${prefix}xp_gained`]: int(s.experiencePointsGained ?? s.experienceGained ?? s.xpGained),
        [`${prefix}level_gained`]: int(s.playerLevelGained ?? s.levelGained ?? s.levelsGained),
    });

    return {
        id,
        // The search endpoint orders by DateTime, so accept that name too.
        started_at: text(api.startedAt ?? api.dateTime),
        is_public: bool01(api.isPublic),
        winner: text(api.winner),
        conquered_planet: bool01(api.conqueredPlanet),
        killed_population: int(api.killedPopulation),
        random_number: real(api.randomNumber),
        ...side(att, 'att_'),
        ...side(def, 'def_'),
    };
}

/**
 * Insert mapped rows into battle_reports, one transaction, INSERT OR IGNORE — the game
 * report id is the primary key, so a report the hub already holds is skipped untouched
 * (its announced flag in particular survives a re-sync).
 * @returns {{inserted: object[], skipped: number}} rows that are genuinely new, and how
 *          many were already present (or lost a same-batch id race).
 */
function upsertReports(db, rows) {
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO battle_reports (
            id, started_at, is_public, winner, conquered_planet, killed_population, random_number,
            att_alliance_id, att_alliance_tag, att_player_id, att_player_name, att_has_won,
            att_luckiness, att_combat_value, att_survived_cv, att_lost_cv, att_pct_cv_lost,
            att_xp_gained, att_level_gained,
            def_alliance_id, def_alliance_tag, def_player_id, def_player_name, def_has_won,
            def_luckiness, def_combat_value, def_survived_cv, def_lost_cv, def_pct_cv_lost,
            def_xp_gained, def_level_gained
        ) VALUES (
            @id, @started_at, @is_public, @winner, @conquered_planet, @killed_population, @random_number,
            @att_alliance_id, @att_alliance_tag, @att_player_id, @att_player_name, @att_has_won,
            @att_luckiness, @att_combat_value, @att_survived_cv, @att_lost_cv, @att_pct_cv_lost,
            @att_xp_gained, @att_level_gained,
            @def_alliance_id, @def_alliance_tag, @def_player_id, @def_player_name, @def_has_won,
            @def_luckiness, @def_combat_value, @def_survived_cv, @def_lost_cv, @def_pct_cv_lost,
            @def_xp_gained, @def_level_gained
        )
    `);

    const inserted = [];
    let skipped = 0;
    db.transaction((batch) => {
        for (const row of batch) {
            if (stmt.run(row).changes > 0) inserted.push(row);
            else skipped++;
        }
    })(rows);

    return { inserted, skipped };
}

// One label for a side: "[TAG] Name", falling back through what is known. Player names
// and tags are player-controlled strings — the CALLER passes them through defuseMentions
// before this ever runs (see /sync/battle-reports).
function sideLabel(tag, name) {
    if (name && tag) return `[${tag}] ${name}`;
    if (name) return name;
    if (tag) return `[${tag}]`;
    return 'Unknown';
}

const num = v => (v == null ? '?' : v.toLocaleString('en-US'));

/**
 * Format one battle_reports row as a plain Discord embed object ({title, description,
 * color}) — discord.js-free, so it is testable without a client. Timestamps use the
 * <t:unix:R> markdown (never inside code blocks, which would print it literally).
 */
function formatBattleEmbed(row) {
    const attacker = sideLabel(row.att_alliance_tag, row.att_player_name);
    const defender = sideLabel(row.def_alliance_tag, row.def_player_name);

    const parsed = Date.parse(row.started_at);
    const when = Number.isFinite(parsed) ? `<t:${Math.floor(parsed / 1000)}:R>` : 'at an unknown time';

    let outcome;
    let color;
    if (row.att_has_won === 1) {
        outcome = `**${attacker}** won`;
        color = 0xed4245; // red — a planet changed hands or a defence broke
    } else if (row.def_has_won === 1) {
        outcome = `**${defender}** held`;
        color = 0x57f287; // green — the defence stood
    } else {
        outcome = row.winner ? `Winner: **${row.winner}**` : 'Outcome unknown';
        color = 0x99aab5; // grey — the report did not say
    }

    const lines = [
        `**${attacker}** attacked **${defender}** ${when}`,
        outcome,
        `CV ${num(row.att_combat_value)} vs ${num(row.def_combat_value)} — losses ${num(row.att_lost_cv)} / ${num(row.def_lost_cv)}`,
    ];
    if (row.conquered_planet === 1) lines.push('Planet conquered.');
    if (row.killed_population != null && row.killed_population > 0) lines.push(`Population killed: ${num(row.killed_population)}.`);

    return {
        title: `Battle report #${row.id}`,
        description: lines.join('\n'),
        color,
    };
}

// ─── Location + ship detail straight from the API ────────────────────────────
// The game's BattleReport change (test server 2026-09-25) added planetId/planetIndex/
// planetName/solarSystemId per report and shipTypeStats[]/starbaseStats per side — the
// same things the /About/BattleReport/{id} page fetch (battle-report-parser.js) exists to
// dig out. mapApiDetail turns them into the exact columns that parser fills, so the
// detail sweep can skip the page for reports the API already describes in full.
//
// The shipType strings have not been observed yet (the search endpoint needs a session),
// so they are matched loosely ("Colony Ship", "ColonyShip", "colony_ships" all work) and
// ONE unrecognised type makes `ships` null: the report then keeps its page fetch rather
// than being marked done with a hole in it. The page shows every ship row, 0 included,
// so a type the API leaves out is 0; the attacker's Starbase cells are blank on the page,
// so att_starbases stays null. win_chance is not produced — it is the dice roll the page
// prints (see battle-ledger.js), and random_number already stores the API's own value.
const API_SHIP_COLS = {
    destroyer: 'destroyers', cruiser: 'cruisers', battleship: 'battleships',
    transport: 'transports', colonyship: 'colony_ships',
};
const shipKey = t => (typeof t === 'string' ? t.toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '') : '');

function sideShips(side, prefix, out) {
    const stats = side && side.shipTypeStats;
    if (!Array.isArray(stats) || !stats.length) return false;
    for (const col of Object.values(API_SHIP_COLS)) {
        out[`${prefix}${col}`] = 0;
        out[`${prefix}${col}_lost`] = 0;
    }
    for (const st of stats) {
        const col = st && API_SHIP_COLS[shipKey(st.shipType)];
        if (!col) return false;
        const amount = int(st.amount), lost = int(st.lost);
        if (amount == null || lost == null) return false;
        out[`${prefix}${col}`] = amount;
        out[`${prefix}${col}_lost`] = lost;
    }
    return true;
}

/**
 * Location and per-ship-type detail from one API report, or null when it carries neither
 * (the live API before the change). `ships` is null unless both sides map completely.
 */
function mapApiDetail(api) {
    if (!api || typeof api !== 'object') return null;
    const systemId = int(api.solarSystemId);
    const planetIndex = int(api.planetIndex);
    const location = systemId != null && systemId > 0 && planetIndex != null && planetIndex > 0
        ? { system_id: systemId, planet_index: planetIndex } : null;

    let ships = {};
    const att = api.attacker && typeof api.attacker === 'object' ? api.attacker : null;
    const def = api.defender && typeof api.defender === 'object' ? api.defender : null;
    if (sideShips(att, 'att_', ships) && sideShips(def, 'def_', ships)) {
        ships.att_starbases = null;
        ships.att_starbases_lost = null;
        const sb = def.starbaseStats;
        ships.def_starbases = sb && typeof sb === 'object' ? int(sb.amount) : null;
        ships.def_starbases_lost = sb && typeof sb === 'object' ? int(sb.lost) : null;
    } else {
        ships = null;
    }

    if (!location && !ships) return null;
    return { location, ships };
}

module.exports = { mapApiReport, mapApiDetail, upsertReports, formatBattleEmbed };
