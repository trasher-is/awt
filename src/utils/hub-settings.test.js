// public/js/utils/hub-settings.js — what a member can switch on or off, and how it is stored.
//
// Two halves. The first drives the rules directly (defaults, what is stored, how a change
// merges). The second scans source, because the catalogue is only worth anything if the
// rest of the hub is actually wired to it: every sidebar tool has a button, every extra is
// gated in spy.js, and nothing new slips in ungated unnoticed.
//
// Run with: node src/utils/hub-settings.test.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const S = require(path.join(ROOT, 'public', 'js', 'utils', 'hub-settings.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('hub-settings.test.js');

// ─── THE CATALOGUE ────────────────────────────────────────────────────────────
console.log('\n── Catalogue ' + '─'.repeat(62));
const keys = S.ALL.map(i => i.key);
ok('every key is unique', new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i));
ok('keys are boring (letters, digits, one dot) — they land in JSON and the database', keys.every(k => /^(tool|inject)\.[A-Za-z0-9]+$/.test(k)), keys);
ok('every item says whether it starts on', S.ALL.every(i => typeof i.defaultOn === 'boolean'));
ok('every injection belongs to a declared group', S.INJECTIONS.every(i => S.GROUPS.some(g => g.id === i.group)), S.INJECTIONS.filter(i => !S.GROUPS.some(g => g.id === i.group)).map(i => i.key));
ok('every declared group has at least one injection', S.GROUPS.every(g => S.INJECTIONS.some(i => i.group === g.id)));
ok('every injection has a label and a description a member can read', S.INJECTIONS.every(i => i.label && i.description && i.description.length > 10));
ok('every tool has a label, an icon and a button id', S.TOOLS.every(t => t.label && /^fa-/.test(t.icon) && /^open-[a-z-]+-btn$/.test(t.button)));

// The four tools the operator asked to start switched off, and nothing else.
const offByDefault = S.ALL.filter(i => !i.defaultOn).map(i => i.key).sort();
ok('exactly Battle Calc, Road to TA, Build Order and Empire Simulator start off',
    same(offByDefault, ['tool.battleCalc', 'tool.buildOrder', 'tool.empireSim', 'tool.roadToTa']), offByDefault);
ok('every game-page extra starts on, so nobody loses a feature by upgrading', S.INJECTIONS.every(i => i.defaultOn));

// ─── RESOLVING ────────────────────────────────────────────────────────────────
console.log('\n── Resolving ' + '─'.repeat(62));
const none = S.resolve({});
ok('nothing stored means every default', S.ALL.every(i => none[i.key] === i.defaultOn));
ok('resolve covers every key', same(Object.keys(none).sort(), keys.slice().sort()));
ok('resolve tolerates null and undefined', same(S.resolve(null), none) && same(S.resolve(undefined), none));
const mine = S.resolve({ 'inject.suButtons': false, 'tool.battleCalc': true });
ok('a stored false switches an extra off', mine['inject.suButtons'] === false);
ok('a stored true switches an off-by-default tool on', mine['tool.battleCalc'] === true);
ok('everything else keeps its default', mine['inject.buildingHints'] === true && mine['tool.roadToTa'] === false);
ok('isEnabled agrees with resolve', S.isEnabled('inject.suButtons', { 'inject.suButtons': false }) === false && S.isEnabled('tool.roadToTa', {}) === false && S.isEnabled('inject.suButtons', {}) === true);
ok('an unknown key reads as ON — a typo at a call site must not quietly remove a feature', S.isEnabled('inject.doesNotExist', {}) === true);
ok('a stored non-boolean is ignored, not coerced', S.isEnabled('inject.suButtons', { 'inject.suButtons': 'false' }) === true && S.isEnabled('inject.suButtons', { 'inject.suButtons': 0 }) === true);

// ─── WHAT IS STORED ───────────────────────────────────────────────────────────
console.log('\n── Storing only the difference ' + '─'.repeat(44));
ok('sanitize keeps a real difference', same(S.sanitizeOverrides({ 'inject.suButtons': false }), { 'inject.suButtons': false }));
ok('sanitize drops a value equal to its default', same(S.sanitizeOverrides({ 'inject.suButtons': true, 'tool.battleCalc': false }), {}));
ok('sanitize drops unknown keys (a later release may remove one)', same(S.sanitizeOverrides({ 'inject.gone': false, 'inject.suButtons': false }), { 'inject.suButtons': false }));
ok('sanitize drops non-boolean values', same(S.sanitizeOverrides({ 'inject.suButtons': 'no', 'inject.popTimers': null }), {}));
ok('sanitize survives junk input', ['x', 5, null, undefined, [], [1, 2]].every(v => same(S.sanitizeOverrides(v), {})));
ok('sanitize does not hand back the object it was given', (() => { const raw = { 'inject.suButtons': false }; const out = S.sanitizeOverrides(raw); out['inject.popTimers'] = false; return !('inject.popTimers' in raw); })());

ok('parseStored reads what was stored', same(S.parseStored('{"inject.suButtons":false}'), { 'inject.suButtons': false }));
ok('parseStored treats null, empty and corrupt text as nothing stored', [null, undefined, '', '{', 'not json', '[1]', '5', 'null'].every(v => same(S.parseStored(v), {})));

const afterOff = S.applyChanges({}, { 'inject.suButtons': false });
ok('a change away from the default is stored', same(afterOff, { 'inject.suButtons': false }));
ok('a change back to the default removes it, leaving nothing', same(S.applyChanges(afterOff, { 'inject.suButtons': true }), {}));
ok('changes merge into what is stored rather than replacing it',
    same(S.applyChanges({ 'inject.suButtons': false }, { 'tool.battleCalc': true }), { 'inject.suButtons': false, 'tool.battleCalc': true }));
ok('unknown keys in a change are ignored', same(S.applyChanges({}, { 'inject.gone': false }), {}));
ok('applyChanges does not mutate its input', (() => { const base = { 'inject.suButtons': false }; S.applyChanges(base, { 'inject.popTimers': false }); return same(base, { 'inject.suButtons': false }); })());

ok('a well-formed change payload has no problem', S.invalidChanges({ 'inject.suButtons': false }) === null);
ok('an empty change payload is allowed', S.invalidChanges({}) === null);
ok('unknown keys are not a problem — a stale tab can send one', S.invalidChanges({ 'inject.gone': true }) === null);
ok('a non-boolean value is a problem', /must be true or false/.test(S.invalidChanges({ 'inject.suButtons': 'false' })));
ok('a non-object payload is a problem', [null, undefined, 'x', 5, [], [true]].every(v => typeof S.invalidChanges(v) === 'string'));

// ─── THE REST OF THE HUB IS WIRED TO IT ───────────────────────────────────────
console.log('\n── Sidebar buttons ' + '─'.repeat(56));
const wrapper = read('public/Wrapper.html');
const countId = id => (wrapper.match(new RegExp(`id="${id}"`, 'g')) || []).length;
for (const t of S.TOOLS) ok(`${t.label}: exactly one #${t.button} in Wrapper.html`, countId(t.button) === 1, countId(t.button));

// A new sidebar tool that nobody adds to the catalogue could never be switched off.
const openButtons = [...wrapper.matchAll(/id="(open-[a-z-]+-btn)"/g)].map(m => m[1]);
const unmanaged = openButtons.filter(id => id !== 'open-settings-btn' && !S.TOOLS.some(t => t.button === id));
ok('every sidebar tool button is in the catalogue (or is Settings itself)', unmanaged.length === 0, unmanaged);
ok('Settings, Link Discord and Logout can never be hidden', !S.ALL.some(i => /settings|discord|logout|admin/i.test(i.key) || /open-settings-btn|link-discord-btn|logout-btn|admin-panel-btn/.test(i.button || '')));
ok('the Settings button sits under Link Discord and its code box', (() => {
    const box = wrapper.indexOf('id="link-discord-box"');
    const settings = wrapper.indexOf('id="open-settings-btn"');
    return box > 0 && settings > box;
})());
ok('the dashboard opens the panel from that button', /getElementById\('open-settings-btn'\)\?\.addEventListener\('click', openSettingsPanel\)/.test(read('public/js/ui/dashboard.js')));

console.log('\n── Game-page hooks (spy.js) ' + '─'.repeat(47));
// Full-line and block comments stripped, so prose explaining a rule cannot trip a scan.
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const spy = strip(read('public/js/core/spy.js'));
const start = spy.indexOf('function runViewHooks()');
const end = spy.indexOf('function onNavigate()');
const hooks = spy.slice(start, end);
ok('located the view-hook pass', start > 0 && end > start);

// Which game-page function each switch controls. The call and its `enabled('…')` must be on
// the same line, so a gate can never drift away from the thing it gates.
const GATES = {
    'inject.suButtons': 'initSupplyUnitButtons',
    'inject.buildingHints': 'initBuildingValueHints',
    'inject.starbaseTimer': 'initStarbaseTimer',
    'inject.autoProduceDates': 'initAutoProduceFinishDates',
    'inject.popTimers': 'initPlanetPopTimers',
    'inject.cultureLookahead': 'initScienceCultureCalc',
    'inject.scienceTimers': 'initScienceTimers',
    'inject.scienceCalculator': 'initScienceLevelCalculator',
    'inject.colonizeWindows': 'initColonizeLaunchWindows',
    'inject.socialHint': 'initSocialHint',
    'inject.economyMilestone': 'initEconomyMilestone',
    'inject.bioThreats': 'initBioThreatPills',
    'inject.fleetTimers': 'initFleetTimers',
    'inject.launchEta': 'initFleetLaunchModalETA',
    'inject.launchDossier': 'initFleetLaunchTargetDossier',
    'inject.launchPlanLinks': 'initLaunchPlanLinks',
    'inject.systemPlan': 'initSystemPlan',
    'inject.newsBroadcasts': 'initAllianceNewsAlerts',
    'inject.profilePlGrowth': 'initProfilePLGrowth',
    'inject.profileIntel': 'initProfileHubIntel',
    'inject.ecoBonusJoined': 'initEcoBonusJoinDates',
    'inject.localTimestamps': 'initLocalGameTimestamps',
    'inject.allianceIcons': 'initAllianceRelationIcons',
};
ok('the gate table covers exactly the catalogue\'s injections', same(Object.keys(GATES).sort(), S.INJECTIONS.map(i => i.key).sort()),
    { missing: S.INJECTIONS.map(i => i.key).filter(k => !GATES[k]), extra: Object.keys(GATES).filter(k => !keys.includes(k)) });

const lines = hooks.split('\n');
for (const [key, fn] of Object.entries(GATES)) {
    const gated = lines.filter(l => l.includes(`enabled('${key}')`));
    ok(`${key} gates ${fn}() on one line, once`, gated.length === 1 && gated[0].includes(`${fn}(`), gated);
}

const usedKeys = [...spy.matchAll(/enabled\('([^']+)'\)/g)].map(m => m[1]);
ok('spy.js only asks about keys the catalogue knows', usedKeys.every(k => keys.includes(k)), usedKeys.filter(k => !keys.includes(k)));

// What stays ungated must be a deliberate, named list: these feed the alliance's shared data.
const UNGATED_ON_PURPOSE = ['injectMapIndicators', 'initNewsIncomingTools', 'initNewsBattleEvents'];
// Every hook call on every line (a second call sharing a gated line must not hide), and it
// counts as gated only when the key on its own line is the one the table pairs it with.
const ungated = [];
for (const line of lines) {
    for (const m of line.matchAll(/\b((?:init|inject)[A-Z]\w*)\(/g)) {
        const gatedHere = Object.entries(GATES).some(([key, fn]) => fn === m[1] && line.includes(`enabled('${key}')`));
        if (!gatedHere) ungated.push(m[1]);
    }
}
ok('the only ungated hooks are the data feeds, by name', same(ungated.slice().sort(), UNGATED_ON_PURPOSE.slice().sort()), ungated);
ok('hooks wait for the settings before running', /if \(!settingsReady\(\)\) return;/.test(hooks));
ok('a change to a setting runs another pass', /onSettingsChange\(\(\) => scheduleViewHooks\(0\)\)/.test(spy));
ok('the first pass waits for the settings (capped, so scrapes never hang on a preference)', /whenSettingsReady\(\)\.then\(runViewHooks\)/.test(spy));

console.log('\n── Never offered, never gated ' + '─'.repeat(45));
// The Supply Unit feature's own boundaries live in su-spend-buttons.test.js; here, only that
// switching it off is the one thing this change adds, and it adds no way to act without a tap.
const suSrc = strip(read('public/js/core/su-spend-buttons.js'));
ok('su-spend-buttons.js does not read settings itself (the gate is spy.js\'s, in one place)', !/hub-settings/.test(suSrc));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
