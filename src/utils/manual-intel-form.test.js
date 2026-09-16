// The screenshot-entry form's layout and read-back.
//
// Context (2026-09-16): an ally sent us a screenshot of their own Intelligence Report on a
// player we have no vision of. Typing it straight into the database by hand worked, but left
// no trace that the numbers were never ours — and they land in the same columns the threat
// matrix, the battle calculator and !bio read. This form is the supported way to do it, and
// the source field is the reason it exists at all.
//
// Run with: node src/utils/manual-intel-form.test.js

const { buildManualIntelFormHtml, readManualIntelForm, SCIENCE_FIELDS, RACE_FIELDS } =
    require('../../public/js/utils/manual-intel-form.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// Just enough of a DOM for readManualIntelForm, which only ever does querySelector on
// [data-mi="..."] and reads .value. Parsing the real HTML would test jsdom, not this.
function fakeForm(values) {
    return {
        querySelector(sel) {
            const m = /\[data-mi="([^"]+)"\]/.exec(sel);
            if (!m) return null;
            return Object.prototype.hasOwnProperty.call(values, m[1]) ? { value: values[m[1]] } : null;
        },
    };
}

console.log('manual-intel-form.test.js');

console.log('\n── The form mirrors the game\'s own report ' + '─'.repeat(34));
{
    const html = buildManualIntelFormHtml({});
    for (const f of [...SCIENCE_FIELDS, ...RACE_FIELDS]) {
        if (!html.includes(`data-mi="${f.field}"`)) { ok(`has an input for ${f.field}`, false); }
    }
    ok('every science and race trait the report shows has an input',
        [...SCIENCE_FIELDS, ...RACE_FIELDS].every(f => html.includes(`data-mi="${f.field}"`)));
    ok('plus trade revenue, artefact and the source', ['trade_revenue', 'artefact', 'source']
        .every(f => html.includes(`data-mi="${f}"`)));

    // race_trader and race_sul are real columns, but the game's Race Summary does not show
    // them — so a screenshot cannot contain them and the form must not invite a guess.
    ok('but NOT trader or SUL, which no screenshot can show',
        !html.includes('data-mi="race_trader"') && !html.includes('data-mi="race_sul"'));

    ok('science inputs are bounded at 0, race picks allow negatives',
        /data-mi="biology"[^>]*min="0"/.test(html) && /data-mi="race_growth"[^>]*min="-10"/.test(html), html.slice(0, 200));
}

console.log('\n── It prefills, so one wrong number is a one-field fix ' + '─'.repeat(22));
{
    const html = buildManualIntelFormHtml({
        biology: 8, social: 10, race_speed: 2, race_growth: -2,
        artefact: 'Relic', intel_source: 'screenshot from Glutus [PUNK]',
    });
    ok('existing values come back in their boxes',
        /data-mi="biology"[^>]*value="8"/.test(html) && /data-mi="race_growth"[^>]*value="-2"/.test(html));
    ok('including the artefact and the previous source',
        html.includes('value="Relic"') && html.includes('screenshot from Glutus [PUNK]'));

    // A source is free text typed by a member and rendered straight back into the page.
    const nasty = buildManualIntelFormHtml({ intel_source: '"><script>alert(1)</script>' });
    ok('a source containing markup is escaped, not executed',
        !nasty.includes('<script>') && nasty.includes('&lt;script&gt;'), nasty.slice(0, 160));
}

console.log('\n── Reading it back ' + '─'.repeat(56));
{
    const values = { source: '  screenshot from Glutus [PUNK]  ', artefact: ' Relic ', trade_revenue: '0' };
    for (const f of SCIENCE_FIELDS) values[f.field] = '6';
    for (const f of RACE_FIELDS) values[f.field] = '-2';
    const body = readManualIntelForm(fakeForm(values), 415);

    ok('the player id travels with it', body.player_id === 415);
    ok('numbers are sent as numbers, not strings',
        body.biology === 6 && body.race_growth === -2 && body.trade_revenue === 0, body);
    ok('the source is trimmed', body.source === 'screenshot from Glutus [PUNK]', body.source);

    // The game prints a real 0 for an unresearched science or an untaken trait, so a member
    // leaving the box empty means zero. Dropping the key instead would fail validation
    // server-side and complain about a field they deliberately left alone.
    const blanks = { source: 'x', artefact: '', trade_revenue: '' };
    for (const f of [...SCIENCE_FIELDS, ...RACE_FIELDS]) blanks[f.field] = '';
    const blankBody = readManualIntelForm(fakeForm(blanks), 1);
    ok('a blank box reads as 0 rather than going missing',
        [...SCIENCE_FIELDS, ...RACE_FIELDS].every(f => blankBody[f.field] === 0)
        && blankBody.trade_revenue === 0, blankBody);
    ok('an empty artefact stays empty for the server to read as "none"', blankBody.artefact === '');
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
