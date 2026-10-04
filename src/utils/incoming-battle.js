// What an incoming attack actually runs into, in the order the game resolves it (2026-10-04).
//
// The alerts used to put each defender alone against the attacker, with no starbase. That
// is not the fight. An attack on a planet fights the planet first: its starbase together
// with the owner's own fleet sitting on it, as one defending side. An ALLY who lands on
// the planet before the attacker does not join that side — he fights the starbase himself
// and loses ships to it. What an ally can do is land in the same 2-minute fleet cycle
// right AFTER the attacker: the attacker has just fought the starbase, has lost ships to
// it, and cannot leave before the counter-attack lands.
//
// So, in order:
//   1. planetFight   — attacker vs starbase + garrison. Who wins, and what is left of
//                      the attacker if the planet falls.
//   2. sbUpgrade     — the cheapest starbase level the planet's own saved PP reaches by
//                      arrival that makes it hold; otherwise the best it can reach.
//   3. counterFight  — an ally landing after it, against what is left of the attacker.
//      landBefore    — or an ally landing BEFORE it: kill the starbase, then hold the
//                      planet (keeps population and buildings; costs the starbase).
//   4. ownerReinforce — the OWNER landing his own fleet before the attacker: it joins the
//                      starbase, so it is the planet fight with a bigger garrison.
//
// The loser of a battle is wiped (98.4% of recorded battles, see battle-model.js); the
// survivors simulate() returns for a side are what that side keeps when it wins.
//
// Pure: no database. src/routes/incoming.js gathers the inputs.

const battleModel = require('../../public/js/utils/battle-model.js');
const AWTables = require('../../public/js/utils/game-tables.js');
const { observedCombatSciences } = require('./true-power');

const { simulate, cvOf, resolveStats, toFleet } = battleModel;

// A planet "holds" when the defence wins at least this often. The model is exact to
// ±0.1pp, so 99.5% is a real number, not rounding.
const HOLDS = 0.995;

/**
 * Combat stats for one of OUR players. resolveStats() falls back to the public science
 * level once a scan is 24 h old — right for an enemy (assume the worst), wrong for an ally:
 * RAID's science levels run 18-25 while their real physics is 7-15, so an aged scan made
 * every ally look stronger than he is. The member sheet carries the real sciences; the
 * fresher of sheet and scan wins (the same rule as True Power).
 *   row: players combat columns + sheet_physics, sheet_mathematics, sheet_sciences_updated_at
 */
function allySide(row) {
    // No scan of our own player: resolveStats() would assume +4/+4 race — the worst case
    // for an ENEMY, the most flattering one for us. Neutral 0/0 instead.
    if (!row || !row.has_intel) {
        const seen = row ? observedCombatSciences(row) : { physics: null, mathematics: null };
        return { ra: 0, rd: 0, phys: seen.physics || 0, math: seen.mathematics || 0, lvl: (row && row.level) || 0,
            totalXp: row && Number.isFinite(row.total_xp) ? row.total_xp : null, unknown: true };
    }
    const base = resolveStats(row);
    const seen = observedCombatSciences(row);
    return {
        ...base,
        totalXp: Number.isFinite(row.total_xp) ? row.total_xp : null,
        phys: seen.physics != null ? seen.physics : base.phys,
        math: seen.mathematics != null ? seen.mathematics : base.math,
    };
}

// ─── Experience between fights (2026-10-04) ──────────────────────────────────────────
// The winner of a battle gains XP equal to the CV the loser lost — 1,481 of 1,534 recorded
// battle reports match that exactly; most of the rest are the reduced payout, 25% when the
// winner keeps fewer than 2 ships (docs/game-rules.md, "Full XP from combat"). Beating a
// starbase can therefore lift the attacker a player level or two before the counter-attack
// lands in the same cycle, and the level bonus (1% per level ahead, only with all three
// ship types) counts in that next fight. The same works for an ally who kills the
// starbase first. NOT verified: that the new level already applies to a second battle in
// the same 2-minute cycle; the alerts assume it does.
const levelXp = level => AWTables.aggregate(AWTables.PLAYER_LEVEL, 0, level);
function levelForXp(totalXp) {
    let lvl = 0;
    while (lvl + 1 < AWTables.PLAYER_LEVEL.length && levelXp(lvl + 1) <= totalXp) lvl++;
    return lvl;
}
const shipCount = f => toFleet(f).reduce((a, b) => a + b, 0);
function xpGained(loserLostCv, winnerLeft) {
    const full = Math.round(Math.max(0, loserLostCv));
    return shipCount(winnerLeft) >= 2 ? full : Math.floor(full * 0.25);
}
// side: { lvl, totalXp } — totalXp from the players table when known; otherwise the side
// is taken to stand at the very start of its level (the fewest levels it could gain).
function levelAfter(side, gained) {
    const lvl = (side && side.lvl) || 0;
    const base = side && Number.isFinite(side.totalXp) ? side.totalXp : levelXp(lvl);
    return Math.max(lvl, levelForXp(base + gained));
}

// "1 DS, 0.4 CR, 13.7 BS" — survivors are fractional in the game too: the fraction is the
// chance one more ship survived.
function fleetText(f) {
    const names = ['DS', 'CR', 'BS'];
    const one = n => (Math.round(n * 10) / 10).toString();
    const parts = toFleet(f).map((n, i) => (n >= 0.05 ? `${one(n)} ${names[i]}` : null)).filter(Boolean);
    return parts.length ? parts.join(', ') : 'nothing';
}

// Attacker vs the planet: starbase + garrison as one side.
function planetFight({ enemyFleet, enemy, sbLevel, garrison, owner }) {
    const r = simulate({
        defFleet: toFleet(garrison), atkFleet: toFleet(enemyFleet),
        sbLevel: Math.max(0, sbLevel || 0), def: owner, atk: enemy,
    });
    if (!r) return null;
    const enemyLeft = r.winA > 0 ? r.survAtk : [0, 0, 0];
    // Taking the planet pays the attacker the whole defence in XP.
    const enemyXp = r.winA > 0 ? xpGained(r.initCVD, enemyLeft) : 0;
    const enemyLvlAfter = levelAfter(enemy, enemyXp);
    return {
        holds: r.winD,
        sbLevel: r.sbLvl,
        garrisonCv: cvOf(garrison),
        // If the planet falls: what of the attacker is still sitting on it.
        enemyLeft,
        enemyLeftCv: cvOf(enemyLeft),
        enemyXp,
        enemyLvlBefore: (enemy && enemy.lvl) || 0,
        enemyLvlAfter,
        // The attacker as he stands for the counter-attack: same stats, new level.
        enemyAfter: { ...enemy, lvl: enemyLvlAfter },
        // If it holds: what the defence keeps (fleet + starbase CV), and the fleet alone.
        defenceLeftCv: r.cvDefRemain,
        garrisonLeftCv: cvOf(r.survDef),
    };
}

// Production points a planet will have saved by `hours` from now, if nobody spends them.
function ppAfter(planet, hours) {
    return Math.max(0, (planet.production_pp || 0) + (planet.production_rate || 0) * Math.max(0, hours));
}

/**
 * The starbase the planet's own PP can buy before the attack lands.
 *   budgetPp — what the owner can spend there (the planet's own saved PP; from his home
 *              planet he can spend every planet's PP — the caller decides)
 * Returns the cheapest level that makes the planet hold, else the highest affordable
 * level — which still destroys attacking ships for whoever counter-lands; null when not
 * even one more level is affordable.
 */
function sbUpgrade({ enemyFleet, enemy, sbLevel, garrison, owner, budgetPp }) {
    const from = Math.max(0, sbLevel || 0);
    const top = Math.min(AWTables.maxLevel(AWTables.BUILDING), battleModel.clampStarbase(99));
    let best = null;
    for (let lvl = from + 1; lvl <= top; lvl++) {
        const cost = AWTables.aggregate(AWTables.BUILDING, from, lvl);
        if (cost > budgetPp) break;
        const fight = planetFight({ enemyFleet, enemy, sbLevel: lvl, garrison, owner });
        best = { level: lvl, cost, holds: fight ? fight.holds : 0,
            enemyLeft: fight ? fight.enemyLeft : [0, 0, 0], enemyLeftCv: fight ? fight.enemyLeftCv : 0 };
        if (best.holds >= HOLDS) break;
    }
    return best;
}

// An ally landing right after the attacker, against what the planet fight left of it.
// The ally is the ATTACKER here: the enemy now sits on the planet, its starbase gone.
function counterFight({ allyFleet, ally, enemyLeft, enemy }) {
    if (cvOf(enemyLeft) <= 0) return { win: 1, keepCv: cvOf(allyFleet) };
    const r = simulate({ defFleet: toFleet(enemyLeft), atkFleet: toFleet(allyFleet), sbLevel: 0, def: enemy, atk: ally });
    if (!r) return null;
    return { win: r.winA, keepCv: r.winA > 0 ? r.cvAtkRemain : 0 };
}

// An ally landing BEFORE the attacker (2026-10-04). He fights his ally's starbase first and
// loses ships to it, then holds the planet with what is left. Worth it when losing the
// planet is the bigger loss: a conquered and retaken planet loses population and
// buildings, a destroyed starbase costs only PP.
//   step 1: ally (attacking) vs the starbase (owner's stats). No starbase -> no fight.
//   step 2: the attacker vs the ally's survivors sitting on the planet, no starbase.
// holds = P(ally kills the starbase) x P(he then beats the attacker). If he fails step 1
// he is the loser and wiped, and the starbase meets the attacker damaged — counted as lost.
// The owner's own ships on the planet are left out of both steps: whether an ally landing
// on them fights them too is not confirmed.
function landBefore({ allyFleet, ally, owner, sbLevel, enemyFleet, enemy }) {
    let left = toFleet(allyFleet), pKill = 1, sbCostCv = 0, holder = ally;
    if (sbLevel > 0) {
        const r1 = simulate({ defFleet: [0, 0, 0], atkFleet: left, sbLevel, def: owner, atk: ally });
        if (!r1 || r1.winA <= 0) return { win: 0, keepCv: 0, sbCostCv: cvOf(left) };
        pKill = r1.winA;
        sbCostCv = cvOf(left) - r1.cvAtkRemain;
        left = r1.survAtk;
        // Killing the starbase pays him its CV in XP before the attacker arrives.
        holder = { ...ally, lvl: levelAfter(ally, xpGained(r1.initCVD, left)) };
    }
    const r2 = simulate({ defFleet: left, atkFleet: toFleet(enemyFleet), sbLevel: 0, def: holder, atk: enemy });
    if (!r2) return null;
    return { win: pKill * r2.winD, keepCv: r2.winD > 0 ? r2.cvDefRemain : 0, sbCostCv };
}

// The owner landing before the attacker: his fleet stands with his starbase.
function ownerReinforce({ allyFleet, enemyFleet, enemy, sbLevel, garrison, owner }) {
    const g = toFleet(garrison), a = toFleet(allyFleet);
    const fight = planetFight({ enemyFleet, enemy, sbLevel, garrison: [g[0] + a[0], g[1] + a[1], g[2] + a[2]], owner });
    // keepCv is ships only (his garrison and the new fleet); the starbase is not "kept CV".
    return fight ? { win: fight.holds, keepCv: fight.holds > 0 ? fight.garrisonLeftCv : 0 } : null;
}

// "87%" — the model is exact to ±0.1pp; a ping does not need the decimal unless it is
// the difference between "certain" and "almost".
function pct(p) {
    const v = Math.max(0, Math.min(1, p)) * 100;
    if (v > 99 && v < 100) return `${Math.floor(v * 10) / 10}%`;
    if (v > 0 && v < 1) return `${Math.max(0.1, Math.round(v * 10) / 10)}%`;
    return `${Math.round(v)}%`;
}

module.exports = { HOLDS, allySide, planetFight, ppAfter, sbUpgrade, counterFight, landBefore, ownerReinforce, pct,
    levelForXp, xpGained, levelAfter, fleetText };
