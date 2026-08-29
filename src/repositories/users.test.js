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

users.deleteUser(caveman.id);
ok('deleteUser removes the row', users.getUserByGameName('Caveman2') === undefined);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
