// True Power columns for the Alliance table (issue #154).
//
// Run with:  node src/utils/true-power.test.js
//
// TP  = win chance, 100 DS vs 100 DS, equal sciences and level, enemy at 0 race attack.
// TPx = the same against +4 race attack, the highest level and the highest physics known.
// These cases pin the definition against the shared battle model rather than a copied
// formula: symmetric inputs give 50%, race attack moves it the right way, physics matters
// for TPx, and a player with no intel gets null (a "?" cell), not an assumed rating.

const path = require('path');
const { truePower, truePowerForAllianceRow, REFERENCE_FLEET } = require(path.join(__dirname, 'true-power.js'));
const battleModel = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'battle-model.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('true-power.test.js');

const fresh = new Date().toISOString();
const scouted = (ra, extra = {}) => ({ has_intel: 1, race_attack: ra, race_defense: 0, physics: 10, mathematics: 8, level: 12, science_level: 10, intel_updated_at: fresh, ...extra });
const ceilings = { max_level: 30, max_physics: 25, max_science_level: 27 };

console.log('\n── TP: the member\'s own race attack, everything else equal ' + '─'.repeat(18));
ok('the reference fleet is 100 destroyers and nothing else', JSON.stringify(REFERENCE_FLEET) === '[100,0,0]');
const zero = truePower(scouted(0), ceilings);
ok('0 race attack vs 0 race attack at equal everything is exactly 50%', zero.tp === 50, zero);
const plus4 = truePower(scouted(4), ceilings);
ok('+4 race attack beats a 0-attack twin (> 50%)', plus4.tp > 50, plus4);
const minus4 = truePower(scouted(-4), ceilings);
ok('-4 race attack loses to a 0-attack twin (< 50%)', minus4.tp < 50, minus4);
// Not symmetric on purpose: the model's race term is ln(1 + 0.08·RA), so -4 (ln 0.68) is a
// bigger log-odds hit than +4 (ln 1.32) is a gain — a -4 pick is nearly a certain loss here.
ok('-4 hurts more than +4 helps (ln(1+0.08·RA) is not symmetric)', (50 - minus4.tp) > (plus4.tp - 50), { plus4: plus4.tp, minus4: minus4.tp });
const expectedPlus4 = Math.round(battleModel.winChance([100, 0, 0], { ra: 4, rd: 0, phys: 10, math: 8, lvl: 12 }, [100, 0, 0], { ra: 0, rd: 0, phys: 10, math: 8, lvl: 12 }) * 1000) / 10;
ok('TP is the shared battle model\'s number, not a copied formula', plus4.tp === expectedPlus4, { tp: plus4.tp, expectedPlus4 });
ok('TP has one decimal at most', Number.isInteger(plus4.tp * 10));

console.log('\n── TPx: against +4 attack, the highest level and the highest physics ' + '─'.repeat(9));
ok('TPx is lower than TP for the same member (the enemy got stronger)', plus4.tpx < plus4.tp, plus4);
const atCeiling = truePower(scouted(4, { physics: 25, level: 30 }), ceilings);
ok('a +4 member already AT the physics ceiling meets an equal enemy: TPx is exactly 50%', atCeiling.tpx === 50, atCeiling);
const lowPhys = truePower(scouted(4, { physics: 5 }), ceilings);
ok('lower physics than the ceiling costs TPx', lowPhys.tpx < atCeiling.tpx, { lowPhys: lowPhys.tpx, atCeiling: atCeiling.tpx });
const bracket = truePower(scouted(4, { physics: 19 }), ceilings);
ok('a 6+ physics gap to the ceiling trips the model\'s bracket penalty (visibly below the 5-gap case)',
    bracket.tpx < truePower(scouted(4, { physics: 20 }), ceilings).tpx - 3, { gap6: bracket.tpx, gap5: truePower(scouted(4, { physics: 20 }), ceilings).tpx });
ok('player level does not move a pure-destroyer duel (the model gates it on all three ship types)',
    truePower(scouted(4, { level: 1 }), ceilings).tpx === truePower(scouted(4, { level: 30 }), ceilings).tpx);
const noPhysCeiling = truePower(scouted(4, { physics: 27 }), { max_level: 30, max_physics: null, max_science_level: 27 });
ok('with no scouted physics anywhere, the public science-level ceiling stands in', noPhysCeiling.tpx === 50, noPhysCeiling);

console.log('\n── No intel -> no rating ' + '─'.repeat(52));
ok('a never-scouted player yields null for both', JSON.stringify(truePower({ has_intel: 0, level: 5, science_level: 8 }, ceilings)) === '{"tp":null,"tpx":null}');
ok('a missing row yields null for both', JSON.stringify(truePower(null, ceilings)) === '{"tp":null,"tpx":null}');
const staleIntel = truePower(scouted(4, { intel_updated_at: '2026-01-01T00:00:00Z', physics: 25, science_level: 10 }), ceilings);
const staleExpected = truePower(scouted(4, { physics: 10, science_level: 10 }), ceilings);
ok('stale intel (>24h) falls back to science_level for physics, like every other model caller', staleIntel.tpx === staleExpected.tpx, { staleIntel, staleExpected });

console.log('\n── Alliance rows use the pl_ aliases ' + '─'.repeat(41));
const viaAlias = truePowerForAllianceRow({ pl_has_intel: 1, pl_race_attack: 4, pl_race_defense: 0, pl_physics: 10, pl_mathematics: 8, pl_level: 12, pl_science_level: 10, pl_intel_updated_at: fresh }, ceilings);
ok('truePowerForAllianceRow maps pl_* fields onto the same computation', viaAlias.tp === plus4.tp && viaAlias.tpx === plus4.tpx, { viaAlias, plus4 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
