// Regression coverage for the client-asset fingerprint behind the self-updating tab
// (2026-09-13). The contract that matters: it changes when the code a browser would run
// changes, and does NOT change otherwise — a fingerprint that drifts on its own would
// bounce every member's tab for no reason, and one that misses a real edit leaves them on
// stale code forever, which is the bug this exists to fix.
//
// Run with: node src/utils/build-version.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeBuildVersion } = require('./build-version');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-build-version-'));
fs.mkdirSync(path.join(root, 'js'));
fs.writeFileSync(path.join(root, 'js', 'app.js'), 'export const a = 1;');
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><p>hi</p>');
fs.writeFileSync(path.join(root, 'style.css'), 'body { color: red }');

console.log('build-version.test.js');

const baseline = computeBuildVersion(root);
ok('produces a short, stable-looking hex fingerprint', /^[0-9a-f]{12}$/.test(baseline), baseline);
ok('is deterministic — the same tree twice gives the same answer',
    computeBuildVersion(root) === baseline, [baseline, computeBuildVersion(root)]);

console.log('\n── Changes that a browser would notice ' + '─'.repeat(38));
fs.writeFileSync(path.join(root, 'js', 'app.js'), 'export const a = 2;');
const afterEdit = computeBuildVersion(root);
ok('editing a script changes it', afterEdit !== baseline, [baseline, afterEdit]);

fs.writeFileSync(path.join(root, 'js', 'extra.js'), 'export const b = 3;');
const afterAdd = computeBuildVersion(root);
ok('adding a script changes it', afterAdd !== afterEdit, [afterEdit, afterAdd]);

fs.renameSync(path.join(root, 'js', 'extra.js'), path.join(root, 'extra.js'));
const afterMove = computeBuildVersion(root);
ok('MOVING a file changes it, even though every byte in the tree is identical',
    afterMove !== afterAdd, [afterAdd, afterMove]);

fs.unlinkSync(path.join(root, 'extra.js'));
ok('deleting it again returns to the previous fingerprint', computeBuildVersion(root) === afterEdit);

console.log('\n── Changes that a browser would NOT notice ' + '─'.repeat(34));
// mtime is deliberately not part of the hash: a redeploy that rewrites identical files
// (a restart, a fresh clone) must not read as a new build and bounce everyone's tab.
const touched = new Date(Date.now() + 60 * 60 * 1000);
fs.utimesSync(path.join(root, 'js', 'app.js'), touched, touched);
ok('touching a file without editing it does NOT change the fingerprint',
    computeBuildVersion(root) === afterEdit, computeBuildVersion(root));

fs.writeFileSync(path.join(root, 'notes.txt'), 'not served to the browser');
fs.writeFileSync(path.join(root, 'data.json'), '{"served":"but not executed"}');
ok('a non-asset file alongside them is ignored',
    computeBuildVersion(root) === afterEdit, computeBuildVersion(root));

fs.mkdirSync(path.join(root, 'lib'));
fs.writeFileSync(path.join(root, 'lib', 'jquery.js'), 'vendored, changes only with the package');
ok('vendored lib/ is skipped — walking it costs more than it tells us',
    computeBuildVersion(root) === afterEdit, computeBuildVersion(root));

fs.mkdirSync(path.join(root, '.cache'));
fs.writeFileSync(path.join(root, '.cache', 'tmp.js'), 'build litter');
ok('dot-directories are skipped', computeBuildVersion(root) === afterEdit, computeBuildVersion(root));

console.log('\n── Degenerate input ' + '─'.repeat(56));
ok('a tree with no assets at all still returns a fingerprint rather than throwing',
    /^[0-9a-f]{12}$/.test(computeBuildVersion(path.join(root, 'lib'))));
ok('a path that does not exist is survivable, not a crash',
    /^[0-9a-f]{12}$/.test(computeBuildVersion(path.join(root, 'no-such-dir'))));

fs.rmSync(root, { recursive: true, force: true });

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
