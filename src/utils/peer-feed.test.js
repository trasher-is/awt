// The outbound peer feed: what a partner hub can read from us.
//
// What matters: a link only reads the kinds it was granted; only listed fields leave;
// friendly and hand-excluded alliances stay out; paging never repeats or skips a row even
// when hundreds share one second, and a window made only of excluded rows still advances;
// and intel received FROM a partner is never served onward to anyone.
//
// All names and numbers are invented. Run with: node src/utils/peer-feed.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-peer-feed-test-')), 'test.db');
delete process.env.DISCORD_TOKEN;

const db = require('../database');
const peersRepo = require('../repositories/peers');
const settingsRepo = require('../repositories/settings');
const { buildFeedPage } = require('./peer-feed');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) console.log(`  ok - ${desc}`);
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
function throwsStatus(fn) { try { fn(); return null; } catch (e) { return e.status || 'no-status'; } }

console.log('peer-feed.test.js');

// ─── synthetic galaxy ───
const T1 = '2026-10-01 10:00:00';
const T2 = '2026-10-01 11:00:00';
db.prepare(`INSERT INTO alliances (id, name, tag, updated_at) VALUES (1, 'Friendly Folk', 'FRND', ?), (2, 'Them', 'THEM', ?), (3, 'Others', 'OTHR', ?)`).run(T1, T1, T1);
const insPlayer = db.prepare(`INSERT INTO players (id, name, alliance_id, country, race_attack, physics, intel_entered_by, intel_visible, has_intel, updated_at) VALUES (?, ?, ?, 'XX', 2, 7, 'SomeMember', 1, 1, ?)`);
insPlayer.run(10, 'Fren', 1, T1);
insPlayer.run(20, 'Foe', 2, T1);
insPlayer.run(30, 'Other', 3, T2);
insPlayer.run(40, 'Loner', null, T2);
db.prepare(`INSERT INTO players (id, name, alliance_id, has_intel, updated_at) VALUES (45, 'NoReport', 2, 0, ?)`).run(T2);
db.prepare(`INSERT INTO systems (id, name, x, y, updated_at) VALUES (100, 'Alpha', 1, 2, ?)`).run(T1);
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, is_ally, has_fleet, is_sieged, updated_at)
            VALUES (1001, 100, 1, 10, 9, 4, 1, 1, 0, ?), (1002, 100, 2, 20, 5, 2, 0, 1, 1, ?)`).run(T2, T2);
db.prepare(`INSERT INTO fleets (owner_id, system_id, planet_index, destroyers, combat_value, updated_at) VALUES (10, 100, 1, 50, 500, ?), (20, 100, 2, 7, 70, ?)`).run(T1, T1);
db.prepare(`INSERT INTO battle_reports (id, att_alliance_tag, def_alliance_tag, att_player_name, def_player_name, winner, announced, created_at)
            VALUES (500, 'THEM', 'OTHR', 'Foe', 'Other', 'att', 1, ?), (501, 'THEM', 'FRND', 'Foe', 'Fren', 'def', 1, ?)`).run(T1, T1);

settingsRepo.setSetting('alliance_relations_allied', 'FRND');

const all = ['systems', 'players', 'alliances', 'fleets', 'fleet_locations', 'incomings', 'battle_reports'];
const link = (over = {}) => Object.assign({ id: 1, scopes: all, excludeTags: [] }, over);
const keys = page => page.items.map(i => i.key);

// ─── scopes ───
ok('a kind the link was not granted is refused with 403', throwsStatus(() => buildFeedPage(link({ scopes: ['systems'] }), 'players')) === 403);
ok('an unknown kind is a 400', throwsStatus(() => buildFeedPage(link(), 'app_users')) === 400);
ok('a garbage cursor is a 400', throwsStatus(() => buildFeedPage(link(), 'players', { after: "x' OR 1=1" })) === 400);

// ─── fields ───
const players = buildFeedPage(link(), 'players');
const foe = players.items.find(i => i.key === '20');
ok('player intel fields are shared', foe && foe.data.race_attack === 2 && foe.data.physics === 7 && foe.data.alliance_tag === 'THEM', foe);
ok('country, who entered the intel, and our own visibility flags do not leave', foe
    && !('country' in foe.data) && !('intel_entered_by' in foe.data) && !('intel_visible' in foe.data), foe && Object.keys(foe.data));

// ─── exclusion ───
ok('an allied (friendly) alliance\'s players are not in the feed', !keys(players).includes('10'), keys(players));
ok('unallied and alliance-less players are', ['20', '30', '40'].every(k => keys(players).includes(k)), keys(players));
ok('a player we hold no intel report on is not shared', !keys(players).includes('45'), keys(players));
ok('a link cannot opt back in to an allied (NAP) alliance', !keys(buildFeedPage(link({ excludeFriendly: false }), 'players')).includes('10'));
ok('a hand-excluded tag is honoured', !keys(buildFeedPage(link({ excludeTags: ['othr'] }), 'players')).includes('30'));

const fleets = buildFeedPage(link(), 'fleets');
ok('fleets owned by friendly players are not shared', fleets.items.length === 1 && fleets.items[0].data.owner_tag === 'THEM', fleets.items);

const reports = buildFeedPage(link(), 'battle_reports');
ok('a battle involving a friendly alliance on either side is not shared', keys(reports).join() === '500', keys(reports));
ok('battle bookkeeping (announced) does not leave', reports.items[0] && !('announced' in reports.items[0].data));

const systems = buildFeedPage(link(), 'systems');
const alpha = systems.items[0];
ok('systems are shared with their planets', alpha && alpha.data.planets.length === 2, alpha);
ok('a system\'s changed_at follows its newest planet', alpha && alpha.changedAt === T2, alpha && alpha.changedAt);
const fp = alpha && alpha.data.planets.find(p => p.planet_index === 1);
const ep = alpha && alpha.data.planets.find(p => p.planet_index === 2);
ok('a friendly planet keeps owner and population but loses starbase/fleet/siege', fp && fp.owner_id === 10 && fp.population === 9
    && fp.starbase === null && fp.has_fleet === null && fp.is_sieged === null, fp);
ok('an enemy planet keeps its defence details', ep && ep.starbase === 2 && ep.has_fleet === 1 && ep.is_sieged === 1, ep);
ok('our own is_ally flag never leaves', fp && !('is_ally' in fp));

// ─── fleet locations ───
const insRanked = db.prepare(`INSERT INTO strongest_fleet (player_id, rank, destroyers, cruisers, battleships, cv, system_id, planet_index, planet_label, updated_at)
                              VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`);
insRanked.run(20, 3, 30, 300, 100, 2, 'Alpha 2', '2026-10-01T12:00:00.000Z');
insRanked.run(20, 1, 90, 900, null, null, 'Nowhere 4', '2026-10-01T12:00:00.000Z');
insRanked.run(10, 2, 60, 600, 100, 1, 'Alpha 1', '2026-10-01T12:00:00.000Z');
const located = buildFeedPage(link(), 'fleet_locations');
const foeFleets = located.items.find(i => i.key === '20');
ok('fleet locations come as one item per player, fleets in rank order', foeFleets && foeFleets.data.fleets.map(f => f.rank).join() === '1,3', foeFleets);
ok('a ranked fleet carries its system name and the ranking\'s own label', foeFleets
    && foeFleets.data.fleets[1].system_name === 'Alpha' && foeFleets.data.fleets[0].planet_label === 'Nowhere 4', foeFleets);
ok('the ranking\'s ISO timestamp becomes a feed timestamp', foeFleets && foeFleets.changedAt === '2026-10-01 12:00:00', foeFleets && foeFleets.changedAt);
ok('a friendly player\'s fleet locations are not shared', !keys(located).includes('10'), keys(located));
db.prepare(`DELETE FROM strongest_fleet WHERE player_id = 20`).run();
insRanked.run(20, 2, 95, 950, 100, 2, 'Alpha 2', '2026-10-02T12:00:00.000Z');
const relocated = buildFeedPage(link(), 'fleet_locations', { after: located.next });
ok('a re-scrape (new row ids) updates the same player item instead of adding one', keys(relocated).join() === '20'
    && relocated.items[0].data.fleets.length === 1 && relocated.items[0].data.fleets[0].cv === 950, relocated.items);

// ─── incomings ───
const insIncoming = db.prepare(`INSERT INTO incoming_msgs (alert_key, channel_id, message_id, covering, payload, updated_at) VALUES (?, 'chan-1', 'msg-1', 'CoverMember', ?, ?)`);
const report = (tag, name) => JSON.stringify({ attacker: { id: 20, name, tag }, target: { systemId: 100, planetIndex: 1, planetName: 'Alpha 1' },
    cv: 420, ships: { transports: 5, destroyers: 40, cruisers: 2, battleships: 0 }, arrivalUnix: 1790000000, fleetId: 4242 });
insIncoming.run('100:1:foe', report('THEM', 'Foe'), T1);
insIncoming.run('100:1:fren', report('FRND', 'Fren'), T1);
db.prepare(`INSERT INTO incoming_msgs (alert_key, channel_id, message_id, updated_at) VALUES ('100:2:noreport', 'c', 'm', ?)`).run(T1);
const inc = buildFeedPage(link(), 'incomings');
const hit = inc.items[0];
ok('only incomings with a stored report are shared, and a friendly attacker\'s is not', inc.items.length === 1 && hit.data.attacker_name === 'Foe', inc.items);
ok('an incoming carries attacker, target, ships, CV and arrival', hit && hit.data.target_system_id === 100 && hit.data.target_planet_index === 1
    && hit.data.destroyers === 40 && hit.data.transports === 5 && hit.data.cv === 420 && hit.data.arrival_unix === 1790000000, hit);
const incJson = JSON.stringify(inc);
ok('who covers it, the Discord message and the game fleet id never leave', !incJson.includes('CoverMember') && !incJson.includes('chan-1')
    && !incJson.includes('msg-1') && !incJson.includes('4242'), incJson);

// ─── our own alliance, before the roster scrape has ever run ───
// No alliance_member_stats rows exist in this database, so friendlyAllianceTags() cannot
// know our tag. A hub account playing in OTHR must still be enough to hide OTHR.
db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('other', 'x', 'user')`).run();
ok('a hub member\'s own alliance is hidden even before the roster scrape', !keys(buildFeedPage(link(), 'players')).includes('30'));
ok('…and no link can opt back in to it', !keys(buildFeedPage(link({ excludeFriendly: false }), 'players')).includes('30'));
db.prepare(`DELETE FROM app_users WHERE game_name = 'other'`).run();

// ─── paging ───
const T3 = '2026-10-02 09:00:00';
const bulk = db.prepare(`INSERT INTO players (id, name, alliance_id, has_intel, updated_at) VALUES (?, ?, ?, 1, ?)`);
db.transaction(() => {
    // 1200 friendly players first, so whole windows are made of excluded rows...
    for (let i = 0; i < 1200; i++) bulk.run(1000 + i, `F${i}`, 1, T3);
    // ...then 700 visible ones in the very same second.
    for (let i = 0; i < 700; i++) bulk.run(5000 + i, `V${i}`, 2, T3);
})();
const seen = [];
let cursor = '', pages = 0, emptyButMore = false;
for (;;) {
    const page = buildFeedPage(link(), 'players', { after: cursor });
    pages++;
    if (page.items.length === 0 && page.more) emptyButMore = true;
    seen.push(...keys(page));
    cursor = page.next;
    if (!page.more) break;
    if (pages > 20) break;
}
ok('a window of only excluded rows still advances the cursor', emptyButMore);
ok('every visible player arrives exactly once across pages', seen.length === new Set(seen).size && seen.length === 3 + 700, { n: seen.length, uniq: new Set(seen).size });
const again = buildFeedPage(link(), 'players', { after: cursor });
ok('reading again from the final cursor returns nothing new', again.items.length === 0 && !again.more, again);
db.prepare(`UPDATE players SET points = 99, updated_at = '2026-10-03 00:00:00' WHERE id = 20`).run();
const changed = buildFeedPage(link(), 'players', { after: cursor });
ok('a later change to a row is picked up from the old cursor', keys(changed).join() === '20' && changed.items[0].data.points === 99, keys(changed));

// ─── no re-sharing ───
const src = peersRepo.createSource({ name: 'Partner', baseUrl: 'https://partner.example', token: 'awtp_' + 'x'.repeat(40) });
peersRepo.storePage(src.id, 'players', [{ key: '777777', changedAt: '2026-10-05 00:00:00', data: { name: 'ReceivedFromPartner' } }], null);
peersRepo.storePage(src.id, 'systems', [{ key: '888888', changedAt: '2026-10-05 00:00:00', data: { name: 'PartnerSystem', planets: [] } }], null);
const everything = [];
for (const kind of all) {
    let c = '';
    for (let i = 0; i < 20; i++) {
        const p = buildFeedPage(link(), kind, { after: c });
        everything.push(...p.items.map(it => JSON.stringify(it)));
        if (!p.more) break;
        c = p.next;
    }
}
ok('intel received from a partner never appears in our own feed', !everything.some(s => s.includes('ReceivedFromPartner') || s.includes('PartnerSystem') || s.includes('777777') || s.includes('888888')));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
