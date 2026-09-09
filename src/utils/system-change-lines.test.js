// Planet-change announcements say who did what to whom (issue #156).
//
// Run with:  node src/utils/system-change-lines.test.js
//
// The bot used to post "population 5 → 3" and "Old → New" — numbers without attribution.
// These cases pin the classification of an owner change and the wording of every line,
// including the honest "attacker not visible" fallback for a bombardment no battle report
// has been matched to yet.

const path = require('path');
const { ownerChangeKind, buildSystemChangeLines } = require(path.join(__dirname, 'system-change-lines.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('system-change-lines.test.js');

console.log('\n── Classifying an owner change ' + '─'.repeat(46));
ok('X -> Y is a conquest', ownerChangeKind({ oldOwnerId: 51, newOwnerId: 52, isUnknown: false, oldPop: 3 }) === 'conquered');
ok('X -> null with the game reporting Unknown is lost_unknown', ownerChangeKind({ oldOwnerId: 51, newOwnerId: null, isUnknown: true, oldPop: 3 }) === 'lost_unknown');
ok('X -> null without Unknown is lost (Empty)', ownerChangeKind({ oldOwnerId: 51, newOwnerId: null, isUnknown: false, oldPop: 0 }) === 'lost');
ok('null -> Y with leftover population is colonized_unknown', ownerChangeKind({ oldOwnerId: null, newOwnerId: 52, isUnknown: false, oldPop: 4 }) === 'colonized_unknown');
ok('null -> Y with no population is a plain colonization', ownerChangeKind({ oldOwnerId: null, newOwnerId: 52, isUnknown: false, oldPop: 0 }) === 'colonized');

console.log('\n── Owner-change lines ' + '─'.repeat(55));
const owner = buildSystemChangeLines([
    { planet_index: 1, type: 'OWNER_CHANGE', kind: 'conquered', old_owner: '[OLD] Caveman', new_owner: '[NEW] Conqueror', old_pop: 51 },
    { planet_index: 2, type: 'OWNER_CHANGE', kind: 'conquered', old_owner: 'Caveman', new_owner: 'Conqueror', old_pop: 0 },
    { planet_index: 3, type: 'OWNER_CHANGE', kind: 'lost_unknown', old_owner: 'Quitter', new_owner: null, old_pop: 4 },
    { planet_index: 4, type: 'OWNER_CHANGE', kind: 'lost', old_owner: 'Nomad', new_owner: null, old_pop: 0 },
    { planet_index: 5, type: 'OWNER_CHANGE', kind: 'colonized_unknown', old_owner: null, new_owner: '[NEW] Settler', old_pop: 4 },
    { planet_index: 6, type: 'OWNER_CHANGE', kind: 'colonized', old_owner: null, new_owner: 'Settler', old_pop: 0 },
    { planet_index: 7, type: 'OWNER_CHANGE', old_owner: 'A', new_owner: 'B' },
]).ownerLines;
ok('seven owner lines, none dropped', owner.length === 7, owner);
ok('conquest names the conqueror, the victim and the population wiped',
    owner[0] === '🪐 **Planet 1**: **[NEW] Conqueror** conquered it from [OLD] Caveman — 51 population wiped', owner[0]);
ok('a conquest of an empty planet says nothing about population', owner[1] === '🪐 **Planet 2**: **Conqueror** conquered it from Caveman', owner[1]);
ok('lost to Unknown reads as resigned/abandoned', owner[2] === '🪐 **Planet 3**: Quitter lost it — now Unknown (resigned or abandoned)', owner[2]);
ok('lost to Empty', owner[3] === '🪐 **Planet 4**: Nomad lost it — now Empty', owner[3]);
ok('colonizing an Unknown planet names the settler and the leftover population wiped',
    owner[4] === '🪐 **Planet 5**: **[NEW] Settler** colonized an Unknown planet — 4 leftover population wiped', owner[4]);
ok('colonizing a free planet names the settler', owner[5] === '🪐 **Planet 6**: **Settler** colonized a free planet', owner[5]);
ok('an unclassified event keeps the old arrow wording', owner[6] === '🪐 **Planet 7**: A → **B**', owner[6]);

console.log('\n── Population lines ' + '─'.repeat(57));
const pop = buildSystemChangeLines([
    { planet_index: 1, type: 'POP_DROP', kind: 'conquest', old_pop: 3, new_pop: 0, victim: '[OLD] Caveman', by: '[NEW] Conqueror' },
    { planet_index: 5, type: 'POP_DROP', kind: 'colonization', old_pop: 4, new_pop: 0, victim: null, by: 'Settler' },
    { planet_index: 8, type: 'POP_DROP', kind: 'bombardment', old_pop: 9, new_pop: 7, owner: '[DEF] Holder', attacker: '[ATK] Raider' },
    { planet_index: 9, type: 'POP_DROP', kind: 'bombardment', old_pop: 5, new_pop: 3, owner: 'Holder', attacker: null },
    { planet_index: 10, type: 'POP_DROP', old_pop: 5, new_pop: 3 },
]).popLines;
ok('five population lines', pop.length === 5, pop);
ok('a conquest kill is the old owner\'s FULL population, credited to the conqueror (the #156 math)',
    pop[0] === '📉 **Planet 1**: **[NEW] Conqueror** wiped 3 population of [OLD] Caveman (conquest)', pop[0]);
ok('colonizing an Unknown planet credits the settler with the leftover population',
    pop[1] === '📉 **Planet 5**: **Settler** wiped 4 leftover population of an Unknown planet (colonization)', pop[1]);
ok('a bombardment with a matched battle report names the attacker',
    pop[2] === '📉 **Planet 8**: [DEF] Holder lost 2 population (9 → 7) — bombarded by **[ATK] Raider**', pop[2]);
ok('a bombardment with no matched report says the attacker is not visible, instead of guessing',
    pop[3] === '📉 **Planet 9**: Holder lost 2 population (5 → 3) — attacker not visible from a system scan', pop[3]);
ok('an unclassified drop keeps the old wording', pop[4] === '📉 **Planet 10**: population 5 → 3', pop[4]);

console.log('\n── Routing ' + '─'.repeat(66));
const mixed = buildSystemChangeLines([{ type: 'OWNER_CHANGE', planet_index: 1, kind: 'lost' }, { type: 'POP_DROP', planet_index: 1, kind: 'bombardment', old_pop: 2, new_pop: 1 }, null]);
ok('owner and population lines go to their own channels, nulls ignored', mixed.ownerLines.length === 1 && mixed.popLines.length === 1);
ok('no events -> two empty lists (announceSystemChanges skips empty embeds)', JSON.stringify(buildSystemChangeLines([])) === '{"ownerLines":[],"popLines":[]}');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
