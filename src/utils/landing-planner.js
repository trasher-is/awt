// Landing planner: several fleets landing on one planet in one fleet cycle (2026-10-04).
//
// The rules (docs/game-rules.md, "Fleet and combat notes"):
//   • fleets landing on a planet fight ONE AT A TIME, in landing order — allies too: an ally
//     landing on an ally-held planet fights the fleet sitting there;
//   • whoever holds the planet defends it: the owner with his starbase and his own ships
//     (his own landing fleets join them instead of fighting), anyone else with his fleet;
//   • same-second landings resolve in launch order, so the attacker lands first;
//   • the attacker can leave from the next cycle, so the chain is: the "before" landings in
//     their order, the attacker, then the "after" landings in their order, all in his cycle.
// Each fight is won or lost with the battle model's chance, so the chain BRANCHES; every
// branch is followed and its probability multiplied out. The loser of a fight is wiped
// (battle-model.js); the winner keeps its survivors — rounded against us: the enemy UP,
// our side DOWN — and gains XP equal to the CV the loser lost, so a level-up carries into
// the next fight (incoming-battle.js has the measured XP rule).
//
// Confirmed by the alliance's lead player (2026-10-04): an ally landing on the owner's
// planet fights the starbase AND any owner ships on it; a starbase damaged in a fight it
// wins drops to the level its remaining CV pays for.
//
// Outcomes per branch:
//   held     — the attacker lost the fight he landed into: the planet never fell
//   retaken  — he took it, and someone landing after him wiped him in the same cycle
//   lost     — he still holds it when the cycle ends
//
// Pure: callers pass fleets as [D, C, B] and sides as battle-model stats plus totalXp.

const battleModel = require('../../public/js/utils/battle-model.js');
const { xpGained, levelAfter, ceilFleet, floorFleet } = require('./incoming-battle');

const { simulate, cvOf, sbCV, toFleet } = battleModel;

const roundFor = side => (side === 'enemy' ? ceilFleet : floorFleet);
const addFleets = (a, b) => toFleet(a).map((n, i) => n + toFleet(b)[i]);
const empty = f => cvOf(f) <= 0;

// The level a damaged starbase is left at: the highest level its remaining CV still pays for.
function sbLevelLeft(level, fraction) {
    if (!(level > 0) || !(fraction > 0)) return 0;
    const left = sbCV(level) * fraction;
    let l = level;
    while (l > 0 && sbCV(l) > left + 1e-9) l--;
    return l;
}

/**
 * planet:   { sbLevel, garrison: [D,C,B], owner: stats, ownerName }
 * enemy:    { name, fleet: [D,C,B], stats }
 * landings: [{ name, fleet, stats, when: 'before'|'after', isOwner }] in landing order per side
 * Returns { held, retaken, lost, kept: { name: expected CV kept }, likely: [step], branches }
 */
function simulateChain({ planet, enemy, landings }) {
    const seq = [
        ...landings.filter(l => l.when === 'before'),
        { name: enemy.name, fleet: enemy.fleet, stats: enemy.stats, side: 'enemy', isEnemy: true },
        ...landings.filter(l => l.when !== 'before'),
    ].map((l, i) => ({ ...l, id: i, side: l.isEnemy ? 'enemy' : 'raid', fleet: toFleet(l.fleet) }));

    const ownerId = 'owner';
    const start = {
        occ: { id: ownerId, side: 'raid', isOwner: true, name: planet.ownerName || 'owner',
            fleet: toFleet(planet.garrison || [0, 0, 0]), sb: Math.max(0, planet.sbLevel || 0),
            stats: planet.owner },
        xp: {},               // id -> XP gained so far in this chain
        enemyHeld: null,      // true once the attacker won (or walked into) his landing
    };
    const statsOf = (state, part) => ({ ...part.stats, lvl: levelAfter(part.stats, state.xp[part.id] || 0) });

    const results = [];
    // `trail` records the steps of one branch, for the most-likely narrative.
    function run(state, i, p, trail) {
        if (p <= 1e-9) return;
        if (i === seq.length) { results.push({ p, state, trail }); return; }
        const L = seq[i];
        const occ = state.occ;

        // Nobody to fight: an empty planet, or the owner landing on his own.
        const occEmpty = !occ || (empty(occ.fleet) && !(occ.sb > 0));
        if (occEmpty || (occ.isOwner && L.isOwner)) {
            const merged = !occEmpty && occ.isOwner && L.isOwner;
            const next = {
                ...state,
                occ: merged ? { ...occ, fleet: addFleets(occ.fleet, L.fleet) }
                    : { id: L.id, side: L.side, isOwner: !!L.isOwner, name: L.name, fleet: L.fleet, sb: 0, stats: L.stats },
                enemyHeld: L.isEnemy ? true : state.enemyHeld,
            };
            run(next, i + 1, p, [...trail, { name: L.name, side: L.side, fight: false, joined: merged, p: 1 }]);
            return;
        }

        const defStats = occ.id === ownerId ? { ...occ.stats, lvl: levelAfter(occ.stats, state.xp[ownerId] || 0) } : statsOf(state, seq[occ.id]);
        const r = simulate({ defFleet: occ.fleet, atkFleet: L.fleet, sbLevel: occ.sb || 0, def: defStats, atk: statsOf(state, L) });
        if (!r) { run(state, i + 1, p, trail); return; }

        const step = { name: L.name, side: L.side, fight: true, against: occ.name, againstSide: occ.side, sb: occ.sb || 0, winA: r.winA };
        if (r.winA > 0) {
            const left = roundFor(L.side)(r.survAtk);
            const xp = { ...state.xp, [L.id]: (state.xp[L.id] || 0) + xpGained(r.initCVD, left) };
            run({
                occ: { id: L.id, side: L.side, isOwner: !!L.isOwner, name: L.name, fleet: left, sb: 0, stats: L.stats },
                xp,
                enemyHeld: L.isEnemy ? true : state.enemyHeld,
            }, i + 1, p * r.winA, [...trail, { ...step, won: true, p: r.winA, keptCv: cvOf(left) }]);
        }
        if (r.winD > 0) {
            const left = roundFor(occ.side)(r.survDef);
            const xp = { ...state.xp, [occ.id]: (state.xp[occ.id] || 0) + xpGained(r.initCVA, left) };
            run({
                occ: { ...occ, fleet: left, sb: sbLevelLeft(occ.sb, r.survSB) },
                xp,
                enemyHeld: L.isEnemy ? false : state.enemyHeld,
            }, i + 1, p * r.winD, [...trail, { ...step, won: false, p: r.winD, keptCv: cvOf(left) }]);
        }
    }
    run(start, 0, 1, []);

    let held = 0, retaken = 0, lost = 0;
    const kept = {};
    for (const b of results) {
        const end = b.state.occ;
        const enemyEnds = end && end.side === 'enemy';
        if (b.state.enemyHeld === false) held += b.p;
        else if (enemyEnds) lost += b.p;
        else retaken += b.p;
        if (end && end.side === 'raid') kept[end.name] = (kept[end.name] || 0) + b.p * cvOf(end.fleet);
    }
    // The most likely branch, step by step (each fight's likelier side).
    const likely = results.reduce((a, b) => (b.p > a.p ? b : a), results[0] || { trail: [], p: 0 });
    const enemyEndLevel = (() => {
        const e = seq.find(s => s.isEnemy);
        return likely.state ? levelAfter(e.stats, likely.state.xp[e.id] || 0) : (e.stats.lvl || 0);
    })();
    return { held, retaken, lost, kept, likely: likely.trail, likelyP: likely.p, enemyEndLevel, branches: results.length };
}

const notLost = r => r.held + r.retaken;

// "Within this much of the best chance" is good enough to prefer the smaller sacrifice.
const CHEAP_MARGIN = 0.02;

/**
 * The sacrifice search. `decoy` gives up part of its fleet so that `closer`, landing after
 * the attacker, has the best chance. Every share of the decoy's fleet (1-100%, whole
 * ships per type, rounded down) is tried landing BEFORE the attacker (it fights the
 * starbase first) and landing AFTER him, ahead of the closer.
 *   best     — the highest chance the planet is not lost (ties: more held, more ships kept).
 *              Ships cost nothing here, so it is often "send everything".
 *   cheapest — the SMALLEST decoy (CV) whose chance is within CHEAP_MARGIN of the best:
 *              the actual sacrifice answer.
 *   table    — every 10% per placement, to pick another trade-off by eye.
 * Returns { baseline, best, cheapest, table, curve }.
 */
function bestSacrifice({ planet, enemy, decoy, closer }) {
    const closerLanding = { ...closer, when: 'after' };
    const baseline = simulateChain({ planet, enemy, landings: [closerLanding] });
    const score = r => [notLost(r), r.held, Object.values(r.kept).reduce((a, b) => a + b, 0)];
    const better = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] > b[i] + 1e-9) return true; if (a[i] < b[i] - 1e-9) return false; } return false; };

    let best = null;
    const curve = [];
    const full = toFleet(decoy.fleet);
    for (const when of ['before', 'after']) {
        let lastKey = '';
        for (let share = 1; share <= 100; share++) {
            const fleet = full.map(n => Math.floor(n * share / 100 + 1e-9));
            const key = fleet.join('-');
            if (empty(fleet) || key === lastKey) continue;
            lastKey = key;
            const landings = when === 'before'
                ? [{ ...decoy, fleet, when: 'before' }, closerLanding]
                : [{ ...decoy, fleet, when: 'after' }, closerLanding];
            const r = simulateChain({ planet, enemy, landings });
            const point = { when, share, fleet, cv: cvOf(fleet), notLost: notLost(r), held: r.held, retaken: r.retaken, lost: r.lost,
                kept: r.kept, enemyEndLevel: r.enemyEndLevel, likely: r.likely };
            curve.push(point);
            if (!best || better(score(r), score(best.result))) best = { ...point, result: r };
        }
    }
    if (best) delete best.result;
    const cheapest = best
        ? curve.filter(c => c.notLost >= best.notLost - CHEAP_MARGIN).reduce((a, c) => (c.cv < a.cv || (c.cv === a.cv && c.notLost > a.notLost) ? c : a))
        : null;
    const table = curve.filter(c => c.share % 10 === 0).map(c => ({ when: c.when, share: c.share, fleet: c.fleet, cv: c.cv,
        notLost: c.notLost, held: c.held, enemyEndLevel: c.enemyEndLevel }));
    return { cheapest, table, baseline: { notLost: notLost(baseline), held: baseline.held, retaken: baseline.retaken, lost: baseline.lost,
        kept: baseline.kept, enemyEndLevel: baseline.enemyEndLevel, likely: baseline.likely }, best, curve };
}

module.exports = { simulateChain, bestSacrifice, sbLevelLeft, CHEAP_MARGIN };
