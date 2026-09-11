// Extracted from routes.js (issue #147's travel-time halving) so intel.js's ally-name
// resolution can share the exact same "who counts as friendly" definition — see this
// module's own comment for the live bug that made sharing it necessary. This file covers
// the logic itself; routes-alliance-detect.test.js already covers it end-to-end through
// the route-preview HTTP path and is left alone.
//
// Run with: node src/utils/friendly-alliance-tags.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-friendly-tags-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
delete process.env.DISCORD_TOKEN;

const db = require('../database');
const settingsRepo = require('../repositories/settings');
const { friendlyAllianceTags } = require('./friendly-alliance-tags');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('── friendlyAllianceTags: own tag + configured allies ' + '─'.repeat(23));

ok('with nothing configured and no known member, the set is empty (not a crash)',
    friendlyAllianceTags().size === 0, [...friendlyAllianceTags()]);

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (200, 'Our Alliance', 'RAID')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (20, 'Caveman', 200)`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (20)`).run();

const ownOnly = friendlyAllianceTags();
ok('own alliance tag is discovered via a member with an alliance_member_stats row',
    ownOnly.has('RAID') && ownOnly.size === 1, [...ownOnly]);

settingsRepo.setSetting('alliance_relations_allied', 'AO, xyz');
const withAllies = friendlyAllianceTags();
ok('admin-configured allied tags are added, uppercased',
    withAllies.has('AO') && withAllies.has('XYZ'), [...withAllies]);
ok('own tag is still present alongside the configured allies',
    withAllies.has('RAID') && withAllies.size === 3, [...withAllies]);

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
