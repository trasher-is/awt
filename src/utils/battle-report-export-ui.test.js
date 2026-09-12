// Exercise actual panel functions with delayed responses. The important regressions
// are stale search responses and exporting filters different from the visible table.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ok - ${name}`); }
    else { fail++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); }
}
const source = fs.readFileSync(path.join(__dirname, '../../public/js/ui/archives.js'), 'utf8');
const panelCode = source.slice(source.indexOf('const battleReportsState ='), source.indexOf('\nfunction updateSortArrows()'))
    .replace('export async function openBattleReportsPanel', 'async function openBattleReportsPanel');
const elements = new Map();
for (const name of ['export-all', 'export-filtered', 'export-format', 'export-status', 'result-count', 'total-count', 'table-body']) {
    elements.set(`battle-reports-${name}`, { disabled: false, textContent: '', value: name === 'export-format' ? 'json' : '', innerHTML: '' });
}
const pending = [], downloads = [], revoked = [], timers = [];
const state = {
    AbortController, URLSearchParams, console,
    clearTimeout() {}, setTimeout(callback) { timers.push(callback); return timers.length; },
    updateSortArrows() {},
    renderBattleReportsTable(feed, total) { state.lastRendered = { feed, total }; },
    document: {
        getElementById: id => elements.get(id),
        createElement: () => ({ click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} }),
        body: { appendChild() {} },
    },
    URL: { createObjectURL: () => 'blob:synthetic-export', revokeObjectURL: value => revoked.push(value) },
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); },
};
const context = vm.createContext(state);
vm.runInContext(panelCode, context);
const run = expression => vm.runInContext(expression, context);
const searchResponse = label => ({ ok: true, json: async () => ({ success: true, feed: [{ label }], total: 1 }) });
const exportResponse = (ok = true) => ({
    ok,
    headers: { get: name => name === 'Content-Type' ? 'application/json; charset=utf-8' : 'attachment; filename="synthetic-export.json"' },
    blob: async () => ({}),
    json: async () => ({ error: 'Unauthorized: Please log in' }),
});
(async () => {
try {
    run("battleReportsState.q = 'first'");
    const first = run('loadBattleReportsTable()');
    ok('filtered export is unavailable while initial search is loading', elements.get('battle-reports-export-filtered').disabled);
    run("battleReportsState.q = 'second'");
    const second = run('loadBattleReportsTable()');
    ok('superseded request is aborted', pending[0].options.signal.aborted);
    pending[1].resolve(searchResponse('second')); await second;
    pending[0].resolve(searchResponse('first')); await first;
    ok('late response cannot overwrite newer results or applied export filters', state.lastRendered.feed[0].label === 'second' && run('battleReportsAppliedFilters.q') === 'second');
    ok('filtered export becomes available only after successful current search', !elements.get('battle-reports-export-filtered').disabled);

    const download = run("exportBattleReports('filtered')");
    ok('download takes a snapshot of the displayed search', new URL(pending[2].url, 'http://synthetic.test').searchParams.get('q') === 'second');
    ok('both export buttons prevent duplicate downloads while preparing', elements.get('battle-reports-export-all').disabled && elements.get('battle-reports-export-filtered').disabled);
    await run("exportBattleReports('all')");
    ok('duplicate export requests do not reach the server', pending.length === 3);
    run("battleReportsState.q = 'typed during download'; invalidateBattleReportsSearch()");
    pending[2].resolve(exportResponse()); await download;
    ok('download uses the attachment filename and schedules URL cleanup', downloads.length === 1 && downloads[0].filename === 'synthetic-export.json' && timers.length === 1);
    timers[0]();
    ok('download URL is released', revoked[0] === 'blob:synthetic-export');
    ok('typing invalidates filtered export through the debounce interval', elements.get('battle-reports-export-filtered').disabled && !elements.get('battle-reports-export-all').disabled);
    await run("exportBattleReports('filtered')");
    ok('invalidated filters cannot start an export', pending.length === 3);

    const failingSearch = run('loadBattleReportsTable()');
    pending[3].resolve({ ok: false, json: async () => ({ error: 'Synthetic server error' }) }); await failingSearch;
    ok('failed search cannot leave an apparently valid filtered export', elements.get('battle-reports-export-filtered').disabled && elements.get('battle-reports-total-count').textContent === '—');
    const failedDownload = run("exportBattleReports('all')");
    ok('all export remains usable after search failure and ignores the search query', !new URL(pending[4].url, 'http://synthetic.test').searchParams.has('q'));
    pending[4].resolve(exportResponse(false)); await failedDownload;
    ok('authorization errors are visible and never downloaded as reports', elements.get('battle-reports-export-status').textContent === 'Unauthorized: Please log in' && downloads.length === 1);
    ok('failed export restores usable controls', !elements.get('battle-reports-export-all').disabled && elements.get('battle-reports-export-filtered').disabled);

    const htmlDownload = run("exportBattleReports('all')");
    pending[5].resolve({ ...exportResponse(), headers: { get: () => 'text/html' } }); await htmlDownload;
    ok('redirected login/error HTML cannot masquerade as a successful file', downloads.length === 1 && elements.get('battle-reports-export-status').textContent.includes('sign in'));
} catch (error) {
    fail++; console.error('  NOT OK - export UI test crashed:', error);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
})();
