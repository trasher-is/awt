#!/usr/bin/env node
// Generate travel-time fixtures from the game's own API on the TEST server.
//
// The endpoint answers for the logged-in player, so this is a calibration reference, not
// a runtime replacement — travel times for OTHER players' fleets still come from the
// local formula. Run it once, commit the fixtures, and the harness stays offline.
//
//   GET /api/v1/Fleet/travelTime?fromSystem=&fromPlanetIndex=&toSystem=&toPlanetIndex=&energyLevel=
//     -> { days, hours, minutes, seconds, timeSpan, totalSeconds }
//
// USAGE
//   1. Log in to https://test.astrowars.games in a browser.
//   2. Copy the session cookie (DevTools > Application > Cookies; you want the whole
//      "name=value; name=value" string, the .AspNetCore.* one is the important part).
//   3. AW_COOKIE='...' node scripts/collect-travel-fixtures.js
//
// OPTIONS
//   --base <url>        TEST SERVERS ONLY — see below      (default https://test.astrowars.games)
//   --player-id <id>    whose speed bonus to record        (default: derived, see below)
//   --energy 0,5,15,30  energy levels to sweep             (default 0,5,15,30,45)
//   --pairs 40          how many system pairs to try       (default 40)
//   --delay 250         politeness pause between calls     (default 250)
//   --dry               probe and report, write nothing
//   --out <path>        default src/utils/travel-fixtures.json
//
// The script never overwrites a fixture that is already in the file: it matches on the
// full input tuple and only appends new ones.
//
// ─── THIS SCRIPT HAS NEVER SUCCESSFULLY RUN ───────────────────────────────────
// Read that before trusting anything it prints. Every fixture in travel-fixtures.json is
// `"source": "measured"` — hand-observed in game. Not one came from here, because the
// script asked GET /api/v1/Player for a single player object while the published spec
// says that route answers with an ARRAY of ListPlayer, which carries no
// intelligenceReport at all. So the race-speed lookup found nothing and the run aborted
// before its first probe. It is fixed below to accept either shape, but "accepts either
// shape" is a guess made from a document, not a thing anyone has watched work.
//
// ─── WHY --base IS RESTRICTED ─────────────────────────────────────────────────
// This flag used to take any URL, which meant pointing an automated 600-call sweep at the
// production game was one word on a command line. Programmatic use of the production API
// has not been agreed with the game's administration (see issue #24), so the base is
// checked against an allowlist and everything else is refused. Widening that allowlist is
// a decision about an agreement with a person, not a code change — the same rule the
// five-per-second cap lives under.
//
// ─── WHY --delay IS NO LONGER THE RATE LIMIT ──────────────────────────────────
// A sleep in a loop bounds that loop and nothing else. Requests now go through the shared
// gate in public/js/utils/game-rate-limit.js — the same module the browser side uses,
// require()d here through its UMD wrapper — so this script counts against the same five
// per second as everything else. --delay is a courtesy pause on top of that, and setting
// it to 0 no longer removes the ceiling.

const fs = require('fs');
const path = require('path');

const model = require('../public/js/utils/travel-model.js');
const rate = require('../public/js/utils/game-rate-limit.js');

const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = name => argv.includes('--' + name);

// Hosts this script is allowed to talk to. Production is deliberately absent: nobody has
// agreed to programmatic use of it. Adding an entry here means an agreement was reached
// with the game's administration — record it in docs/ before you touch this list.
const ALLOWED_HOSTS = new Set(['test.astrowars.games', 'localhost', '127.0.0.1']);

function assertAllowedBase(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch (err) {
        throw new Error(`--base is not a URL: ${raw}`);
    }
    if (!ALLOWED_HOSTS.has(url.hostname)) {
        throw new Error(
            `Refusing to run against ${url.hostname}.\n` +
            `This script only talks to: ${[...ALLOWED_HOSTS].join(', ')}.\n` +
            `Programmatic use of the production game has not been agreed with its administration ` +
            `(issue #24), and a 600-call sweep is not the way to open that conversation.`
        );
    }
    return url.origin;
}

// GET /api/v1/Player is documented as returning ListPlayer[], but the script was written
// as though it returned the logged-in player, and no one has ever seen which is true on a
// live server. Accept both, and when it is a list say plainly that we cannot tell which
// entry is "us" rather than picking one and baking a stranger's speed bonus into every
// fixture.
function pickSelf(payload, wantedId) {
    if (payload && !Array.isArray(payload) && typeof payload === 'object') {
        if (wantedId != null && payload.id != null && String(payload.id) !== String(wantedId)) {
            throw new Error(`--player-id ${wantedId} was given but /api/v1/Player answered with player ${payload.id}`);
        }
        return payload;
    }
    if (Array.isArray(payload)) {
        if (wantedId == null) {
            throw new Error(
                `/api/v1/Player returned a list of ${payload.length} players, not the logged-in one.\n` +
                `There is no "me" endpoint in the spec, so pass --player-id <your id> and the script\n` +
                `will read your race speed from /api/v1/Player/<id> instead.`
            );
        }
        const found = payload.find(p => String(p.id) === String(wantedId));
        if (!found) throw new Error(`player ${wantedId} is not in the ${payload.length} players /api/v1/Player returned`);
        return found;
    }
    throw new Error(`/api/v1/Player returned ${typeof payload}, which is neither a player nor a list of them`);
}

// Player.origin is a Point {x, y} in the spec — it has no id — but the original code read
// player.origin.id. Accept an id, a coordinate pair, or nothing, and fall back to the
// first system with coordinates rather than crashing: the home system only decides which
// routes get sampled, not whether the samples are correct.
function resolveHome(player, systems) {
    const origin = player && player.origin;
    if (origin && origin.id != null) {
        const byId = systems.find(s => String(s.id) === String(origin.id));
        if (byId) return byId;
    }
    if (origin && origin.x != null && origin.y != null) {
        const byCoords = systems.find(s => s.x === origin.x && s.y === origin.y);
        if (byCoords) return byCoords;
    }
    return systems[0];
}

// Race speed lives on the intelligence report, which ListPlayer does not carry. Returns
// null when it cannot be read, so the caller can stop with a useful message.
function readSpeed(player) {
    const race = (player && player.intelligenceReport && player.intelligenceReport.race) || {};
    if (race.speedBonus != null) return race.speedBonus;
    if (race.speedPick != null) return race.speedPick;
    return null;
}

const BASE_RAW = flag('base', 'https://test.astrowars.games');
const ENERGY_LEVELS = flag('energy', '0,5,15,30,45').split(',').map(Number).filter(n => !isNaN(n));
const PAIR_BUDGET = parseInt(flag('pairs', '40'), 10);
const DELAY_MS = parseInt(flag('delay', '250'), 10);
const PLAYER_ID = flag('player-id', null);
const DRY = has('dry');
const OUT = path.resolve(flag('out', path.join(__dirname, '..', 'src', 'utils', 'travel-fixtures.json')));
const COOKIE = process.env.AW_COOKIE || flag('cookie', '');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same gate as the browser side, so this script's ~600 calls count against the same five
// per second as a scan running in someone's tab.
function api(base, pathAndQuery) {
    return rate.schedule(async () => {
        const res = await fetch(base + pathAndQuery, {
            headers: { Cookie: COOKIE, Accept: 'application/json' },
            redirect: 'manual'
        });
        if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
            throw new Error('401 / redirected to login — the cookie is missing, wrong or expired');
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${pathAndQuery}`);
        return res.json();
    });
}

const hms = s => model.formatTime(s);

async function main() {
    const BASE = assertAllowedBase(BASE_RAW);

    if (!COOKIE) {
        console.error('No session cookie. The API returns 401 without one:\n');
        console.error("  AW_COOKIE='.AspNetCore.Identity.Application=...' node scripts/collect-travel-fixtures.js\n");
        console.error('Log in to the test server in a browser and copy the cookie from DevTools.');
        process.exit(2);
    }

    console.log(`Base: ${BASE}`);
    console.log(`Rate: ${rate.MAX_PER_SECOND} requests per second, shared with everything else this tool does.`);

    // 1. Who are we? The endpoint bakes this player's speed bonus into every answer, so
    //    the fixture is only replayable if we record it.
    let player = pickSelf(await api(BASE, '/api/v1/Player'), PLAYER_ID);
    let speed = readSpeed(player);

    // ListPlayer has no intelligenceReport. If that is the shape we got, the full player
    // record has it — but only for an id we were told, because there is no "me" route.
    if (speed == null && player.id != null) {
        console.log(`No race data on the list entry — asking /api/v1/Player/${player.id} for the full record.`);
        player = await api(BASE, `/api/v1/Player/${player.id}`);
        speed = readSpeed(player);
    }

    const ownEnergy = player.intelligenceReport ? player.intelligenceReport.energyLevel : null;

    console.log(`Player: ${player.name} (level ${player.playerLevel})`);
    console.log(`Race speed bonus: ${speed}   account energy level: ${ownEnergy}`);
    if (speed == null) {
        console.error('\nCould not read the race speed bonus for this player.');
        console.error('Without it the fixtures cannot be replayed offline. Aborting.');
        process.exit(3);
    }

    // 2. Systems, so we can turn system ids into the (x, y) the local formula needs.
    const systems = await api(BASE, '/api/v1/SolarSystem');
    console.log(`Systems: ${systems.length}`);

    // 3. Build a grid that deliberately covers the regions the harness reports as missing:
    //    same-system hops, short/medium/long deep-space runs, Δplanet of 0 and of 11.
    const withCoords = systems.filter(s => s.x != null && s.y != null);
    if (withCoords.length < 2) throw new Error('not enough systems with coordinates');

    const home = resolveHome(player, withCoords);
    const dist = s => model.systemDistance(home.x, home.y, s.x, s.y);
    const sorted = withCoords.filter(s => s.id !== home.id).sort((a, b) => dist(a) - dist(b));

    const targets = [];
    // spread the picks across the distance range rather than taking the nearest N
    const step = Math.max(1, Math.floor(sorted.length / Math.max(1, PAIR_BUDGET - 1)));
    for (let i = 0; i < sorted.length && targets.length < PAIR_BUDGET - 1; i += step) targets.push(sorted[i]);

    const planetPairs = [[1, 1], [1, 2], [1, 7], [1, 12], [4, 4], [6, 3]];
    const probes = [];
    for (const [fp, tp] of planetPairs) probes.push({ from: home, to: home, fp, tp });   // same system
    for (const t of targets) {
        for (const [fp, tp] of [[1, 1], [1, 7], [3, 12]]) probes.push({ from: home, to: t, fp, tp });
    }

    console.log(`Probes: ${probes.length} routes × ${ENERGY_LEVELS.length} energy levels = ${probes.length * ENERGY_LEVELS.length} calls`);
    console.log(`Delay between calls: ${DELAY_MS} ms\n`);

    // 4. Walk the grid.
    const collected = [];
    const mismatches = [];
    let done = 0, errors = 0;

    for (const p of probes) {
        for (const energy of ENERGY_LEVELS) {
            const q = `/api/v1/Fleet/travelTime?fromSystem=${p.from.id}&fromPlanetIndex=${p.fp}`
                    + `&toSystem=${p.to.id}&toPlanetIndex=${p.tp}&energyLevel=${energy}`;
            let tt;
            try {
                tt = await api(BASE, q);
            } catch (err) {
                errors++;
                if (errors <= 5) console.error(`  ! ${err.message}`);
                if (/401/.test(err.message)) { console.error('\nCookie is dead — stopping.'); break; }
                await sleep(DELAY_MS);
                continue;
            }
            done++;

            const apiSeconds = Math.round(tt.totalSeconds);
            const local = model.calcTravelSeconds(
                p.from.x, p.from.y, p.fp, p.to.x, p.to.y, p.tp, energy, speed, false
            );
            if (local !== apiSeconds) {
                mismatches.push({ q, apiSeconds, local, diff: local - apiSeconds });
            }

            collected.push({
                desc: `${p.from.id === p.to.id ? 'same system' : 'deep space'} ${p.from.id}#${p.fp} -> ${p.to.id}#${p.tp}, energy ${energy}, speed ${speed >= 0 ? '+' : ''}${speed}`,
                source: 'api',
                from: [p.from.x, p.from.y, p.fp],
                to: [p.to.x, p.to.y, p.tp],
                energy,
                speed,
                alliance: false,
                expect: hms(apiSeconds)
            });

            await sleep(DELAY_MS);
        }
    }

    console.log(`\nCalls made: ${done}   errors: ${errors}`);
    console.log(`Local formula disagreed with the API on ${mismatches.length} of ${done} routes.`);
    if (mismatches.length) {
        const byDiff = mismatches.reduce((a, m) => ((a[m.diff] = (a[m.diff] || 0) + 1), a), {});
        console.log('Difference histogram (local − API, seconds):');
        for (const [d, n] of Object.entries(byDiff).sort((a, b) => Number(a[0]) - Number(b[0]))) {
            console.log(`  ${String(d).padStart(6)}s : ${n}`);
        }
        console.log('\nWorst offenders:');
        mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10)
            .forEach(m => console.log(`  ${m.diff > 0 ? '+' : ''}${m.diff}s   local ${hms(m.local)} vs api ${hms(m.apiSeconds)}   ${m.q}`));
        console.log('\nThat histogram is the answer to "where is the rounding wrong". Fix');
        console.log('public/js/utils/travel-model.js until it is empty, then commit the fixtures.');
    } else {
        console.log('The local formula reproduced every sampled route exactly.');
    }

    if (DRY) {
        console.log('\n--dry: nothing written.');
        return;
    }

    // 5. Merge into the fixtures file, never overwriting what is already there.
    const file = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const key = c => JSON.stringify([c.from, c.to, c.energy, c.speed, !!c.alliance]);
    const existing = new Set(file.cases.map(key));
    const fresh = collected.filter(c => !existing.has(key(c)));
    // de-duplicate within this run too
    const seen = new Set();
    const toAdd = fresh.filter(c => (seen.has(key(c)) ? false : (seen.add(key(c)), true)));

    file.cases.push(...toAdd);
    fs.writeFileSync(OUT, JSON.stringify(file, null, 2) + '\n');
    console.log(`\nWrote ${toAdd.length} new fixtures to ${path.relative(process.cwd(), OUT)} (${file.cases.length} total).`);
    console.log('Now run: node src/utils/travel-calc.test.js');
}

// Only sweep when run as a program. Required as a module it exposes the pieces that can
// be checked without a live server, which is how src/utils/game-traffic.test.js covers
// the base allowlist and the two response shapes that stopped this script working.
if (require.main === module) {
    main().catch(err => {
        console.error('\nFailed:', err.message);
        process.exit(1);
    });
}

module.exports = { assertAllowedBase, pickSelf, resolveHome, readSpeed, ALLOWED_HOSTS };
