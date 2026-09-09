// True Power (TP / TPx) — a member's combat rating from the battle model (issue #154).
//
// The battle calculator is now reverse-engineered from the live game (see
// public/js/utils/battle-model.js), close enough to rate players by it. Two numbers, both
// "chance to win 100 destroyers vs 100 destroyers":
//   TP  — against an enemy with the SAME sciences and player level but 0 race attack.
//         Isolates the member's own race-attack pick: 0 attack reads 50%, +4 reads more.
//   TPx — against the toughest enemy the hub knows of: +4 race attack, the highest player
//         level and the highest physics recorded in the database. The member keeps their own
//         physics/maths/level.
//
// Player level: the model only applies it when a side fields all three ship types
// (destroyers AND cruisers AND battleships), so in a pure-destroyer duel the "highest PL"
// input is neutral. It is still passed through — the definition asks for it, and if the
// reference fleet ever becomes a mix, the term switches on without another change here.
//
// No intel on the player (race unknown) -> null, never an assumed value dressed up as a
// rating: the table shows "?" like every other deep-scan column.
//
// Node-only (the alliance-stats route computes it server-side); the model itself is the
// shared dual-runtime file.

const battleModel = require('../../public/js/utils/battle-model.js');

const REFERENCE_FLEET = [100, 0, 0];   // 100 destroyers, nothing else
const TOUGHEST_RACE_ATTACK = 4;

// TPx rates observed physics, never the public science ceiling used as an enemy-risk
// estimate by other battle-model callers. Aging an observation must not improve a
// member's rating while the reference enemy keeps its recorded physics (#161).
function scienceValue(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function observationTime(value) {
    if (typeof value !== 'string') return null;
    // SQLite timestamps are UTC despite having no zone; ISO timestamps retain theirs.
    const sqlite = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
    const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    if (!sqlite && !zoned) return null;
    const ms = Date.parse(sqlite ? value.replace(' ', 'T') + 'Z' : value);
    return Number.isFinite(ms) ? ms : null;
}

// Shared by member rating and the database-wide reference. The dedicated sheet stamp
// is written only alongside sciences: updated_at can instead mean an AU-only refresh.
// A legacy sheet with no science stamp cannot displace a recorded intel observation.
function observedCombatSciences(row) {
    const intelTime = observationTime(row.intel_updated_at);
    const sheetTime = observationTime(row.sheet_sciences_updated_at);
    const observed = field => {
        const intel = row.has_intel ? scienceValue(row[field]) : null;
        const sheet = scienceValue(row[`sheet_${field}`]);
        if (sheet != null && sheetTime != null && (intel == null || intelTime == null || sheetTime > intelTime)) return sheet;
        return intel;
    };
    return { physics: observed('physics'), mathematics: observed('mathematics') };
}

// Turn a stats row into the model's side shape, or null without observed race/physics.
function ownSide(row) {
    if (!row || !row.has_intel) return null;
    const sciences = observedCombatSciences(row);
    if (sciences.physics == null) return null;
    return { ra: row.race_attack || 0, rd: row.race_defense || 0,
        phys: sciences.physics, math: sciences.mathematics || 0, lvl: row.level || 0 };
}

function pct(win) {
    return Math.round(win * 1000) / 10;   // one decimal, in percent
}

/**
 * truePower(row, ceilings) -> { tp, tpx }   (percent 0-100, one decimal; null without intel)
 *   row       { has_intel, race_attack, race_defense, physics, mathematics, level,
 *               intel_updated_at, sheet_physics, sheet_mathematics, sheet_sciences_updated_at }
 *   ceilings  { max_level, max_physics } from playersRepo.getCombatCeilings
 */
function truePower(row, ceilings = {}) {
    const me = ownSide(row);
    if (!me) return { tp: null, tpx: null };

    const equal = { ra: 0, rd: 0, phys: me.phys, math: me.math, lvl: me.lvl };
    const tp = battleModel.winChance(REFERENCE_FLEET, me, REFERENCE_FLEET, equal);

    const maxPhys = scienceValue(ceilings.max_physics) ?? me.phys;
    const maxLvl = ceilings.max_level != null ? Number(ceilings.max_level) : me.lvl;
    const toughest = { ra: TOUGHEST_RACE_ATTACK, rd: 0, phys: Math.max(maxPhys, me.phys), math: me.math, lvl: Math.max(maxLvl, 0) };
    const tpx = battleModel.winChance(REFERENCE_FLEET, me, REFERENCE_FLEET, toughest);

    return { tp: pct(tp), tpx: pct(tpx) };
}

// The alliance-stats rows alias every players column with a pl_ prefix; map them back.
function truePowerForAllianceRow(r, ceilings) {
    return truePower({
        has_intel: r.pl_has_intel,
        race_attack: r.pl_race_attack,
        race_defense: r.pl_race_defense,
        physics: r.pl_physics,
        mathematics: r.pl_mathematics,
        level: r.pl_level,
        science_level: r.pl_science_level,
        intel_updated_at: r.pl_intel_updated_at,
        sheet_physics: r.physics,
        sheet_mathematics: r.mathematics,
        sheet_sciences_updated_at: r.sciences_updated_at,
    }, ceilings);
}

module.exports = { REFERENCE_FLEET, TOUGHEST_RACE_ATTACK, observedCombatSciences, truePower, truePowerForAllianceRow };
