// The screenshot-entry form's layout and read-back.
//
// Context (2026-09-16): an ally sent us a screenshot of their own Intelligence Report on a
// player we have no vision of. Typing it straight into the database by hand worked, but left
// no trace that the numbers were never ours — and they land in the same columns the threat
// matrix, the battle calculator and !bio read. This form is the supported way to do it, and
// the source field is the reason it exists at all.
//
// Run with: node src/utils/manual-intel-form.test.js

const { buildManualIntelFormHtml, readManualIntelForm, racePointTotal, SCIENCE_FIELDS, RACE_FIELDS, TOGGLE_FIELDS } =
    require('../../public/js/utils/manual-intel-form.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// Just enough of a DOM for readManualIntelForm, which only ever does querySelector on
// [data-mi="..."] and reads .value. Parsing the real HTML would test jsdom, not this.
// `values` are the text boxes; `checks` are the toggle checkboxes, which the reader asks
// for `.checked` rather than `.value`.
function fakeForm(values, checks = {}) {
    return {
        querySelector(sel) {
            const m = /\[data-mi="([^"]+)"\]/.exec(sel);
            if (!m) return null;
            const name = m[1];
            if (Object.prototype.hasOwnProperty.call(checks, name)) return { checked: !!checks[name] };
            return Object.prototype.hasOwnProperty.call(values, name) ? { value: values[name] } : null;
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

    // This assertion used to read "but NOT trader or SUL, which no screenshot can show",
    // and it was wrong — it encoded the bug rather than catching it. The Race Summary DOES
    // print "Trader +6" next to the seven traits (confirmed from a member's screenshot of
    // Ikki [ZOD], 2026-09-23), player-parser.js has always read both toggles from that same
    // block, and the omission left a manually entered trader stored as race_trader = 0,
    // which is what routes/trade.js checks to decide who can accept an agreement for free.
    ok('trader and SUL are on the form too — the Race Summary shows them',
        html.includes('data-mi="race_trader"') && html.includes('data-mi="race_sul"'), html.slice(0, 0));
    ok('they are checkboxes, not number boxes — a toggle cannot be "Trader 3"',
        /data-mi="race_trader"[^>]*type="checkbox"|type="checkbox"[^>]*data-mi="race_trader"/.test(html)
        || /<input type="checkbox" data-mi="race_trader"/.test(html), html.match(/[^>]*race_trader[^>]*/)?.[0]);
    ok('each toggle states the point cost the game charges for it',
        html.includes('costs 6') && html.includes('costs 1'));
    ok('a player already on record as a trader has the box ticked',
        buildManualIntelFormHtml({ race_trader: 6 }).match(/data-mi="race_trader"[^>]*checked/) !== null,
        buildManualIntelFormHtml({ race_trader: 6 }).match(/[^>]*race_trader[^>]*/)?.[0]);
    ok('and one who is not, does not',
        buildManualIntelFormHtml({ race_trader: 0 }).match(/data-mi="race_trader"[^>]*checked/) === null);

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

// --- Reading the toggles back --------------------------------------------------
// A checkbox sends the documented COST, not a 1, so a manually entered trader is
// indistinguishable downstream from a scraped one — which is the whole point, since
// routes/trade.js asks `race_trader > 0` and the trade panel believed the 0.
{
    const ticked = fakeForm({}, { race_trader: true, race_sul: true });
    const body = readManualIntelForm(ticked, 42);
    ok('a ticked Trader box sends its cost of 6', body.race_trader === 6, body.race_trader);
    ok('a ticked SUL box sends its cost of 1', body.race_sul === 1, body.race_sul);

    const unticked = fakeForm({}, { race_trader: false, race_sul: false });
    const off = readManualIntelForm(unticked, 42);
    ok('an unticked toggle sends 0, not nothing', off.race_trader === 0 && off.race_sul === 0, off);
}

// --- The game's own consistency rule -------------------------------------------
// (sum of the 7 picks) + (1 if SUL) + (6 if Trader) = 0, per docs/game-rules.md. Ikki
// [ZOD]'s real race from the screenshot that prompted this fix: the seven picks sum to -6
// and Trader's cost of 6 balances it. Without the Trader box the form reads -6 — which is
// exactly the signal that something is missing, and why this is worth showing.
{
    const ikki = { race_growth: -3, race_science: -1, race_culture: 0, race_production: 4,
        race_speed: -4, race_attack: -2, race_defense: 0 };
    ok('a real race with its trader balances to zero', racePointTotal({ ...ikki, race_trader: 6 }) === 0);
    ok('the same race with the trader missed reads -6, not 0', racePointTotal(ikki) === -6, racePointTotal(ikki));
    ok('SUL costs one', racePointTotal({ race_growth: -1, race_sul: 1 }) === 0);
    ok('a toggle counts its cost once, however the stored value got there',
        racePointTotal({ race_growth: -6, race_trader: 6 }) === 0 && racePointTotal({ race_growth: -6, race_trader: 1 }) === 0);
    ok('an empty race is zero, not NaN', racePointTotal({}) === 0);
    ok('garbage in a field cannot make the total NaN',
        racePointTotal({ race_growth: 'x', race_trader: 6 }) === 6, racePointTotal({ race_growth: 'x', race_trader: 6 }));
    ok('every toggle the form offers is priced', TOGGLE_FIELDS.every(f => Number.isInteger(f.cost) && f.cost > 0));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
