const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const users = require('./users');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('users.test.js');

// The default admin row auto-created on schema init already occupies id 1 — work around it,
// same as the players/plans domains' smoke tests had to.
users.createUser('caveman', 'hash1', 'user', null);
const caveman = users.getUserByGameName('caveman');
ok('createUser created the row', !!caveman);
ok('getUserByGameName returns the full row', caveman.role === 'user');

ok('getUserNameById finds the new user', users.getUserNameById(caveman.id).game_name === 'caveman');

users.updateUserGameName(caveman.id, 'Caveman2');
ok('updateUserGameName renames', users.getUserNameById(caveman.id).game_name === 'Caveman2');

users.updateUserDiscordName(caveman.id, 'caveman#discord');
ok('updateUserDiscordName sets discord_name', users.getUserDiscordInfoById(caveman.id).discord_name === 'caveman#discord');

users.updateUserDiscordLink('12345', 'CavemanDiscord', caveman.id);
ok('updateUserDiscordLink sets both discord_id and discord_name', users.getUserByDiscordId('12345').game_name === 'Caveman2');
ok('getUserById returns id+game_name+discord fields', users.getUserById(caveman.id).discord_id === '12345');

const byName = users.getUserByDiscordName('cavemandiscord', '@cavemandiscord');
ok('getUserByDiscordName matches case-insensitively', byName && byName.id === caveman.id);

users.clearUserDiscordFields(caveman.id);
ok('clearUserDiscordFields nulls both fields', users.getUserById(caveman.id).discord_id === null && users.getUserById(caveman.id).discord_name === null);

ok('getUserActiveStatusById defaults to active', users.getUserActiveStatusById(caveman.id).is_active === 1);
users.setUserActive(caveman.id, 0);
ok('setUserActive deactivates', users.getUserActiveStatusById(caveman.id).is_active === 0);
users.setUserActive(caveman.id, 1);

users.setUserRole(caveman.id, 'admin');
ok('setUserRole changes role', users.getUserByGameName('Caveman2').role === 'admin');
users.setUserRole(caveman.id, 'user');

users.setUserPasswordHash(caveman.id, 'newhash');
ok('setUserPasswordHash changes the hash', users.getUserByGameName('Caveman2').password_hash === 'newhash');

const activeRecipients = users.getActiveRecipientsExcludingAdmin(caveman.id);
ok('getActiveRecipientsExcludingAdmin excludes the bootstrap admin by default', !activeRecipients.some(u => u.game_name === 'admin'));

const validIds = users.getValidActiveUserIds([caveman.id, 99999]);
ok('getValidActiveUserIds filters out nonexistent ids', validIds.length === 1 && validIds[0].id === caveman.id);
ok('getValidActiveUserIds returns [] for an empty id list', users.getValidActiveUserIds([]).length === 0);

ok('getAllUsersWithIdle includes the bootstrap admin and caveman', users.getAllUsersWithIdle().length === 2);

// last_activity_at (2026-09-04) — the client prefers it over idle_time (see
// players.js's getWarRoomPlayers comment for why); this query must surface it too.
// A dedicated user/player pair, not reusing 'Caveman2' — that name is exercised by the
// name-bridge tests further down, which assert on whether a players row matching it
// exists at specific points; inserting one here earlier broke those.
users.createUser('idletester', 'hash2', 'user', null);
db.prepare(`INSERT INTO players (id, name, last_activity_at) VALUES (500, 'idletester', '2026-09-03T17:13:55.1083087+02:00')`).run();
const withIdle = users.getAllUsersWithIdle();
ok('getAllUsersWithIdle joins in last_activity_at from the matching player row',
    withIdle.some(u => u.game_name === 'idletester' && u.last_activity_at === '2026-09-03T17:13:55.1083087+02:00'), withIdle);

ok('getActiveMemberNames lists active game names', users.getActiveMemberNames().some(u => u.game_name === 'Caveman2'));

ok('getAdminPasswordHash finds the bootstrap admin', !!users.getAdminPasswordHash());

users.banUser(caveman.id);
ok('banUser deactivates the account', users.getUserActiveStatusById(caveman.id).is_active === 0);

users.mintLinkCode('ABCD1234', caveman.id, new Date(Date.now() + 600000).toISOString());
const linkRow = users.getLinkCodeWithUser('ABCD1234');
ok('mintLinkCode/getLinkCodeWithUser round-trip', linkRow && linkRow.game_name === 'Caveman2');

users.markLinkCodeUsed('12345', 'ABCD1234');
ok('markLinkCodeUsed sets used_at', !!db.prepare('SELECT used_at FROM discord_link_codes WHERE code = ?').get('ABCD1234').used_at);

users.mintLinkCode('EXPIRED1', caveman.id, '2020-01-01T00:00:00.000Z');
users.deleteExpiredLinkCodes();
ok('deleteExpiredLinkCodes removes only the expired row', !users.getLinkCodeWithUser('EXPIRED1') && !!users.getLinkCodeWithUser('ABCD1234'));

users.mintLinkCode('UNUSED99', caveman.id, new Date(Date.now() + 600000).toISOString());
users.deleteUnusedLinkCodesForUser(caveman.id);
ok('deleteUnusedLinkCodesForUser removes the unused row but not the already-used one', !users.getLinkCodeWithUser('UNUSED99') && !!users.getLinkCodeWithUser('ABCD1234'));

users.deleteLinkCodesByUserId(caveman.id);
ok('deleteLinkCodesByUserId removes remaining codes regardless of used_at', !users.getLinkCodeWithUser('ABCD1234'));

// getUserAllianceIdBridge: app_users.game_name <-> players.name (case-insensitive), the
// ONLY signal /hub-api/me has for "which alliance does this hub account belong to". Two
// genuinely different null-ish outcomes must stay distinguishable to callers (see the real
// production confusion this caused, 2026-08-31 — a misleading "name bridge unresolved"
// error for an account that was actually just allianceless): no matching player row at all
// (undefined) vs. a matching player who simply has no alliance right now (a real row, with
// alliance_id null).
ok('no matching player row -> undefined (bridge itself unresolved)',
    users.getUserAllianceIdBridge(caveman.id) === undefined);

db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (701, 'Caveman2', NULL)`).run();
const bridgeNoAlliance = users.getUserAllianceIdBridge(caveman.id);
ok('a matching player with no alliance -> a real row, alliance_id null (bridge resolved, just no alliance)',
    bridgeNoAlliance && bridgeNoAlliance.alliance_id === null, bridgeNoAlliance);
ok('player_id is still returned — the fallback battle-sync needs it to search by player',
    bridgeNoAlliance && bridgeNoAlliance.player_id === 701, bridgeNoAlliance);

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (9001, 'Test Alliance', 'TA')`).run();
db.prepare(`UPDATE players SET alliance_id = 9001 WHERE id = 701`).run();
const bridgeWithAlliance = users.getUserAllianceIdBridge(caveman.id);
ok('a matching player with an alliance -> the real alliance_id',
    bridgeWithAlliance && bridgeWithAlliance.alliance_id === 9001, bridgeWithAlliance);

db.prepare(`DELETE FROM players WHERE id = 701`).run();
db.prepare(`DELETE FROM alliances WHERE id = 9001`).run();

users.deleteUser(caveman.id);
ok('deleteUser removes the row', users.getUserByGameName('Caveman2') === undefined);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
