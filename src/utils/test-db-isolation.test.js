// No test may open the production database.
//
// THE INCIDENT (2026-09-15): src/utils/discord.test.js required database.js without pointing
// AWT_DB_PATH anywhere, so it fell through to the real awt.db. It looked harmless for years
// because its fixtures are all 'test-%' prefixed and it deletes them again — but isolation is
// not about the rows a test writes. database.js runs initDatabase() at require time, so a
// one-shot migration added that day fired against PRODUCTION from a test run, eight minutes
// before the deploy that was supposed to carry it. It cleared state and marked itself done
// while the old code was still the running code, which re-poisoned the very rows it had just
// cleaned and left the migration unable to run again when it actually shipped.
//
// So the rule this enforces is not "clean up after yourself" but "never connect at all":
// AWT_DB_PATH must be assigned BEFORE the first require that can reach database.js, since
// database.js reads it exactly once, at require time.
//
// Run with: node src/utils/test-db-isolation.test.js

const fs = require('fs');
const path = require('path');

const srcRoot = path.join(__dirname, '..');
const dbModule = path.join(srcRoot, 'database.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

function walk(dir) {
    let found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found = found.concat(walk(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
    }
    return found;
}

// Only local requires matter: a package from node_modules cannot reach database.js, and
// resolving the whole dependency tree would make this slow for no added coverage.
const LOCAL_REQUIRE = /require\(\s*(?:'([^']*)'|"([^"]*)"|path\.join\(([^)]*)\))/g;
function localRequireTargets(file) {
    const src = fs.readFileSync(file, 'utf8');
    const targets = [];
    for (const m of src.matchAll(LOCAL_REQUIRE)) {
        // path.join(__dirname, '..', 'database.js') — take the quoted segments and rejoin.
        const spec = m[1] ?? m[2] ?? (m[3] ? [...m[3].matchAll(/'([^']*)'|"([^"]*)"/g)]
            .map(s => s[1] ?? s[2]).join('/') : null);
        if (!spec) continue;
        const base = m[3] ? path.dirname(file) : null;
        if (!m[3] && !spec.startsWith('.')) continue;
        const resolvedFrom = base || path.dirname(file);
        const candidate = path.resolve(resolvedFrom, m[3] ? path.join('..', spec.split('/').pop()) : spec);
        for (const guess of [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]) {
            if (fs.existsSync(guess) && fs.statSync(guess).isFile()) {
                targets.push({ file: guess, index: m.index });
                break;
            }
        }
    }
    return targets;
}

// Which modules can reach database.js, directly or through any chain of local requires.
const reaches = new Map();
function reachesDb(file, seen = new Set()) {
    if (file === dbModule) return true;
    if (reaches.has(file)) return reaches.get(file);
    if (seen.has(file)) return false;
    seen.add(file);
    const result = localRequireTargets(file).some(t => reachesDb(t.file, seen));
    if (seen.size <= 1) reaches.set(file, result);
    return result;
}

console.log('test-db-isolation.test.js');
console.log('\n-- Every suite that can reach database.js isolates it first ' + '-'.repeat(10));

const testFiles = walk(srcRoot).filter(f => f.endsWith('.test.js'));
ok('the scan actually found the test suites', testFiles.length > 50, testFiles.length);

const offenders = [];
for (const file of testFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const dbRequires = localRequireTargets(file).filter(t => reachesDb(t.file));
    if (dbRequires.length === 0) continue;

    const assign = src.search(/process\.env\.AWT_DB_PATH\s*=/);
    const firstDbRequire = Math.min(...dbRequires.map(t => t.index));
    if (assign === -1) {
        offenders.push(`${path.relative(srcRoot, file)}: never sets AWT_DB_PATH`);
    } else if (assign > firstDbRequire) {
        offenders.push(`${path.relative(srcRoot, file)}: sets AWT_DB_PATH at ${assign}, after a database require at ${firstDbRequire}`);
    }
}

ok('no suite reaches database.js without redirecting AWT_DB_PATH first', offenders.length === 0, offenders);

// A guard that cannot fail is not a guard. This proves the detection works on a file shaped
// exactly like the one that caused the incident, rather than trusting a clean run to mean
// the scan looked at anything.
console.log('\n-- The check itself detects the shape that caused the incident ' + '-'.repeat(7));
const decoyDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'awt-isolation-decoy-'));
const decoy = path.join(srcRoot, `zz-isolation-decoy-${path.basename(decoyDir)}.test.js`);
try {
    fs.writeFileSync(decoy, `const db = require('./database.js');\n`);
    const targets = localRequireTargets(decoy);
    ok('a require of database.js with no AWT_DB_PATH assignment is seen',
        targets.some(t => reachesDb(t.file)) && !/process\.env\.AWT_DB_PATH\s*=/.test(fs.readFileSync(decoy, 'utf8')));

    // And transitively, which is the harder half: routes/sync.js never mentions database.js
    // by name in a test file, it just pulls it in.
    fs.writeFileSync(decoy, `const r = require('./routes/sync.js');\n`);
    ok('so is a require of a module that only reaches database.js indirectly',
        localRequireTargets(decoy).some(t => reachesDb(t.file)));
} finally {
    fs.rmSync(decoy, { force: true });
    fs.rmSync(decoyDir, { recursive: true, force: true });
}

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
