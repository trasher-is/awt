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

// Turn a stats row into the model's side shape, or null when the race is not scouted.
// Uses the shared resolveStats so a stale intel row falls back to science_level exactly
// the way the incoming-alert and !battle callers do.
function ownSide(row) {
    if (!row || !row.has_intel) return null;
    const s = battleModel.resolveStats(row);
    if (!s || s.unknown) return null;
    return { ra: s.ra, rd: s.rd, phys: s.phys, math: s.math, lvl: s.lvl };
}

function pct(win) {
    return Math.round(win * 1000) / 10;   // one decimal, in percent
}

/**
 * truePower(row, ceilings) -> { tp, tpx }   (percent 0-100, one decimal; null without intel)
 *   row       { has_intel, race_attack, race_defense, physics, mathematics, level,
 *               science_level, intel_updated_at }
 *   ceilings  { max_level, max_physics, max_science_level } from playersRepo.getCombatCeilings
 */
function truePower(row, ceilings = {}) {
    const me = ownSide(row);
    if (!me) return { tp: null, tpx: null };

    const equal = { ra: 0, rd: 0, phys: me.phys, math: me.math, lvl: me.lvl };
    const tp = battleModel.winChance(REFERENCE_FLEET, me, REFERENCE_FLEET, equal);

    const maxPhys = ceilings.max_physics != null ? Number(ceilings.max_physics)
        : ceilings.max_science_level != null ? Number(ceilings.max_science_level)
        : me.phys;
    const maxLvl = ceilings.max_level != null ? Number(ceilings.max_level) : me.lvl;
    const toughest = { ra: TOUGHEST_RACE_ATTACK, rd: 0, phys: Math.max(maxPhys, 0), math: me.math, lvl: Math.max(maxLvl, 0) };
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
    }, ceilings);
}

module.exports = { REFERENCE_FLEET, TOUGHEST_RACE_ATTACK, truePower, truePowerForAllianceRow };
