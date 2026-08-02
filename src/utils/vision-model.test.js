// The vision rule, the galaxy-map endpoint's contract, and the promise the Galaxy Archive
// panel makes about what it is showing.
//
// Run with:  node src/utils/vision-model.test.js
//
// The rule matters because it was written twice and the copies disagreed, so the tests
// below are as much about "there is one of these" as about the arithmetic.

const path = require('path');
const fs = require('fs');
const V = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'vision-model.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const read = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

// Comments are stripped before a source scan. Without this, a comment explaining what a
// rule USED to be trips the very assertion checking that the rule is gone — which is a
// test failing on its own documentation, and it caught exactly that here.
const readCode = rel => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

(async () => {
    console.log('── The radius rule matches !vision, which is the one that matches the game ' + '─'.repeat(1));
    ok('biology is used when we have it', V.visionRadius({ biology: 7, science_level: 3 }) === 7);
    ok('science level is the fallback when biology has never been scraped',
        V.visionRadius({ biology: 0, science_level: 4 }) === 4);
    ok('and it is the fallback for a missing biology field too',
        V.visionRadius({ science_level: 4 }) === 4);
    ok('with neither, everyone still sees their own system', V.visionRadius({}) === 1);
    ok('a nonsense biology does not become a radius',
        V.visionRadius({ biology: 'lots', science_level: 2 }) === 2);
    ok('no player at all is no vision', V.visionRadius(null) === 0);

    ok('a fallback radius is flagged as not measured',
        V.radiusIsMeasured({ biology: 5 }) === true && V.radiusIsMeasured({ biology: 0, science_level: 9 }) === false);

    console.log('\n── Distance to biology rounds up, the same way !dist does ' + '─'.repeat(18));
    ok('an exact distance needs exactly that much biology', V.bioNeededFor(3) === 3);
    ok('a fractional distance rounds up', V.bioNeededFor(3.01) === 4 && V.bioNeededFor(2.5) === 3);
    ok('zero distance needs nothing', V.bioNeededFor(0) === 0);
    ok('3-4-5 triangle', V.systemDistance(0, 0, 3, 4) === 5);
    ok('vision reaches exactly to the rounded-up requirement',
        V.hasVision(5, 5) === true && V.hasVision(4, 5) === false);

    console.log('\n── Coverage over a galaxy ' + '─'.repeat(50));
    const systems = [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 3, y: 4 },     // distance 5 from origin
        { id: 3, x: 10, y: 10 },   // far
        { id: 4, x: 1, y: 0 },
    ];
    const observers = [
        { playerId: 100, name: 'Close',   biology: 5, science_level: 9, x: 0, y: 0 },
        { playerId: 101, name: 'Blind',   biology: 0, science_level: 1, x: 0, y: 0 },
        { playerId: 102, name: 'NoOrigin', biology: 9, science_level: 9, x: null, y: null },
    ];
    const cov = V.coverage(observers, systems);
    ok('a system at exactly the radius is covered', (cov.get(2) || []).some(o => o.playerId === 100));
    ok('a system beyond it is not', !(cov.get(3) || []).some(o => o.playerId === 100));
    ok('the fallback observer still covers its own system', (cov.get(1) || []).some(o => o.playerId === 101));
    ok('an observer with no origin coordinates is skipped rather than placed at 0,0',
        ![...cov.values()].flat().some(o => o.playerId === 102));
    ok('observers are ordered by how much margin they have',
        (cov.get(1) || []).map(o => o.playerId).join(',') === '100,101', (cov.get(1) || []).map(o => o.playerId));
    ok('each entry carries what was needed, so the panel can show the margin',
        (cov.get(2) || [])[0].needed === 5);
    ok('and whether the radius was measured or guessed',
        (cov.get(1) || []).find(o => o.playerId === 101).measured === false);
    ok('a system with no coordinates is not silently placed at the origin',
        V.coverage(observers, [{ id: 9, x: null, y: null }]).size === 0);

    console.log('\n── There is exactly ONE copy of the rule ' + '─'.repeat(35));
    // This is the bug the module exists to close: !vision fell back to science_level and
    // the dashboard overlay did not, so members with an unscraped biology were reported as
    // seeing a system on Discord and were missing from the overlay at the same time.
    const dashboard = readCode('public/js/ui/dashboard.js');
    ok('the dashboard overlay asks the model instead of spelling the rule out',
        /visionRadius\(p\)/.test(dashboard) && !/p\.biology > 0/.test(dashboard));
    ok('and it no longer drops members whose biology is 0',
        !/biology > 0[\s\S]{0,200}range: p\.biology/.test(dashboard));

    const mapUi = readCode('public/js/ui/galaxy-map.js');
    ok('the map uses the shared model too',
        /vision-model\.js/.test(mapUi) && /AWVision/.test(mapUi));
    ok('and does not carry its own radius arithmetic',
        !/biology\s*[>?]/.test(mapUi.replace(/\/\/.*$/gm, '')));

    console.log('\n── The endpoint hands over facts, not a rendered opinion ' + '─'.repeat(19));
    const intel = readCode('src/routes/intel.js');
    ok('a galaxy-map endpoint exists', /router\.get\('\/intel\/galaxy-map'/.test(intel));
    ok('it sends raw biology and science level rather than a precomputed radius',
        /p\.biology, p\.science_level/.test(intel) && !/visionRadius/.test(intel));
    ok('it reports how much of the galaxy has actually been scanned',
        /systemsScanned/.test(intel) && /systemsKnown/.test(intel));
    ok('it only ships systems that have coordinates',
        /s\.x IS NOT NULL AND s\.y IS NOT NULL/.test(intel));
    ok('it separates planets seen to be free from planets whose owner is unknown to us',
        /free_planets/.test(intel) && /unaligned/.test(intel));

    console.log('\n── The panel says what it does not know ' + '─'.repeat(36));
    // A map that draws an unscanned system the same as an empty one turns a gap in our
    // intel into a claim about the galaxy. That distinction is the whole product.
    const html = read('public/components/galaxy-map.html');
    ok('the vision layer is labelled as modelled, not observed', /\(modelled\)/.test(html));
    ok('the panel has a coverage line', /id="gm-coverage"/.test(html));
    ok('unscanned systems are drawn hollow, not filled',
        /if \(!system\.known\) return null;/.test(mapUi));
    ok('the coverage line names the gap out loud',
        /never visited/.test(mapUi) && /gaps in our intel/.test(mapUi));
    ok('the tooltip distinguishes never-scanned from scanned-and-empty',
        /Never scanned/.test(mapUi));
    ok('a guessed radius is marked in the tooltip',
        /biology never scraped/.test(mapUi));

    console.log('\n── The map is drawn from our own archive, never from the game ' + '─'.repeat(14));
    // If this panel ever fetched the game directly it would need the rate gate, a session,
    // and the administrator's agreement. It fetches the hub and nothing else.
    const fetches = [...mapUi.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map(m => m[1]);
    ok('every fetch goes to the hub', fetches.every(u => u.startsWith('/hub-api/') || u.startsWith('/hub-assets/')), fetches);
    ok('no game paths are referenced except the System Intel navigation',
        (mapUi.match(/\/Game\//g) || []).length === 1, (mapUi.match(/\/Game\/[^`'"]*/g) || []));
    ok('and that navigation sets the iframe rather than fetching',
        /frame\.src = `\/Game\/Map\/SolarSystem\//.test(mapUi));

    console.log('\n── Layer choices survive a reload, per member ' + '─'.repeat(31));
    ok('preferences are keyed by user id', /PREFS_KEY\}\.\$\{userId/.test(mapUi));
    ok('a storage failure degrades to defaults instead of breaking the panel',
        /catch \(err\)[\s\S]{0,160}return \{ \.\.\.DEFAULT_LAYERS \}/.test(mapUi));
    ok('the vision layer is off by default — it is a model, not a reading',
        /vision: false/.test(mapUi));

    console.log('\n── Every element the panel reaches for actually exists ' + '─'.repeat(21));
    // There is no browser in CI, so a mistyped id would fail silently at runtime: the
    // optional-chaining listeners simply never attach and the button does nothing. This is
    // the cheapest way to catch that without one.
    const wrapper = read('public/Wrapper.html');
    const idsIn = src => new Set([...src.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const panelIds = idsIn(html);
    const wrapperIds = idsIn(wrapper);

    const queried = [...new Set([...mapUi.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
    const missing = queried.filter(id => !panelIds.has(id) && !wrapperIds.has(id));
    ok('every id the map queries is defined in its component or in Wrapper.html', missing.length === 0, missing);
    ok('and it queries a sensible number of them, so the scan is not vacuous', queried.length >= 8, queried.length);

    // The layer names are the single source of truth: DEFAULT_LAYERS drives the loop that
    // attaches the listeners, so a layer without a checkbox is a dead entry and a checkbox
    // without a layer is a control that does nothing.
    const declared = [...(mapUi.match(/const DEFAULT_LAYERS = \{[\s\S]*?\};/) || [''])[0]
        .matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]);
    ok('DEFAULT_LAYERS was found and is not empty', declared.length >= 4, declared);
    ok('a checkbox exists for every declared layer',
        declared.every(k => panelIds.has(`gm-layer-${k}`)), declared.filter(k => !panelIds.has(`gm-layer-${k}`)));
    ok('and no checkbox exists for a layer nothing declares',
        [...panelIds].filter(id => id.startsWith('gm-layer-')).every(id => declared.includes(id.replace('gm-layer-', ''))),
        [...panelIds].filter(id => id.startsWith('gm-layer-') && !declared.includes(id.replace('gm-layer-', ''))));
    ok('the listeners are attached by iterating those names, not one at a time',
        /for \(const key of Object\.keys\(DEFAULT_LAYERS\)\)/.test(mapUi));

    ok('the sidebar button exists in Wrapper.html', wrapperIds.has('open-galaxy-map-btn'));
    ok('and the dashboard listens for exactly that id',
        /getElementById\('open-galaxy-map-btn'\)/.test(dashboard));
    ok('the panel is registered with the other panels so opening one closes it',
        /'galaxy-map-panel'/.test(readCode('public/js/ui/archives.js')));

    console.log('\n── The seed script cannot touch real data by accident ' + '─'.repeat(22));
    const seed = readCode('scripts/seed-dev-galaxy.js');
    ok('it refuses to run against a database that already has rows', /--force/.test(seed) && /isEmpty\(\)/.test(seed));
    ok('it is deterministic, so a screenshot stays valid', /makeRandom\(/.test(seed) && !/Math\.random\(\)/.test(seed));
    ok('it invents every name rather than copying anyone real', /Synth/.test(seed));
    ok('it deliberately leaves systems unscanned so the gap is visible',
        /SCANNED_SHARE/.test(seed));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
