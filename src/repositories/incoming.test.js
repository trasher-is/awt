const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const incoming = require('./incoming');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('incoming.test.js');

// Test getCoveringRow returns undefined for non-existent alert_key
const missing = incoming.getCoveringRow('nonexistent');
ok('getCoveringRow returns undefined for non-existent alert_key', missing === undefined);

// Test upsertCovering creates a new row
incoming.upsertCovering('alert-1', 'Defender A covering');
const afterInsert = incoming.getCoveringRow('alert-1');
ok('upsertCovering creates row, getCoveringRow returns it', afterInsert && afterInsert.covering === 'Defender A covering');

// Test upsertCovering updates covering on same alert_key
incoming.upsertCovering('alert-1', 'Defender A, B covering');
const afterUpdate = incoming.getCoveringRow('alert-1');
ok('upsertCovering updates covering without error', afterUpdate && afterUpdate.covering === 'Defender A, B covering');

// Test upsertMessageRef creates a new row
incoming.upsertMessageRef('alert-2', 'chan-123', 'msg-456');
const msgRef = incoming.getMessageRef('alert-2');
ok('upsertMessageRef creates row, getMessageRef returns { message_id, channel_id }',
    msgRef && msgRef.message_id === 'msg-456' && msgRef.channel_id === 'chan-123');

// Test upsertMessageRef updates message ref on same alert_key
incoming.upsertMessageRef('alert-2', 'chan-789', 'msg-999');
const updatedMsgRef = incoming.getMessageRef('alert-2');
ok('upsertMessageRef updates channel_id/message_id on same alert_key',
    updatedMsgRef && updatedMsgRef.message_id === 'msg-999' && updatedMsgRef.channel_id === 'chan-789');

// Test real-world race: upsertCovering then upsertMessageRef on same alert_key
incoming.upsertCovering('alert-race', 'Defender X covering');
incoming.upsertMessageRef('alert-race', 'chan-race', 'msg-race');

// Verify both covering and message_ref are intact
const coveringAfterRace = incoming.getCoveringRow('alert-race');
const msgRefAfterRace = incoming.getMessageRef('alert-race');
ok('upsertCovering and upsertMessageRef preserve each other (covering intact)',
    coveringAfterRace && coveringAfterRace.covering === 'Defender X covering');
ok('upsertCovering and upsertMessageRef preserve each other (message_ref intact)',
    msgRefAfterRace && msgRefAfterRace.message_id === 'msg-race' && msgRefAfterRace.channel_id === 'chan-race');

// Test getLastOntimeRow returns undefined before updateLastOntime
const missingLastOntime = incoming.getLastOntimeRow('alert-3');
ok('getLastOntimeRow returns undefined before updateLastOntime', missingLastOntime === undefined);

// Test updateLastOntime and round-trip
// Seed the row first via upsertCovering (simulating realistic usage where row already exists)
incoming.upsertCovering('alert-3', '');
incoming.updateLastOntime('alert-3', 'Defender Y, Z');
const lastOntimeAfter = incoming.getLastOntimeRow('alert-3');
ok('updateLastOntime and getLastOntimeRow round-trip the value',
    lastOntimeAfter && lastOntimeAfter.last_ontime === 'Defender Y, Z');

// Issue #143: rows carry the base identity + arrival so a second wave from the same
// attacker at the same planet can be told apart from a re-report of the first.
const noRows = incoming.findIncomingByBaseKey('10:2:attacker');
ok('findIncomingByBaseKey returns [] for an unknown base key', Array.isArray(noRows) && noRows.length === 0);

incoming.ensureIncomingIdentity('10:2:attacker:1800000000', '10:2:attacker', 1800000000);
const created = incoming.findIncomingByBaseKey('10:2:attacker');
ok('ensureIncomingIdentity creates the row with base_key and arrival_unix',
    created.length === 1 && created[0].alert_key === '10:2:attacker:1800000000' && created[0].arrival_unix === 1800000000 && !!created[0].updated_at);

incoming.upsertMessageRef('10:2:attacker:1800000000', 'chan-w1', 'msg-w1');
const keptIdentity = incoming.findIncomingByBaseKey('10:2:attacker');
ok('upsertMessageRef on the same key keeps base_key/arrival_unix intact',
    keptIdentity.length === 1 && keptIdentity[0].arrival_unix === 1800000000);

incoming.ensureIncomingIdentity('10:2:attacker:1800000000', '10:2:attacker', 0);
ok('ensureIncomingIdentity never downgrades a known arrival to unknown',
    incoming.findIncomingByBaseKey('10:2:attacker')[0].arrival_unix === 1800000000);

// A legacy row (pre-#143: alert_key IS the base key, no base_key column value) is still found.
incoming.upsertMessageRef('10:2:attacker', 'chan-legacy', 'msg-legacy');
const withLegacy = incoming.findIncomingByBaseKey('10:2:attacker');
ok('a legacy row keyed by the bare base identity is returned alongside the new-style rows',
    withLegacy.length === 2 && withLegacy.some(r => r.alert_key === '10:2:attacker' && r.arrival_unix === null));
incoming.ensureIncomingIdentity('10:2:attacker', '10:2:attacker', 1800000500);
ok('stamping an arrival on a legacy row fills arrival_unix and base_key without touching its message ref',
    incoming.findIncomingByBaseKey('10:2:attacker').find(r => r.alert_key === '10:2:attacker').arrival_unix === 1800000500
    && incoming.getMessageRef('10:2:attacker').message_id === 'msg-legacy');
ok('a different attacker on the same planet is a different base key', incoming.findIncomingByBaseKey('10:2:other').length === 0);

// Regression for a real production bug (2026-08-30): incoming_msgs/incoming_alerts were
// never cleared by the round-reset ("nuke intel") route — alert_key is system:planet:
// attacker, an identity meaningless outside the round it was recorded in.
ok('incoming_msgs has rows from the seeding above before the wipe',
    db.prepare('SELECT COUNT(*) as n FROM incoming_msgs').get().n > 0);
incoming.deleteAllIncomingMsgs();
ok('deleteAllIncomingMsgs empties the table',
    db.prepare('SELECT COUNT(*) as n FROM incoming_msgs').get().n === 0);

db.prepare(`INSERT INTO incoming_alerts (fleet_id, channel_id, message_id) VALUES (?, ?, ?)`).run(999, 'chan-legacy', 'msg-legacy');
ok('incoming_alerts has a row before the wipe',
    db.prepare('SELECT COUNT(*) as n FROM incoming_alerts').get().n === 1);
incoming.deleteAllIncomingAlerts();
ok('deleteAllIncomingAlerts empties the table',
    db.prepare('SELECT COUNT(*) as n FROM incoming_alerts').get().n === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
