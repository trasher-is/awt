const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const fleets = require('./fleets');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('fleets.test.js');

db.prepare(`INSERT INTO players (id, name) VALUES (1, 'caveman')`).run();

ok('countFleets starts at 0', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
ok('countFleets is 1 after insert', fleets.countFleets() === 1);

const forSystem = fleets.getFleetsForSystem(10);
ok('getFleetsForSystem returns the fleet', forSystem.length === 1 && forSystem[0].owner_name === 'caveman');
db.prepare('UPDATE fleets SET arrival_at = ?, arrival_time = ? WHERE owner_id = 1')
    .run('2026-09-12T18:30:00Z', 'Sep 12 8:30 PM');
const arriving = fleets.getFleetsForSystem(10)[0];
ok('system intel exposes the canonical instant for viewer-local arrival display',
    arriving.arrival_at === '2026-09-12T18:30:00Z');
ok('legacy arrival text remains available without guessing its timezone', arriving.arrival_time === 'Sep 12 8:30 PM');

const upd = fleets.updateFleetGameId(999, 1, 10, 1);
ok('updateFleetGameId updates one row', upd.changes === 1);

fleets.deleteFleetsByOwner(1);
ok('deleteFleetsByOwner removes the fleet', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
fleets.deleteAllFleets();
ok('deleteAllFleets empties the table', fleets.countFleets() === 0);

// --- getFleetLocationMatches: cross-matching strongest_fleet against best_guarded ---
console.log('\n── getFleetLocationMatches ' + '─'.repeat(40));

db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (10, 'RAID', 'Raiders'), (20, 'FOE', 'Enemies')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES
    (201, 'kralgar', 20), (202, 'Zalbinion', 20), (203, 'Strem', 20), (204, 'Acquario', 20),
    (205, 'Wanderer', 20), (206, 'Nomad', 20), (207, 'Bystander', 20), (208, 'Loner', 20)`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES
    (300, 'Praepes', 0, 0), (301, 'Maasym', 1, 1), (302, 'Albaldah', 2, 2), (303, 'Vertex', 3, 3), (304, 'Nowhere', 4, 4)`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES
    (30001, 300, 6, 201), -- kralgar's own planet
    (30101, 301, 8, 204), -- owned by Acquario -- used below to give Zalbinion a "parked" match
    (30201, 302, 8, 204), -- Acquario's OWN home planet
    (30301, 303, 1, 203), -- Strem's OWN home planet -- same cv as Acquario's home, by coincidence
    (30401, 304, 1, 207)  -- Bystander's planet -- ambiguous target for two unrelated fleets
`).run();
db.prepare(`INSERT INTO best_guarded (game_planet_id, cv, updated_at) VALUES
    (30001, '975', '2026-09-19T22:00:00.000Z'), -- matches kralgar exactly, and he owns it -> home
    (30101, '480', '2026-09-19T22:00:00.000Z'), -- matches Zalbinion's cv, but Acquario owns this planet -> parked
    (30201, '105', '2026-09-19T22:00:00.000Z'), -- Acquario's own home, cv 105
    (30301, '105', '2026-09-19T22:00:00.000Z'), -- Strem's own home, ALSO cv 105 by coincidence
    (30401, '50',  '2026-09-19T22:00:00.000Z')  -- one spot, two unrelated 50-cv fleets contending
`).run();

// Real-world case this whole test exists to cover (2026-09-20 discussion): Strem and
// Acquario both showing 105 CV is NOT a collision between them -- each is independently
// sitting on their OWN home planet, which happens to also read 105. Self-ownership must
// resolve both to `home`, never `ambiguous`, regardless of the other player's coincidence.
// upsertStrongestFleet(playerId, rank, ...) -- player_id is the table's key since the
// 2026-09-20 history revision, so (unlike the old insertStrongestFleet) a player can only
// ever hold one row; collapsing a player's multiple simultaneous fleets to one happens at
// the sync-route layer (see sync-strongest-fleet.test.js), not here.
fleets.upsertStrongestFleet(201, 1, 325, 0, 0, 975, '2026-09-20T10:00:00.000Z'); // kralgar, home
fleets.upsertStrongestFleet(202, 2, 160, 0, 0, 480, '2026-09-20T10:00:00.000Z'); // Zalbinion, parked on Acquario's planet
fleets.upsertStrongestFleet(203, 3, 35, 0, 0, 105, '2026-09-20T10:00:00.000Z');  // Strem, home (coincidental cv match with Acquario)
fleets.upsertStrongestFleet(204, 4, 35, 0, 0, 105, '2026-09-20T10:00:00.000Z');  // Acquario, home (coincidental cv match with Strem)
fleets.upsertStrongestFleet(208, 5, 1, 0, 0, 3, '2026-09-20T10:00:00.000Z');     // Loner, tiny fleet, cv matches nothing -> away
fleets.upsertStrongestFleet(205, 6, 15, 0, 0, 50, '2026-09-20T10:00:00.000Z');   // Wanderer, doesn't own anything at cv 50
fleets.upsertStrongestFleet(206, 7, 15, 0, 0, 50, '2026-09-20T10:00:00.000Z');   // Nomad, same cv, also doesn't own anything at cv 50 -- genuinely can't tell them apart

const matches = fleets.getFleetLocationMatches();
const byPlayer = Object.fromEntries(matches.map(m => [m.player_id, m]));

ok('kralgar\'s 975-cv fleet matches his own planet -> home',
    byPlayer[201].location_status === 'home' && byPlayer[201].location.system_name === 'Praepes');
ok('Zalbinion\'s 480-cv fleet matches a planet he does not own -> parked',
    byPlayer[202].location_status === 'parked' && byPlayer[202].location.owner_name === 'Acquario');
ok('Strem\'s 105-cv fleet self-resolves to HIS OWN planet, despite Acquario sharing the same cv',
    byPlayer[203].location_status === 'home' && byPlayer[203].location.system_name === 'Vertex');
ok('Acquario\'s 105-cv fleet ALSO self-resolves to his own planet, not treated as colliding with Strem',
    byPlayer[204].location_status === 'home' && byPlayer[204].location.system_name === 'Albaldah');
ok('Loner\'s unmatched tiny fleet is away (no best_guarded planet at cv 3)',
    byPlayer[208].location_status === 'away' && byPlayer[208].location === null);
ok('Wanderer and Nomad, neither of whom self-match, ARE genuinely ambiguous over Bystander\'s one spot',
    byPlayer[205].location_status === 'ambiguous' && byPlayer[206].location_status === 'ambiguous');
ok('every matched row carries a last-seen timestamp for both sides',
    byPlayer[201].updated_at === '2026-09-20T10:00:00.000Z' && byPlayer[201].location.guard_updated_at === '2026-09-19T22:00:00.000Z');

fleets.deleteAllStrongestFleet();
ok('deleteAllStrongestFleet empties the table', db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet`).get().n === 0);
db.prepare(`DELETE FROM best_guarded`).run();
db.prepare(`DELETE FROM planets`).run();
db.prepare(`DELETE FROM systems`).run();
db.prepare(`DELETE FROM players`).run();
db.prepare(`DELETE FROM alliances`).run();

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
