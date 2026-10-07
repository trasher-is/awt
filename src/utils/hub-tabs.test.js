// The registry behind the admin page's "Open member tabs" list (src/utils/hub-tabs.js).
// Pinned: one entry per TAB, not per member (phone and desktop open at once must both show);
// a tab that stops reporting drops off; malformed reports from the browser are ignored; and
// a flood of fake tab ids cannot grow it without bound.
//
// Run with: node src/utils/hub-tabs.test.js

const { createHubTabs, TAB_TTL_MS } = require('./hub-tabs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('hub-tabs.test.js');
const T0 = 1_000_000;

{
    const tabs = createHubTabs();
    tabs.report({ userId: 1, tabId: 'phone-tab-1', build: 'aaaaaa111111', browser: 'chrome', mobile: 1 }, T0);
    tabs.report({ userId: 1, tabId: 'desk-tab-22', build: 'bbbbbb222222', browser: 'firefox', mobile: 0 }, T0);
    const list = tabs.list(T0);
    ok('two tabs of one member are two entries', list.length === 2, list);
    ok('each keeps its own build', list.some(t => t.build === 'aaaaaa111111' && t.mobile === 1) && list.some(t => t.build === 'bbbbbb222222' && t.mobile === 0), list);

    tabs.report({ userId: 1, tabId: 'phone-tab-1', build: 'bbbbbb222222' }, T0 + 1000);
    ok('a tab reporting again updates in place (it reloaded onto the new build)',
        tabs.list(T0 + 1000).filter(t => t.tabId === 'phone-tab-1').length === 1
        && tabs.list(T0 + 1000).find(t => t.tabId === 'phone-tab-1').build === 'bbbbbb222222');

    ok('a tab still reporting within the window stays', tabs.list(T0 + TAB_TTL_MS).length === 2);
    ok('a tab that stopped reporting drops off', tabs.list(T0 + TAB_TTL_MS + 1).length === 1, tabs.list(T0 + TAB_TTL_MS + 1));
}

{
    const tabs = createHubTabs();
    const bad = [
        { userId: 0, tabId: 'tab-id-ok', build: 'abcdef' },
        { userId: '1', tabId: 'tab-id-ok', build: 'abcdef' },
        { userId: 1, tabId: 'short', build: 'abcdef' },
        { userId: 1, tabId: '<script>alert(1)</script>', build: 'abcdef' },
        { userId: 1, tabId: 'tab-id-ok', build: 'NOT-A-HASH' },
        { userId: 1, tabId: 'tab-id-ok', build: 'abc' },
        { userId: 1, tabId: 'tab-id-ok' },
    ];
    const kept = bad.map(r => tabs.report(r, T0));
    ok('malformed reports are ignored', kept.every(k => k === false) && tabs.size() === 0, kept);
}

{
    const tabs = createHubTabs({ maxTabs: 3 });
    for (let i = 0; i < 10; i++) tabs.report({ userId: 1, tabId: `flood-tab-${i}`, build: 'abcdef' }, T0 + i);
    const list = tabs.list(T0 + 10);
    ok('a flood of tab ids cannot grow it past its cap', list.length === 3, list.length);
    ok('the newest reports are the ones kept', list.map(t => t.tabId).sort().join() === 'flood-tab-7,flood-tab-8,flood-tab-9', list.map(t => t.tabId));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
