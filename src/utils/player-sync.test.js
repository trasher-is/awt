// The restart-reset in POST /sync/player must never destroy intel-derived data.
//
// Run with:  node src/utils/player-sync.test.js
//
// Issues #46/#48: a false-positive restart detection once zeroed a player's race picks.
// The rule this suite locks in: the restart-reset UPDATE may only clear columns the upsert
// writes UNCONDITIONALLY (public stats); everything governed by the `has_intel` CASE guard
// (sciences per field, race picks, artefact, eco bonus, has_intel, intel_updated_at) is out
// of its reach, so a misfiring heuristic can no longer erase hard-won intel. This is a
// source-scan because the property is about which columns the statement names — it cannot be
// probed without a live restart against a real scraped payload.

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const src = readCode('src/routes/sync.js');

// Isolate the restart-reset UPDATE: from the DELETE FROM fleets that opens the block to the
// WHERE id = ? that closes its UPDATE.
const resetStart = src.indexOf('DELETE FROM fleets WHERE owner_id = ?');
ok('the restart-reset block exists', resetStart !== -1);
const updateStart = src.indexOf('UPDATE players SET', resetStart);
const updateEnd = src.indexOf('WHERE id = ?', updateStart);
ok('the reset UPDATE exists', updateStart !== -1 && updateEnd !== -1);
const resetUpdate = src.slice(updateStart, updateEnd);

// Intel-derived columns — governed ONLY by the has_intel CASE guard. None may appear as an
// assignment target inside the reset UPDATE.
const intelColumns = [
    'biology', 'economy', 'energy', 'mathematics', 'physics', 'social',
    'trade_revenue', 'artefact', 'eco_bonus',
    'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed',
    'race_attack', 'race_defense', 'race_trader', 'race_sul',
    'has_intel', 'intel_updated_at',
];
for (const col of intelColumns) {
    ok(`reset does not touch intel-derived column: ${col}`,
        !new RegExp(`\\b${col}\\s*=`).test(resetUpdate), col);
}

// The reset MUST still clear the volatile public stats (otherwise it does nothing useful),
// and origin_system in particular must reset so the originChanged signal re-arms.
for (const col of ['level', 'points', 'ranking', 'origin_system', 'total_planets', 'cv_limit']) {
    ok(`reset still clears public stat: ${col}`,
        new RegExp(`\\b${col}\\s*=`).test(resetUpdate), col);
}

// The has_intel CASE guard on the upsert is the load-bearing preservation mechanism — if it
// were ever removed, the reset restraint above would be moot.
ok('the upsert still guards intel columns behind excluded.has_intel = 1',
    /race_speed\s*=\s*CASE WHEN excluded\.has_intel = 1/.test(src)
    && /has_intel\s*=\s*CASE WHEN excluded\.has_intel = 1 THEN 1 ELSE players\.has_intel END/.test(src));

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
