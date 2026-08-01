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
//   --base <url>        default https://test.astrowars.games
//   --energy 0,5,15,30  energy levels to sweep       (default 0,5,15,30,45)
//   --pairs 40          how many system pairs to try (default 40)
//   --delay 250         milliseconds between calls   (default 250)
//   --dry               probe and report, write nothing
//   --out <path>        default src/utils/travel-fixtures.json
//
// The script never overwrites a fixture that is already in the file: it matches on the
// full input tuple and only appends new ones.

const fs = require('fs');
const path = require('path');

const model = require('../public/js/utils/travel-model.js');

const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = name => argv.includes('--' + name);

const BASE = flag('base', 'https://test.astrowars.games').replace(/\/$/, '');
const ENERGY_LEVELS = flag('energy', '0,5,15,30,45').split(',').map(Number).filter(n => !isNaN(n));
const PAIR_BUDGET = parseInt(flag('pairs', '40'), 10);
const DELAY_MS = parseInt(flag('delay', '250'), 10);
const DRY = has('dry');
const OUT = path.resolve(flag('out', path.join(__dirname, '..', 'src', 'utils', 'travel-fixtures.json')));
const COOKIE = process.env.AW_COOKIE || flag('cookie', '');

const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!COOKIE) {
    console.error('No session cookie. The API returns 401 without one:\n');
    console.error("  AW_COOKIE='.AspNetCore.Identity.Application=...' node scripts/collect-travel-fixtures.js\n");
    console.error('Log in to the test server in a browser and copy the cookie from DevTools.');
    process.exit(2);
}

async function api(pathAndQuery) {
    const res = await fetch(BASE + pathAndQuery, {
        headers: { Cookie: COOKIE, Accept: 'application/json' },
        redirect: 'manual'
    });
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
        throw new Error('401 / redirected to login — the cookie is missing, wrong or expired');
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${pathAndQuery}`);
    return res.json();
}

const hms = s => model.formatTime(s);

(async () => {
    console.log(`Base: ${BASE}`);

    // 1. Who are we? The endpoint bakes this player's speed bonus into every answer, so
    //    the fixture is only replayable if we record it.
    const player = await api('/api/v1/Player');
    const race = (player.intelligenceReport && player.intelligenceReport.race) || {};
    const speed = race.speedBonus != null ? race.speedBonus : (race.speedPick != null ? race.speedPick : null);
    const ownEnergy = player.intelligenceReport ? player.intelligenceReport.energyLevel : null;

    console.log(`Player: ${player.name} (level ${player.playerLevel})`);
    console.log(`Race speed bonus: ${speed}   account energy level: ${ownEnergy}`);
    if (speed == null) {
        console.error('\nCould not read the race speed bonus from /api/v1/Player.');
        console.error('Without it the fixtures cannot be replayed offline. Aborting.');
        process.exit(3);
    }

    // 2. Systems, so we can turn system ids into the (x, y) the local formula needs.
    const systems = await api('/api/v1/SolarSystem');
    const byId = new Map(systems.map(s => [s.id, s]));
    console.log(`Systems: ${systems.length}`);

    // 3. Build a grid that deliberately covers the regions the harness reports as missing:
    //    same-system hops, short/medium/long deep-space runs, Δplanet of 0 and of 11.
    const withCoords = systems.filter(s => s.x != null && s.y != null);
    if (withCoords.length < 2) throw new Error('not enough systems with coordinates');

    const home = withCoords.find(s => s.id === (player.origin && player.origin.id)) || withCoords[0];
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
                tt = await api(q);
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
})().catch(err => {
    console.error('\nFailed:', err.message);
    process.exit(1);
});
