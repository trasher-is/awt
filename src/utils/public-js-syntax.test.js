// Every browser file must parse. The suites run slices of these files, so a syntax error
// elsewhere in one passed all of them and reached members (2026-11-24): one bad line in
// page-injections.js stopped every game-page extra. Parsed as modules, without running them.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '../../public/js');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
    }
})(root);

const checker = `
    const vm = require('vm'), fs = require('fs');
    const bad = [];
    for (const f of JSON.parse(fs.readFileSync(0, 'utf8'))) {
        try { new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f }); }
        catch (err) { bad.push({ f, message: String(err.stack).split('\\n').slice(0, 3).join(' ') }); }
    }
    process.stdout.write(JSON.stringify(bad));`;
const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', checker],
    { input: JSON.stringify(files), encoding: 'utf8' });

let fail = 0;
if (child.status !== 0) { fail++; console.error('  ❌ the parse check itself failed', child.stderr); }
if (files.length < 50) { fail++; console.error(`  ❌ only ${files.length} browser files found`); }
for (const b of child.status === 0 ? JSON.parse(child.stdout) : []) {
    fail++;
    console.error(`  ❌ ${path.relative(root, b.f)}: ${b.message}`);
}
if (!fail) console.log(`  ✅ all ${files.length} browser files parse`);
console.log(`\n${fail ? 0 : 1} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
