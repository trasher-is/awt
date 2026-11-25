// Old names off the game's History page (public/js/utils/player-history-parser.js), and the
// profile wiring that shows them.
//
// Run with: node src/utils/player-history-parser.test.js
//
// No jsdom in this repo, so the parser runs against a small stand-in for the handful of
// selectors it uses. Names are invented; the entry shapes are the game's own.

const fs = require('fs');
const path = require('path');
const { parseStarts, oldNames } = require('../../public/js/utils/player-history-parser.js');

let fail = 0;
const ok = (name, cond, detail) => {
    if (cond) console.log(`  ✅ ${name}`);
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const node = textContent => ({ textContent });
// One timeline entry; `strong` is the bold text in its body (a name, or a resign count).
const item = (icon, when, round, strong) => ({
    querySelector: sel => ({
        '.bi-rocket-takeoff': icon === 'bi-rocket-takeoff' ? node('') : null,
        '.mt-2 strong': strong == null ? null : node(strong),
        'small.text-muted': node(`\n   ${when}\n     · ${round}\n`),
        'small.text-muted span': node(`· ${round}`),
    })[sel] ?? null,
});
const page = items => ({
    querySelector: sel => (sel === '.timeline' ? node('') : null),
    querySelectorAll: sel => (sel === '.timeline-item' ? items : []),
});
const joined = (when, round, name) => item('bi-rocket-takeoff', when, round, name);

const B7 = 'Beta 7: Beyond the Void', B6 = 'Beta 6: Echoes of War', B5 = 'Beta 5: Laws of the Ancients';
const HISTORY = page([
    joined('2026-11-22 19:01', B7, 'Nova'),
    item('bi-box-arrow-left', '2026-11-22 18:03', B6, '3'),
    joined('2026-11-22 14:26', B6, 'Nova'),
    item('bi-bar-chart-steps', '2026-11-08 00:00', B6, '#25'),
    item('bi-people', '2026-09-03 16:29', B6, null),
    joined('2026-08-31 10:37', B6, 'Comet'),
    joined('2026-08-31 10:07', B6, 'Quasar'),
    joined('2026-05-17 19:11', B5, 'Quasar'),
]);

console.log('── Reading the timeline ' + '─'.repeat(50));
const starts = parseStarts(HISTORY);
ok('only the joins are read: resign counts, ranks and alliances are not names',
    starts.map(s => s.name).join() === 'Nova,Nova,Comet,Quasar,Quasar', starts);
ok('the date and the short round name come with each join',
    starts[2].date === '2026-08-31' && starts[2].round === 'Beta 6', starts[2]);
ok('a page with no timeline (login page, error) is not an empty history',
    parseStarts({ querySelector: () => null, querySelectorAll: () => [] }) === null);
ok('a timeline with no joins is an empty history', parseStarts(page([])).length === 0);

console.log('── Old names ' + '─'.repeat(61));
const old = oldNames(starts, 'Nova');
ok('the current name is left out, the rest are newest first', old.map(n => n.name).join() === 'Comet,Quasar', old);
ok('a name used in two rounds lists both',
    old[1].uses.map(u => `${u.round} ${u.date}`).join() === 'Beta 6 2026-08-31,Beta 5 2026-05-17', old[1]);
ok('whitespace and letter case do not make the current name an old one',
    !oldNames(starts, '  nova ').some(n => n.name === 'Nova'));
ok('the newest start shows as old when the player has renamed since',
    oldNames(starts, 'Pulsar')[0].name === 'Nova', oldNames(starts, 'Pulsar'));
const rejoined = oldNames([
    { name: 'Comet', round: 'Beta 6', date: '2026-09-02' },
    { name: 'Comet', round: 'Beta 6', date: '2026-08-30' },
], 'Nova');
ok('several starts in one round are one line with the earliest date',
    rejoined.length === 1 && rejoined[0].uses.length === 1 && rejoined[0].uses[0].date === '2026-08-30', rejoined);
ok('a player who never changed name has none', oldNames([{ name: 'Nova', round: 'Beta 7', date: '' }], 'Nova').length === 0);

console.log('── The profile page ' + '─'.repeat(54));
const src = fs.readFileSync(path.join(__dirname, '../../public/js/core/page-injections.js'), 'utf8');
const lift = name => {
    const start = src.indexOf(`function ${name}(`), end = src.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate ${name}`);
    return src.slice(start, end + 2);
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const buildOldNamesTable = new Function('esc', `${lift('buildOldNamesTable')}; return buildOldNamesTable;`)(esc);
const html = buildOldNamesTable(old, 'No other names.');
ok('the list shows every old name with its rounds',
    /Comet/.test(html) && /Beta 6 \(2026-08-31\)<br>Beta 5 \(2026-05-17\)/.test(html), html);
ok('an empty list says so', /No other names\./.test(buildOldNamesTable([], 'No other names.')));
ok('names and messages are escaped',
    !/<img/.test(buildOldNamesTable([{ name: '<img src=x>', uses: [{ round: '<img>', date: '' }] }], ''))
    && !/<img/.test(buildOldNamesTable(null, '<img>')));

const buildKnownNamesTable = new Function('esc', `${lift('buildKnownNamesTable')}; return buildKnownNamesTable;`)(esc);
const knownHtml = buildKnownNamesTable([{ id: 7, name: 'Mine', addedBy: 'Me', canRemove: true }, { id: 8, name: '<img src=x>', addedBy: '<img>', canRemove: false }]);
ok('entered names show who added them, with Remove only where it is allowed',
    /added by Me/.test(knownHtml) && /data-kn-remove="7"/.test(knownHtml) && !/data-kn-remove="8"/.test(knownHtml), knownHtml);
ok('entered names are escaped', !/<img/.test(knownHtml));
ok('the add form is there when nothing is entered yet', /<form/.test(buildKnownNamesTable([])));

const wiring = lift('mountOldNames');
ok('the History page is requested through the shared gate, and only inside the tap handler',
    (src.match(/Players\/History/g) || []).length === 1
    && /async function loadHistory\(\) \{[\s\S]*?gameFetch\(`\/Game\/Players\/History\//.test(wiring)
    && (wiring.match(/loadHistory\(\)/g) || []).length === 2
    && wiring.lastIndexOf('loadHistory()') > wiring.indexOf("button.addEventListener('click'"));
const actions = lift('mountProfileActions');
ok('Old names is offered with or without live intel; the screenshot form only without',
    /if \(!hasLiveIntel\) mountManualIntelEntry\(/.test(actions) && /\n    mountOldNames\(/.test(actions));
ok('the race estimator cards are gone from the profile', !/battle-race-intel|race-estimate-card|mountBattleRaceIntel/.test(src));

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
