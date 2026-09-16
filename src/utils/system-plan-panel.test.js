// The collapsed system-plan panel's HTML — pure, so this runs without a browser.
//
// Run with: node src/utils/system-plan-panel.test.js

const { buildSystemPlanHtml, buildSystemPlanEditFormHtml, buildAddPlanPromptHtml, readSystemPlanEditForm, esc } =
    require('../../public/js/utils/system-plan-panel.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('system-plan-panel.test.js');

console.log('\n── A never-edited plan ' + '─'.repeat(53));
{
    const html = buildSystemPlanHtml({
        note: 'Hold this system, colony ships inbound.',
        author_name: 'AdminOne', last_edited_by_name: null, was_edited: false,
        updated_at: '2026-09-16 15:00:00',
    }, { formatUpdatedAt: (v) => `formatted(${v})` });

    ok('the note appears', html.includes('Hold this system, colony ships inbound.'), html);
    ok('credits the author', html.includes('by AdminOne'), html);
    ok('says nothing about an edit — no "last edited" text at all',
        !html.includes('last edited'), html);
    ok('the formatUpdatedAt callback is used, not a hardcoded format',
        html.includes('formatted(2026-09-16 15:00:00)'), html);
    ok('starts collapsed — the body is display:none', /data-aw-splan-body[^>]*display:\s*none/.test(html), html);
}

console.log('\n── An edited plan ' + '─'.repeat(58));
{
    const html = buildSystemPlanHtml({
        note: 'v2', author_name: 'AdminOne', last_edited_by_name: 'AdminTwo', was_edited: true,
        updated_at: '2026-09-16 15:05:00',
    }, { formatUpdatedAt: () => '' });

    ok('names both the original author and the editor', html.includes('by AdminOne') && html.includes('last edited by AdminTwo'), html);
}

console.log('\n── Missing attribution degrades instead of crashing ' + '─'.repeat(22));
{
    // A departed account (ON DELETE SET NULL) — the repo layer already covers this; the
    // panel must render something sane rather than "by null" or throwing.
    const html = buildSystemPlanHtml({
        note: 'orphaned', author_name: null, last_edited_by_name: null, was_edited: true,
        updated_at: null,
    }, { formatUpdatedAt: () => '' });
    ok('falls back to "unknown" for a missing author', html.includes('by unknown'), html);
    ok('and for a missing editor', html.includes('last edited by unknown'), html);
    ok('no crash with no formatUpdatedAt supplied at all', typeof buildSystemPlanHtml({
        note: 'x', author_name: 'A', last_edited_by_name: null, was_edited: false, updated_at: 'x',
    }) === 'string');
}

console.log('\n── The note is a member-written free-text field ' + '─'.repeat(25));
{
    const html = buildSystemPlanHtml({
        note: '<script>alert(1)</script> & "quotes"',
        author_name: '<b>Admin</b>', last_edited_by_name: null, was_edited: false, updated_at: null,
    }, { formatUpdatedAt: () => '' });
    ok('the note is escaped, not executed', !html.includes('<script>') && html.includes('&lt;script&gt;'), html);
    ok('so is the author name', !html.includes('<b>Admin</b>'), html);

    ok('esc is exported and handles the usual special characters',
        esc('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;', esc('<>&"\''));
}

console.log('\n── Multi-line notes are preserved, not collapsed ' + '─'.repeat(24));
{
    // white-space:pre-wrap on the body is what makes this matter — a plan is realistically
    // a few lines ("planet sharing", "attack plan"), and collapsing them to one line would
    // undo the CSS choice for no reason.
    const html = buildSystemPlanHtml({
        note: 'Line one.\nLine two.\nLine three.',
        author_name: 'A', last_edited_by_name: null, was_edited: false, updated_at: null,
    }, { formatUpdatedAt: () => '' });
    ok('newlines survive into the HTML', html.includes('Line one.\nLine two.\nLine three.'), html);
    ok('the body is styled to respect them', /data-aw-splan-body[^>]*white-space:\s*pre-wrap/.test(html), html);
}

console.log('\n── Admin edit/delete buttons (2026-09-16e: the web write path) ' + '─'.repeat(10));
{
    const planArgs = {
        note: 'x', author_name: 'A', last_edited_by_name: null, was_edited: false, updated_at: null,
    };
    const readOnly = buildSystemPlanHtml(planArgs, { formatUpdatedAt: () => '' });
    ok('a non-admin viewer gets no edit/delete buttons at all',
        !readOnly.includes('data-aw-splan-edit-btn') && !readOnly.includes('data-aw-splan-delete-btn'), readOnly);

    const asAdmin = buildSystemPlanHtml(planArgs, { formatUpdatedAt: () => '', isAdmin: true });
    ok('an admin viewer gets both buttons', asAdmin.includes('data-aw-splan-edit-btn') && asAdmin.includes('data-aw-splan-delete-btn'), asAdmin);
    ok('the buttons sit next to the chevron, not inside the collapsible body — clicking one\n' +
        '     must not require the panel to already be expanded',
        asAdmin.indexOf('data-aw-splan-edit-btn') < asAdmin.indexOf('data-aw-splan-body'), asAdmin);
}

console.log('\n── The inline edit form (the actual "give a text to edit" feature, on the web) ' + '─'.repeat(1));
{
    const blank = buildSystemPlanEditFormHtml('');
    ok('an empty note (the Add flow) renders an empty textarea, not the word "null" or "undefined"',
        !blank.includes('>null<') && !blank.includes('>undefined<'), blank);
    ok('Save and Cancel controls are present', blank.includes('data-aw-splan-save-btn') && blank.includes('data-aw-splan-cancel-btn'), blank);

    const prefilled = buildSystemPlanEditFormHtml('Existing plan text');
    ok('an existing note pre-fills the textarea — the whole point of the feature request:\n' +
        '     fixing one word must not mean retyping the plan from scratch',
        prefilled.includes('Existing plan text'), prefilled);

    const nasty = buildSystemPlanEditFormHtml('<script>alert(1)</script>');
    ok('a note containing markup is escaped in the textarea, not executed',
        !nasty.includes('<script>alert') && nasty.includes('&lt;script&gt;'), nasty);
}

console.log('\n── Reading the edit form back ' + '─'.repeat(44));
{
    const fakeRoot = (value) => ({
        querySelector: (sel) => (sel === '[data-aw-splan-textarea]' ? { value } : null),
    });
    ok('trims surrounding whitespace', readSystemPlanEditForm(fakeRoot('  hello  ')) === 'hello');
    ok('an all-whitespace note reads as empty, matching the server\'s own "cannot be empty" rule',
        readSystemPlanEditForm(fakeRoot('   ')) === '');
    ok('a root with no textarea in it (defensive) reads as empty rather than throwing',
        readSystemPlanEditForm({ querySelector: () => null }) === '');
}

console.log('\n── The "add a plan" prompt shown to admins when nothing exists yet ' + '─'.repeat(8));
{
    const html = buildAddPlanPromptHtml();
    ok('has a clickable trigger', html.includes('data-aw-splan-add-btn'), html);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
