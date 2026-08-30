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
