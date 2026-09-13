// Regression coverage for matching a Discord channel to the system it is about
// (2026-09-13). Driven by REAL channel lists from three alliances, because the rule this
// replaces looked perfectly correct against the only convention anyone had checked.
//
// The old rule was "trust the trailing number". Against RAID's own "phact-41" it is
// flawless. Against 25 real channel names from two other alliances it scored 0 right, 19
// no-matches, and 6 confidently WRONG — routing a system's intel into a channel about a
// different system, because in "29-praepes-3-9" the trailing number is a coordinate.
//
// Run with: node src/utils/system-channel-match.test.js

const { slugifyName, bestSystemForChannel } = require('./system-channel-match');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// A slice of the real galaxy, including every nesting trap it actually contains.
const SYSTEMS = [
    { id: 1, name: 'Rana' }, { id: 3, name: 'Meboula' }, { id: 6, name: 'Benetnash' },
    { id: 9, name: 'Alphirk' }, { id: 14, name: 'Al Bali' }, { id: 15, name: 'Gorgonea Secunda' },
    { id: 16, name: 'Beshgar Noctis' }, { id: 22, name: 'Albaldah' }, { id: 27, name: 'Al Dhiba' },
    { id: 28, name: 'Arich' }, { id: 29, name: 'Praepes' }, { id: 30, name: 'Okda' },
    { id: 31, name: 'Auva' }, { id: 32, name: 'Asellus Tertius' }, { id: 33, name: 'Mufride' },
    { id: 34, name: 'Difda al Auwel' }, { id: 37, name: 'Gorgonea Quarta' },
    { id: 38, name: 'Zujj al Nushshabah' }, { id: 40, name: 'Minchir' }, { id: 41, name: 'Phact' },
    { id: 42, name: 'Alshemali' }, { id: 43, name: 'Alrescha' }, { id: 44, name: 'Harp Star' },
    { id: 57, name: 'Rasalgethi' }, { id: 60, name: 'Theemim' }, { id: 61, name: 'Tegmine' },
    { id: 62, name: 'Oculus Boreus' }, { id: 87, name: 'Antares' }, { id: 88, name: 'Cebalrai' },
    { id: 89, name: 'Ancha' }, { id: 90, name: 'Saidak' }, { id: 92, name: 'Algoral' },
    { id: 93, name: 'Betelgeuze' }, { id: 94, name: 'Alnath' }, { id: 95, name: 'Fidis' },
    { id: 100, name: 'Difda al Thani' }, { id: 101, name: 'Rana Secunda' },
];
const match = (channel) => bestSystemForChannel(channel, SYSTEMS);
const matchId = (channel) => (match(channel) || {}).id ?? null;

console.log('system-channel-match.test.js');

console.log('\n── RAID\'s own convention: name then id ' + '─'.repeat(37));
for (const [channel, id] of [['phact-41', 41], ['minchir-40', 40], ['alrescha-43', 43], ['harp-star-44', 44], ['alshemali-42', 42]]) {
    ok(`${channel} -> ${id}`, matchId(channel) === id, matchId(channel));
}

console.log('\n── Alliance 2: id FIRST, mixed separators, trailing coordinates ' + '─'.repeat(13));
// These are verbatim from a real channel list. The old rule got every one of them wrong.
const alliance2 = [
    ['14_al-bali', 14], ['15_gorgonea-secunda_6_0', 15], ['16_beshgar-noctis_6_2', 16],
    ['27_al-dhiba', 27], ['28-arich', 28], ['29-praepes-3-9', 29], ['30_okda_5_-9', 30],
    ['31-auva', 31], ['32-asellus-tertius_9_-6', 32], ['33_mufride_9-3', 33],
    ['34-difda-al-auwel_10_1', 34], ['38-zujj-al-nushshabah_5_10', 38], ['60-theemim_11-3', 60],
    ['61-tegmine_13_1', 61], ['62-oculus-boreus-11-3', 62], ['95-fidis', 95], ['94-alnath', 94],
];
for (const [channel, id] of alliance2) {
    ok(`${channel} -> ${id}`, matchId(channel) === id, matchId(channel));
}

console.log('\n── Alliance 3: a "system-" prefix ' + '─'.repeat(42));
for (const [channel, id] of [['system-57_rasalgethi', 57], ['system-87-antares', 87], ['system-88_cebalrai', 88],
    ['system-89-ancha', 89], ['system-90-saidak', 90], ['system-92_algoral', 92],
    ['system-93-betelgeuze', 93], ['system-94-alnath', 94]]) {
    ok(`${channel} -> ${id}`, matchId(channel) === id, matchId(channel));
}

console.log('\n── The coordinate trap, stated outright ' + '─'.repeat(36));
// The failure that makes this more than a missed-match problem: a wrong match posts one
// system's intel into a channel about another.
ok('"29-praepes-3-9" is Praepes, NOT Alphirk (id 9) — that 9 is a coordinate', matchId('29-praepes-3-9') === 29);
ok('"62-oculus-boreus-11-3" is Oculus Boreus, NOT Meboula (id 3)', matchId('62-oculus-boreus-11-3') === 62);
ok('"32-asellus-tertius_9_-6" is Asellus Tertius, NOT Benetnash (id 6)', matchId('32-asellus-tertius_9_-6') === 32);

console.log('\n── One system name containing another ' + '─'.repeat(38));
// Ten real system names contain another as whole tokens. The longer name must win, or a
// channel for "Rana Secunda" also answers for "Rana" and gets its neighbour's intel.
ok('"101-rana-secunda" is Rana Secunda, not Rana', matchId('101-rana-secunda') === 101);
ok('"rana-1" is still plain Rana', matchId('rana-1') === 1);
ok('"100-difda-al-thani" is not Difda al Auwel', matchId('100-difda-al-thani') === 100);
ok('"gorgonea-quarta-37" is not Gorgonea Secunda', matchId('gorgonea-quarta-37') === 37);

console.log('\n── Channels that are not about a system at all ' + '─'.repeat(30));
// Real names from the RAID server. "beta-6" is a round number, and under the old rule it
// matched system 6 — a collision the archive-category filter could not catch, because that
// channel lives in an active category.
for (const channel of ['beta-6', 'final-race-for-beta-4', 'random-thoughts-concerning-beta-5',
    'preparation-for-beta-5', 'review-beta-5', 'raid-talk', 'system-changes', 'population-changes',
    'expansion-coordination', 'trade-agreements', 'votes-only', 'war-on-hnu']) {
    ok(`${channel} -> no system`, matchId(channel) === null, matchId(channel));
}

console.log('\n── An id alone is not enough ' + '─'.repeat(47));
// A bare number is as likely to be a coordinate, a round, or a count as a system id, so
// nothing matches without the name to anchor it.
ok('a channel that is just a number matches nothing', matchId('41') === null, matchId('41'));
ok('a number with unrelated words matches nothing', matchId('top-41-players') === null, matchId('top-41-players'));

console.log('\n── Degenerate input ' + '─'.repeat(56));
ok('empty name', matchId('') === null);
ok('null name', matchId(null) === null);
ok('no systems supplied', bestSystemForChannel('phact-41', []) === null);
ok('systems list not an array', bestSystemForChannel('phact-41', null) === null);
ok('a system row with no name is skipped, not crashed on',
    bestSystemForChannel('phact-41', [{ id: 41, name: null }, { id: 41, name: 'Phact' }]).id === 41);
ok('a system row with no id is skipped', bestSystemForChannel('phact-41', [{ name: 'Phact' }]) === null);

console.log('\n── slugifyName ' + '─'.repeat(61));
ok('spaces and case', slugifyName('Difda al Auwel') === 'difda-al-auwel');
ok('underscores collapse to the same separator', slugifyName('al_bali') === 'al-bali');
ok('runs of punctuation collapse to one', slugifyName('Rana  --  Secunda') === 'rana-secunda');
ok('leading/trailing separators are trimmed', slugifyName('_phact_') === 'phact');
ok('non-ascii decoration does not break it', slugifyName('1-rana🏴‍☠️💔') === '1-rana');

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
