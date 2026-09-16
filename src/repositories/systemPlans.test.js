// system_plans: ONE evolving note per system. See database.js's schema comment for why this
// is a separate table from planet_plans rather than a reuse of it with planet_index NULL —
// this table's whole design (system_id as the PRIMARY KEY, an upsert instead of insert-many)
// depends on there being exactly one row per system, never a log of several.
//
// Run with: node src/repositories/systemPlans.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-system-plans-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const systemPlans = require('./systemPlans');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('systemPlans.test.js');

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (700, 'Testoria', 1, 1)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (900, 'AdminOne', 'x', 'admin')`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (901, 'AdminTwo', 'x', 'admin')`).run();

console.log('\n── A system with no plan yet ' + '─'.repeat(46));
{
    ok('getSystemPlan returns null, not an empty object', systemPlans.getSystemPlan(700) === null);
    ok('deleting a plan that was never written is a no-op, not a crash',
        systemPlans.deleteSystemPlan(700) === false);
}

console.log('\n── Writing it for the first time ' + '─'.repeat(41));
{
    const plan = systemPlans.upsertSystemPlan(700, 'Hold the line, colony ships incoming.', 900);
    ok('the note comes back', plan.note === 'Hold the line, colony ships incoming.', plan);
    ok('author is the writer', plan.author_name === 'AdminOne', plan);
    // last_edited_by IS populated on a fresh write too (set to the writer, same as author_id)
    // — that is an internal bookkeeping detail, not something a caller should read. The
    // presentation layer (discord_bot.js's buildSystemPlanMessage) never shows an "edited
    // by" line unless was_edited is true, which is the only field this test asserts on.
    ok('was_edited is false on a fresh write', plan.was_edited === false, plan);
}

console.log('\n── Editing it ' + '─'.repeat(61));
{
    // Force a real gap so this can never pass by same-second CURRENT_TIMESTAMP coincidence —
    // same defensive pattern as the population-regrowth-guard regression test.
    db.prepare(`UPDATE system_plans SET created_at = datetime(created_at, '-1 minute') WHERE system_id = 700`).run();

    const plan = systemPlans.upsertSystemPlan(700, 'Hold the line, colony ships incoming. UPDATE: reinforced.', 901);
    ok('the note is replaced', plan.note.includes('reinforced'), plan);
    ok('the ORIGINAL author is preserved across the edit — upsert must never touch author_id',
        plan.author_name === 'AdminOne', plan);
    ok('the editor is whoever just wrote it, which can differ from the author',
        plan.last_edited_by_name === 'AdminTwo', plan);
    ok('was_edited is now true', plan.was_edited === true, plan);
}

console.log('\n── A same-second edit is still detected as an edit ' + '─'.repeat(21));
{
    // The regression this guards: was_edited started out comparing created_at to updated_at,
    // and SQLite's CURRENT_TIMESTAMP has only one second of resolution — an edit landing in
    // the same wall-clock second as the original write would read the two timestamps as
    // equal and be silently reported as unedited. edit_count sidesteps that: it only ever
    // moves on a real UPDATE, so this needs no artificial delay to catch a regression back
    // to the timestamp comparison, unlike the "Editing it" section above.
    db.prepare(`DELETE FROM system_plans WHERE system_id = 700`).run();
    const created = systemPlans.upsertSystemPlan(700, 'v1', 900);
    ok('a genuinely fresh write is not mistaken for an edit', created.was_edited === false, created);
    const editedSameSecond = systemPlans.upsertSystemPlan(700, 'v2', 901);
    ok('but immediately overwriting it IS an edit, even inside the same wall-clock second',
        editedSameSecond.was_edited === true, editedSameSecond);
}

console.log('\n── Deleting it ' + '─'.repeat(60));
{
    const removed = systemPlans.deleteSystemPlan(700);
    ok('reports that a row actually went away', removed === true, removed);
    ok('and it is really gone', systemPlans.getSystemPlan(700) === null);
}

console.log('\n── An author account that no longer exists ' + '─'.repeat(31));
{
    // ON DELETE SET NULL, same attribution model planet_plans already uses (see
    // database.js) — losing an account must not lose the plan or corrupt the row.
    db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (902, 'Departing', 'x', 'admin')`).run();
    systemPlans.upsertSystemPlan(700, 'Written by someone who later left.', 902);
    db.prepare(`DELETE FROM app_users WHERE id = 902`).run();

    const plan = systemPlans.getSystemPlan(700);
    ok('the plan survives its author leaving', plan && plan.note.includes('later left'), plan);
    ok('the author name reads as unknown rather than throwing or vanishing',
        plan.author_name === null, plan);
}

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
