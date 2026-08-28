// Battle-report ingest: map the game REST API's report objects into flat rows, upsert
// them idempotently, and format the Discord embed for freshly discovered ones.
//
// Every field name read from the API object below is SPEC-DERIVED (OpenAPI 3.0.1 at
// /swagger/v1/swagger.json) — no /api/v1 response has ever been observed against
// production. That is why mapApiReport is deliberately forgiving: a report whose fields
// do not match simply maps them to NULL, and a report without a usable id is skipped —
// one bad row must never abort a sync batch.
//
// firstParty is mapped to att_ (the side that initiated the battle) and secondParty to
// def_, matching the search parameters the API exposes (FirstParty.AllianceId /
// SecondParty.AllianceId).

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

    const att = (api.firstParty && typeof api.firstParty === 'object') ? api.firstParty : {};
    const def = (api.secondParty && typeof api.secondParty === 'object') ? api.secondParty : {};

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
        [`${prefix}xp_gained`]: int(s.experienceGained ?? s.xpGained),
        [`${prefix}level_gained`]: int(s.levelGained ?? s.levelsGained),
    });

    return {
        id,
        // The search endpoint orders by DateTime, so accept that name too.
        started_at: text(api.startedAt ?? api.dateTime),
        is_public: bool01(api.isPublic),
        winner: text(api.winner),
        conquered_planet: int(api.conqueredPlanet),
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
    if (row.conquered_planet != null) lines.push(`Planet conquered (game planet id ${row.conquered_planet}).`);
    if (row.killed_population != null && row.killed_population > 0) lines.push(`Population killed: ${num(row.killed_population)}.`);

    return {
        title: `Battle report #${row.id}`,
        description: lines.join('\n'),
        color,
    };
}

module.exports = { mapApiReport, upsertReports, formatBattleEmbed };
