const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const systemClaims = require('./systemClaims');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('systemClaims.test.js');

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (40, 'Minchir', -1, 8)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (9, 'officer1', 'x', 'user')`).run();

ok('getAllClaims starts empty', systemClaims.getAllClaims().length === 0);

// Uncontested claim: one row, planet_count null ("whole system").
systemClaims.upsertClaim(40, 'tuga', null, 'Ours, uncontested', 9);
let claims = systemClaims.getAllClaims();
ok('a whole-system claim is stored with planet_count null and the tag uppercased',
    claims.length === 1 && claims[0].alliance_tag === 'TUGA' && claims[0].planet_count === null, claims);
ok('the claim carries the updating member\'s name via the join', claims[0].updated_by_name === 'officer1', claims[0]);

// Sharing the same system with a second alliance: a second row, not a merge.
systemClaims.upsertClaim(40, 'RAID', 6, '6/6 split agreed in Discord', 9);
systemClaims.upsertClaim(40, 'TUGA', 6, '6/6 split agreed in Discord', 9);
claims = systemClaims.getAllClaims();
ok('a shared system carries one row per alliance', claims.length === 2, claims);
ok('re-claiming an existing (system, tag) pair updates in place rather than duplicating',
    claims.filter(c => c.alliance_tag === 'TUGA').length === 1
    && claims.find(c => c.alliance_tag === 'TUGA').planet_count === 6, claims);

systemClaims.deleteClaim(40, 'raid');
claims = systemClaims.getAllClaims();
ok('deleteClaim removes just that alliance\'s row (case-insensitive tag match)',
    claims.length === 1 && claims[0].alliance_tag === 'TUGA', claims);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
