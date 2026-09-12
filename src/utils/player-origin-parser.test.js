// Synthetic profile DOMs exercise the real extractor and shared label lookup. An
// unrelated planet link must never become evidence that a player changed origin.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}

const solarLink = 'a[href^="/Game/Map/SolarSystem/"]';
function link(href) {
    return { innerText: 'Synthetic system', getAttribute: name => name === 'href' ? href : null };
}
function cell(text, href) {
    const anchor = href ? link(href) : null;
    return {
        innerText: text,
        querySelector: selector => selector === solarLink && href?.startsWith('/Game/Map/SolarSystem/') ? anchor : null
    };
}
function profile(extraRows) {
    const rows = [
        ['Local Time', '12:34'], ['Idle', '1h'], ['Joined', '2026-01-01'], ['Logins', '125'],
        ['Player Level', '20'], ['Science Level', '50'], ['Culture Level', '10'], ['Ranking', '#4 (1 234)'],
        ...extraRows
    ];
    const cells = rows.flatMap(([label, text, href]) => {
        const key = cell(label), value = cell(text, href);
        key.nextElementSibling = value;
        return [key, value];
    });
    const header = { innerText: 'Synthetic navigator', querySelector: () => null };
    return {
        querySelector(selector) {
            if (selector === 'th[colspan="2"]') return header;
            // This reproduces the old document-wide fallback's actual DOM match: the
            // first SolarSystem anchor in any table row, even when it is not Origin.
            if (selector === 'table tbody tr ' + solarLink) {
                return cells.map(c => c.querySelector(solarLink)).find(Boolean) || null;
            }
            return null;
        },
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
function extract(rows) {
    context.syntheticProfile = profile(rows);
    return vm.runInContext('extractPlayerData(701, syntheticProfile)', context);
}

console.log('player-origin-parser.test.js');
let player = extract([['Planet', 'Synthetic colony', '/Game/Map/SolarSystem/941/8']]);
ok('missing Origin never uses an unrelated planet link as the origin', player.origin_system === null, player.origin_system);
ok('missing Origin remains visible in the scrape report', player.scrapeReport.problems.some(p => p.reason === 'label not found' && p.detail === 'origin'));
ok('a missing Origin does not erase other valid profile fields', player.id === 701 && player.name === 'Synthetic navigator'
    && player.logins === 125 && player.level === 20 && player.points === 1234);
player = extract([['Other field', 'Synthetic system', '/Game/Map/SolarSystem/941']]);
ok('a bare system link under another label is not accepted either', player.origin_system === null, player.origin_system);
player = extract([['Origin', 'N/A'], ['Planet', 'Synthetic colony', '/Game/Map/SolarSystem/941/8']]);
ok('an explicitly redacted Origin stays unknown despite unrelated planet links', player.origin_system === null, player.origin_system);
player = extract([['Origin', '941']]);
ok('Origin text without a system link is not guessed as an id', player.origin_system === null, player.origin_system);
player = extract([['Other field', 'Synthetic colony', '/Game/Map/SolarSystem/111/2'], ['Origin', 'Synthetic origin', '/Game/Map/SolarSystem/941']]);
ok('the explicit Origin link wins over earlier unrelated links', player.origin_system === 941, player.origin_system);
player = extract([['ORIGIN:', 'Synthetic origin', '/Game/Map/SolarSystem/941']]);
ok('existing case and punctuation normalization still recognizes Origin', player.origin_system === 941, player.origin_system);
for (const href of ['/Game/Map/SolarSystem/941/8', '/Game/Map/SolarSystem/941/', '/Game/Map/SolarSystem/941?view=profile', '/Game/Map/SolarSystem/941#planet-8']) {
    player = extract([['Origin', 'Synthetic origin', href]]);
    ok(`the system path segment is read correctly in ${href}`, player.origin_system === 941, player.origin_system);
}
for (const href of ['/Game/Map/SolarSystem/0', '/Game/Map/SolarSystem/-2', '/Game/Map/SolarSystem/941wrong', '/Game/Map/SolarSystem/9007199254740992']) {
    player = extract([['Origin', 'Synthetic origin', href]]);
    ok(`an invalid system path remains unknown: ${href}`, player.origin_system === null, player.origin_system);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
