#!/usr/bin/env node
// Test runner: finds every *.test.js in this directory, runs each in its own process, and
// exits non-zero if any of them does.
//
// Discovery rather than a hard-coded list in package.json, so adding a test file is one
// file instead of two — and so two branches adding tests at the same time do not collide
// on the same line of package.json.
//
//   npm test                 run everything
//   npm test -- battle       run only files whose name contains "battle"

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js'))
    .filter(f => !filter || f.includes(filter))
    .sort();

if (files.length === 0) {
    console.log(filter ? `No test files match "${filter}".` : 'No test files found.');
    process.exit(filter ? 1 : 0);
}

const results = [];
for (const file of files) {
    console.log(`\n${'═'.repeat(75)}\n▶ ${file}\n${'═'.repeat(75)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    results.push({ file, code: r.status == null ? 1 : r.status });
}

console.log(`\n${'═'.repeat(75)}`);
const failed = results.filter(r => r.code !== 0);
for (const r of results) console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.file}`);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
