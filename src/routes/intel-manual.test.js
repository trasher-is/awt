// POST /hub-api/intel/manual — typing in an ally's screenshot.
//
// WHY THIS ENDPOINT IS TREATED AS DANGEROUS (2026-09-16): it writes the same columns a real
// intelligence capture writes, and those columns are read by the bio threat matrix, the
// battle calculator's win chances and !bio. So a bad entry here is not a cosmetic problem —
// it is a wrong number in a decision about committing a fleet. Hence: bounds on every field
// rather than trusting the form, and a REQUIRED source, because second-hand data nobody can
// tell apart from our own is worse than no data at all.
//
// Run with: node src/routes/intel-manual.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-manual-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-manual.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'caveman' }; next(); });
app.use('/hub-api', intelRouter);

function postJson(server, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

db.prepare(`INSERT INTO players (id, name, science_level) VALUES (415, 'Starius', 10)`).run();

// The real screenshot this feature was built from.
const STARIUS = {
    player_id: 415,
    biology: 8, economy: 0, energy: 6, mathematics: 6, physics: 6, social: 10,
    trade_revenue: 0, artefact: 'N/A',
    race_growth: -2, race_science: -2, race_culture: 0,
    race_production: 0, race_speed: 2, race_attack: 2, race_defense: 0,
    source: 'screenshot from Glutus [PUNK]',
};

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    try {
        console.log('\n-- A real entry ' + '-'.repeat(58));
        const res = await postJson(server, '/hub-api/intel/manual', STARIUS);
        ok('accepted', res.status === 200 && res.body.success === true, res);

        const row = db.prepare('SELECT * FROM players WHERE id = 415').get();
        ok('every science lands where a real capture would put it',
            row.biology === 8 && row.economy === 0 && row.energy === 6
            && row.mathematics === 6 && row.physics === 6 && row.social === 10, row);
        ok('so do the race picks, signs intact',
            row.race_growth === -2 && row.race_science === -2 && row.race_speed === 2
            && row.race_attack === 2 && row.race_defense === 0, row);
        ok('has_intel is set, so the values actually display instead of reading "?"',
            row.has_intel === 1, row.has_intel);
        ok('and an intel timestamp is recorded', !!row.intel_updated_at, row.intel_updated_at);

        // The entire point of the feature.
        ok('the source is stored', row.intel_source === 'screenshot from Glutus [PUNK]', row.intel_source);
        ok('along with who typed it — a different question from where it came from',
            row.intel_entered_by === 'caveman', row.intel_entered_by);

        // "N/A" is what the game PRINTS when there is no artefact; storing it literally would
        // turn "none" into an artefact named N/A, which the UI would then display as one.
        ok('an artefact of "N/A" is stored as none, not as a thing called N/A',
            row.artefact === null, row.artefact);

        // Not shown by the game's Race Summary, so no screenshot can carry them. Writing 0
        // would be inventing a reading rather than lacking one.
        ok('trader and SUL are left alone rather than invented',
            row.race_trader === 0 && row.race_sul === 0, [row.race_trader, row.race_sul]);

        console.log('\n-- Intel with no source is refused ' + '-'.repeat(39));
        for (const [label, source] of [['missing', undefined], ['empty', ''], ['whitespace', '   ']]) {
            const r = await postJson(server, '/hub-api/intel/manual', { ...STARIUS, player_id: 415, source });
            ok(`a ${label} source is rejected — unattributable intel is the thing this prevents`,
                r.status === 400, r);
        }

        console.log('\n-- Typos are caught at the door, not in a battle calc ' + '-'.repeat(20));
        const bad = [
            ['a science that is not a number', { biology: 'eight' }],
            ['a negative science level', { biology: -1 }],
            ['an absurd science level', { biology: 500 }],
            ['a race pick far outside the game\'s range', { race_speed: 99 }],
            ['a fractional race pick', { race_attack: 1.5 }],
            ['a negative trade revenue', { trade_revenue: -5 }],
        ];
        for (const [label, patch] of bad) {
            const r = await postJson(server, '/hub-api/intel/manual', { ...STARIUS, ...patch });
            ok(`${label} is rejected`, r.status === 400, { patch, r });
        }

        // A rejected entry must not have half-written the row on its way out.
        const after = db.prepare('SELECT biology, race_speed, trade_revenue FROM players WHERE id = 415').get();
        ok('and none of them disturbed the values already on record',
            after.biology === 8 && after.race_speed === 2 && after.trade_revenue === 0, after);

        console.log('\n-- Unknown players ' + '-'.repeat(55));
        const ghost = await postJson(server, '/hub-api/intel/manual', { ...STARIUS, player_id: 99999 });
        ok('a player the hub has never heard of is a 404, not a silent no-op', ghost.status === 404, ghost);

        console.log('\n-- Correcting an earlier entry ' + '-'.repeat(44));
        const fixed = await postJson(server, '/hub-api/intel/manual', {
            ...STARIUS, biology: 9, source: 'corrected screenshot from Harpyie',
        });
        const row2 = db.prepare('SELECT biology, intel_source FROM players WHERE id = 415').get();
        ok('a re-entry overwrites the values and the source together',
            fixed.status === 200 && row2.biology === 9 && row2.intel_source === 'corrected screenshot from Harpyie', row2);
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

    if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
    console.log('All checks passed');
})().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
