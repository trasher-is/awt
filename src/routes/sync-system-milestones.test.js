// Regression coverage for the per-system Discord milestone plumbing added to /sync/system
// (2026-09-12): SIEGE_STARTED detection (is_sieged 0->1), the raw new_owner_alliance_tag
// carried on OWNER_CHANGE events, and the "system secured" transition
// (systemsRepo.checkAndUpdateSystemSecured) that feeds announceSystemMilestones.
//
// This drives the REAL /sync/system route end-to-end against a scratch sqlite database,
// with DISCORD_TOKEN unset so the bot never connects — announceSystemChanges/
// announceSystemMilestones correctly no-op in that state (client.isReady() is false), so
// what this test can actually observe is: the route never throws (a bug in the new event-
// building code would otherwise surface as a 500), and the systems.is_secured column ends
// up right. The wording/filtering logic itself (buildSystemMilestoneLines) has its own
// full unit coverage in system-change-lines.test.js.
//
// Run with: node src/routes/sync-system-milestones.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-system-milestones-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

// Mock the bot so the milestone events themselves are observable — with DISCORD_TOKEN unset
// the real announcer no-ops silently, which cannot distinguish "correctly stayed quiet"
// from "never got there" (2026-09-13, for the siege-allegiance rules below).
const milestoneCalls = [];
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: {
    announceSystemChanges: async () => {},
    announceSystemMilestones: async (system, events) => { milestoneCalls.push({ system, events }); },
    sendVariousChangeEmbed: async () => {},
} };

const express = require('express');
const db = require('../database');
const systemsRepo = require('../repositories/systems');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-system-milestones.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders'), (2, 'FOE', 'Enemies')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (701, 'Holder', 1), (702, 'Raider', 2)`).run();
        // friendlyAllianceTags() derives "own alliance" from alliance_member_stats (the
        // per-member sheet a real alliance-page scan populates) — without a row there, RAID
        // would never resolve as friendly, so "secured" could never fire in this test.
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (701)`).run();
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (950, 'Milestone Test System', 3, 3)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, is_sieged) VALUES (95001, 950, 1, 701, 5, 0, 0)`).run();

        const siegeEvents = () => milestoneCalls.flatMap(c => c.events).filter(e => e.type === 'SIEGE_STARTED');

        // The API's hasSiege flag is equally true for a friendly fleet in orbit (confirmed
        // live: an allied transit arriving at a RAID planet flipped it on, and the bot
        // announced an enemy attack on its own alliance). An API-sourced sync carries no
        // allegiance at all, so it must NOT be assumed hostile.
        console.log('\n── An API-only siege is stored, but never announced as an enemy ' + '─'.repeat(11));
        const siegeRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0, is_sieged: 1 }],
        });
        ok('sync succeeds (200)', siegeRes.status === 200 && siegeRes.body.success, siegeRes.body);
        const sieged = db.prepare(`SELECT is_sieged, siege_is_friendly FROM planets WHERE game_planet_id = 95001`).get();
        ok('is_sieged is stored as 1', sieged.is_sieged === 1, sieged);
        ok('allegiance is left unknown (NULL) — the API cannot tell us', sieged.siege_is_friendly === null, sieged);
        ok('no siege alert is raised on an unattributed siege', siegeEvents().length === 0, siegeEvents());
        // The seed's cue to spend one DOM page fetch here and settle whose siege it is.
        ok('the response flags the siege as needing DOM confirmation', siegeRes.body.siege_unconfirmed === true, siegeRes.body);

        console.log('\n── A DOM scrape confirming the siege is FRIENDLY still stays quiet ' + '─'.repeat(8));
        const friendlyRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0, is_sieged: 1, siege_is_friendly: true, siege_attacker_name: 'AllyRunner' }],
        });
        const friendlySiege = db.prepare(`SELECT siege_is_friendly FROM planets WHERE game_planet_id = 95001`).get();
        ok('the DOM verdict is persisted (friendly)', friendlySiege.siege_is_friendly === 1, friendlySiege);
        ok('an allied fleet in orbit raises no "enemy entered" alert', siegeEvents().length === 0, siegeEvents());
        ok('and the siege stops asking to be confirmed — one page fetch settles it for good',
            friendlyRes.body.siege_unconfirmed === false, friendlyRes.body);

        // The whole point of persisting allegiance: a siege first seen through the API is
        // already is_sieged=1 by the time the DOM confirms it hostile, so keying the alert
        // off the raw 0->1 edge would have lost it forever.
        console.log('\n── A DOM scrape confirming it HOSTILE alerts, even mid-siege ' + '─'.repeat(14));
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0, is_sieged: 1, siege_is_friendly: false, siege_attacker_name: 'GustavusSecondus' }],
        });
        const enemySiege = db.prepare(`SELECT siege_is_friendly FROM planets WHERE game_planet_id = 95001`).get();
        ok('the DOM verdict is persisted (hostile)', enemySiege.siege_is_friendly === 0, enemySiege);
        ok('exactly one siege alert is raised, naming the real attacker',
            siegeEvents().length === 1 && siegeEvents()[0].attacker_name === 'GustavusSecondus', siegeEvents());

        console.log('\n── A confirmed-hostile siege does not re-alert on every later sync ' + '─'.repeat(8));
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0, is_sieged: 1, siege_is_friendly: false, siege_attacker_name: 'GustavusSecondus' }],
        });
        ok('still exactly one alert', siegeEvents().length === 1, siegeEvents());

        console.log('\n── The siege lifting forgets the allegiance ' + '─'.repeat(31));
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0, is_sieged: 0 }],
        });
        const lifted = db.prepare(`SELECT is_sieged, siege_is_friendly FROM planets WHERE game_planet_id = 95001`).get();
        ok('is_sieged cleared and allegiance reset to unknown, so the NEXT siege starts fresh',
            lifted.is_sieged === 0 && lifted.siege_is_friendly === null, lifted);

        console.log('\n── An enemy conquest carries the raw alliance tag without crashing ' + '─'.repeat(6));
        const conquestRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 702, name: 'Raider', alliance_tag: 'FOE' }, population: 3, starbase: 0, is_sieged: 0 }],
        });
        ok('sync succeeds — new_owner_alliance_tag field does not break anything', conquestRes.status === 200 && conquestRes.body.success, conquestRes.body);
        const conquered = db.prepare(`SELECT owner_id FROM planets WHERE game_planet_id = 95001`).get();
        ok('ownership actually transferred to the enemy', conquered.owner_id === 702, conquered);

        console.log('\n── System-secured transition, end to end through the real route ' + '─'.repeat(8));
        const retakeRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 4, starbase: 0, is_sieged: 0 }],
        });
        ok('re-taking the only planet succeeds', retakeRes.status === 200 && retakeRes.body.success, retakeRes.body);
        const securedRow = db.prepare(`SELECT is_secured FROM systems WHERE id = 950`).get();
        ok('the system is now marked secured — every real owner (just RAID) is friendly',
            securedRow.is_secured === 1, securedRow);
        ok('countSecuredSystems (feeds the Various Changes aggregate milestone) reflects it',
            systemsRepo.countSecuredSystems() === 1, systemsRepo.countSecuredSystems());

        console.log('\n── Losing it again clears the secured flag, silently ' + '─'.repeat(20));
        const loseRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 702, name: 'Raider', alliance_tag: 'FOE' }, population: 2, starbase: 0, is_sieged: 0 }],
        });
        ok('the enemy retaking it succeeds', loseRes.status === 200 && loseRes.body.success, loseRes.body);
        const unsecuredRow = db.prepare(`SELECT is_secured FROM systems WHERE id = 950`).get();
        ok('is_secured is cleared back to 0', unsecuredRow.is_secured === 0, unsecuredRow);
        ok('countSecuredSystems drops back to 0', systemsRepo.countSecuredSystems() === 0, systemsRepo.countSecuredSystems());

        // 2026-09-12g: the recompute used to be nested inside `if (announceEvents.length)`,
        // so a system could only ever change secured status as a side effect of some OTHER
        // announceable event happening in the same sync. Plenty of real transitions produce
        // no event at all — a siege ENDING logs nothing, and a quietly fully-owned system
        // never generates another event to ride along with. Confirmed live: one genuinely
        // closed system sat flagged 0 while three long-since-disqualified ones sat flagged
        // 1, reporting "3 fully secured systems" when the true answer was 1.
        console.log('\n── Secured is recomputed even when nothing announceable changed ' + '─'.repeat(8));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (951, 'Quiet System', 9, 9)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, is_sieged)
                    VALUES (95101, 951, 1, 701, 6, 0, 1)`).run(); // RAID-owned but under siege -> not secured
        const siegedRow = db.prepare(`SELECT is_secured FROM systems WHERE id = 951`).get();
        ok('the besieged system starts out not secured', siegedRow.is_secured === 0, siegedRow);

        // A siege ending is the case that produces NO announceEvents whatsoever: is_sieged
        // 1->0 logs nothing, ownership and population are untouched.
        const siegeLiftedRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 951,
            planets: [{ game_planet_id: 95101, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 6, starbase: 0, is_sieged: 0 }],
        });
        ok('the siege-lifted sync succeeds', siegeLiftedRes.status === 200 && siegeLiftedRes.body.success, siegeLiftedRes.body);
        ok('the siege really was lifted in storage',
            db.prepare(`SELECT is_sieged FROM planets WHERE game_planet_id = 95101`).get().is_sieged === 0);
        const quietSecuredRow = db.prepare(`SELECT is_secured FROM systems WHERE id = 951`).get();
        ok('the system is marked secured even though that sync produced no announceable event',
            quietSecuredRow.is_secured === 1, quietSecuredRow);
        ok('countSecuredSystems picks it up for the aggregate milestone',
            systemsRepo.countSecuredSystems() === 1, systemsRepo.countSecuredSystems());

        // And the reverse: a system that quietly stops qualifying must not stay flagged.
        db.prepare(`UPDATE planets SET is_sieged = 1 WHERE game_planet_id = 95101`).run();
        const resiegedRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 951,
            planets: [{ game_planet_id: 95101, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 6, starbase: 0, is_sieged: 1 }],
        });
        ok('the re-sieged sync succeeds', resiegedRes.status === 200 && resiegedRes.body.success, resiegedRes.body);
        ok('a system that stops qualifying is un-flagged on the very next sync, not left stale',
            db.prepare(`SELECT is_secured FROM systems WHERE id = 951`).get().is_secured === 0);

        // Several members' tabs each sync the whole galaxy independently, from their own
        // account's viewpoint, and their captures differ in age. Without an ordering key an
        // older snapshot kept overwriting a newer one and the two flip-flopped forever,
        // logging an identical population-drop event (and Discord alert) every cycle.
        console.log('\n── Stale-observation guard: an older capture cannot overwrite a newer one ' + '─'.repeat(1));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (952, 'Contested System', 4, 4)`).run();
        const fresh = '2026-09-13T06:00:00.000Z';
        const stale = '2026-09-13T05:00:00.000Z';

        const freshRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 952, captured_at: fresh,
            planets: [{ game_planet_id: 95201, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0 }],
        });
        ok('the first (fresh) capture applies', freshRes.status === 200 && !freshRes.body.skipped, freshRes.body);
        ok('its observation time is recorded on the system',
            db.prepare(`SELECT observed_at FROM systems WHERE id = 952`).get().observed_at === fresh);

        const staleRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 952, captured_at: stale,
            planets: [{ game_planet_id: 95201, planet_index: 1, owner: null, population: 0, starbase: 0 }],
        });
        ok('an hour-old capture is dropped whole', staleRes.body.skipped === 'stale_observation', staleRes.body);
        const untouched = db.prepare(`SELECT owner_id, population FROM planets WHERE game_planet_id = 95201`).get();
        ok('it changed nothing — no phantom owner change, no phantom population drop',
            untouched.owner_id === 701 && untouched.population === 5, untouched);
        ok('and logged no history event for it',
            db.prepare(`SELECT COUNT(*) AS n FROM planet_events WHERE system_id = 952`).get().n === 0);

        const sameRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 952, captured_at: fresh,
            planets: [{ game_planet_id: 95201, planet_index: 1, owner: null, population: 0, starbase: 0 }],
        });
        ok('a capture equal to the one already applied is dropped too (same picture, nothing to learn)',
            sameRes.body.skipped === 'stale_observation', sameRes.body);

        // A live DOM scrape sends no captured_at: you cannot render a system page without
        // vision of it, so it is always "now" and must always win.
        const domRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 952,
            planets: [{ game_planet_id: 95201, planet_index: 1, owner: null, population: 0, starbase: 0, is_unknown: true }],
        });
        ok('a live DOM scrape (no captured_at) always applies', domRes.status === 200 && !domRes.body.skipped, domRes.body);
        ok('and it really did apply',
            db.prepare(`SELECT owner_id FROM planets WHERE game_planet_id = 95201`).get().owner_id === null);
        ok('observed_at moved forward to the DOM scrape, so older captures stay locked out',
            db.prepare(`SELECT observed_at FROM systems WHERE id = 952`).get().observed_at > fresh);
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch((err) => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
