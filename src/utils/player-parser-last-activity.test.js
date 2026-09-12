// Before 2026-09-12, a manual profile visit or the "Players" bulk button only ever wrote
// the frozen idle_time STRING — last_activity_at was left to depend entirely on the API
// sweep ever having reached that player. extractPlayerData now derives a real
// last_activity_at timestamp from the same idle_time string, anchored to "now" (the moment
// the page was scraped), so a DOM-only visit updates the same authoritative field the API
// sweep uses (see players.js's upsertPlayerFullStmt for the "never regress" merge rule).
//
// Same synthetic-DOM + vm harness as player-origin-parser.test.js, for the same reason:
// player-parser.js is browser-only ESM.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}

function cell(text) {
    return { innerText: text, querySelector: () => null };
}
function profile(idleText) {
    const rows = [
        ['Local Time', '12:34'], ['Idle', idleText], ['Joined', '2026-01-01'], ['Logins', '125'],
        ['Player Level', '20'], ['Science Level', '50'], ['Culture Level', '10'], ['Ranking', '#4 (1 234)'],
    ];
    const cells = rows.flatMap(([label, text]) => {
        const key = cell(label), value = cell(text);
        key.nextElementSibling = value;
        return [key, value];
    });
    const header = { innerText: 'Synthetic navigator', querySelector: () => null };
    return {
        querySelector(selector) { return selector === 'th[colspan="2"]' ? header : null; },
        querySelectorAll(selector) { return selector === 'td, th' ? cells : []; }
    };
}

const context = vm.createContext({
    console,
    AWScrape: require('../../public/js/utils/scrape-report'),
    AWNumber: require('../../public/js/utils/parse-number'),
    AWIdleParse: require('../../public/js/utils/idle-parse'),
    AWGameRate: {}
});
const code = fs.readFileSync(path.join(__dirname, '../../public/js/scrapers/player-parser.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
vm.runInContext(code, context);
function extract(idleText) {
    context.syntheticProfile = profile(idleText);
    return vm.runInContext('extractPlayerData(701, syntheticProfile)', context);
}

console.log('player-parser-last-activity.test.js');

const before = Date.now();
let player = extract('Active');
const after = Date.now();
ok('"Active" derives last_activity_at as (close to) right now',
    player.last_activity_at !== null && Date.parse(player.last_activity_at) >= before - 1000 && Date.parse(player.last_activity_at) <= after + 1000,
    player.last_activity_at);

player = extract('3h 10m');
const expectedMs = Date.now() - (3 * 3600 + 10 * 60) * 1000;
ok('"3h 10m" derives last_activity_at ~3h10m in the past',
    player.last_activity_at !== null && Math.abs(Date.parse(player.last_activity_at) - expectedMs) < 2000,
    player.last_activity_at);

player = extract('Unknown');
ok('an unparseable idle string (Unknown) leaves last_activity_at null rather than guessing',
    player.last_activity_at === null, player.last_activity_at);

player = extract(null);
ok('no Idle row at all leaves last_activity_at null', player.last_activity_at === null, player.last_activity_at);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
