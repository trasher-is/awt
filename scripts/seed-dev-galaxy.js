#!/usr/bin/env node
// Fill a DEVELOPMENT database with a synthetic galaxy so the Galaxy Archive panel can be
// opened, reviewed and screenshotted without running a scan against the live game.
//
//   node scripts/seed-dev-galaxy.js            # refuses if the database already has data
//   node scripts/seed-dev-galaxy.js --force    # wipe the synthetic tables and re-seed
//
// Everything here is invented: names come from a fixed word list, coordinates from a grid,
// alliances are called SYNTH-A..D. No player of the real game appears, which is the point —
// reviewing a map panel must not require a copy of anyone's intel, and this repository is
// public.
//
// It deliberately leaves a large share of systems with NO planet rows, because that is the
// interesting case: the map has to show "never scanned" differently from "scanned and
// empty", and a seed where everything is known would hide the bug where it does not.

const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'database'));

const FORCE = process.argv.includes('--force');

const SYLLABLES = ['ach', 'bel', 'cor', 'dra', 'eri', 'fom', 'gie', 'hyd', 'ind', 'jan', 'kel', 'lyr', 'mira', 'nash', 'orb', 'pyx', 'quel', 'rho', 'sad', 'tau', 'ura', 'vel', 'wez', 'xan', 'yed', 'zub'];

// A deterministic generator: two runs produce the same galaxy, so a screenshot taken
// yesterday still matches the data today. Date.now()/Math.random() would break that.
function makeRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function systemName(rnd, id) {
    const a = SYLLABLES[Math.floor(rnd() * SYLLABLES.length)];
    const b = SYLLABLES[Math.floor(rnd() * SYLLABLES.length)];
    return (a + b).charAt(0).toUpperCase() + (a + b).slice(1) + ' ' + id;
}

function isEmpty() {
    const n = db.prepare(`SELECT
        (SELECT COUNT(*) FROM systems) +
        (SELECT COUNT(*) FROM planets) +
        (SELECT COUNT(*) FROM players) AS total`).get();
    return n.total === 0;
}

function wipe() {
    db.exec(`
        DELETE FROM alliance_member_stats;
        DELETE FROM planets;
        DELETE FROM players;
        DELETE FROM alliances;
        DELETE FROM systems;
    `);
}

function seed() {
    const rnd = makeRandom(20260802);

    const GRID = 13;                 // 13 x 13 = 169 systems, close to a real galaxy's size
    const SCANNED_SHARE = 0.55;      // the rest have never been visited — that is the point
    const ALLIANCES = [
        { id: 1, tag: 'SYNT', name: 'Synthetic Vanguard' },
        { id: 2, tag: 'ECHO', name: 'Echo Compact' },
        { id: 3, tag: 'RUST', name: 'Rust Hegemony' },
        { id: 4, tag: 'VOID', name: 'Void Syndicate' },
    ];

    const insertAlliance = db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?)`);
    const insertSystem = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`);
    const insertPlayer = db.prepare(`
        INSERT INTO players (id, name, alliance_id, origin_system, biology, science_level, points, level)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPlanet = db.prepare(`
        INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, is_sieged)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertMember = db.prepare(`INSERT INTO alliance_member_stats (player_id, population) VALUES (?, ?)`);

    const run = db.transaction(() => {
        for (const a of ALLIANCES) insertAlliance.run(a.id, a.tag, a.name);

        const systems = [];
        let id = 1;
        for (let gx = 0; gx < GRID; gx++) {
            for (let gy = 0; gy < GRID; gy++) {
                const x = gx - Math.floor(GRID / 2);
                const y = gy - Math.floor(GRID / 2);
                insertSystem.run(id, systemName(rnd, id), x, y);
                systems.push({ id, x, y });
                id++;
            }
        }

        // Players: 8 of ours, 18 of everyone else's. Ours get an origin system and a
        // biology level so the vision layer has something to draw; a couple deliberately
        // have biology 0 so the science-level fallback is exercised on screen.
        // Vision radii are kept small on purpose. With radius 7 on a 13-wide grid a single
        // member sees the whole galaxy, the vision layer lights up everything, and a layer
        // that is always on shows nothing. Two members get biology 0 so the science-level
        // fallback is visible on screen — that fallback is the bug vision-model.js closes.
        let playerId = 100;
        const ours = [];
        for (let i = 0; i < 8; i++) {
            const origin = systems[Math.floor(rnd() * systems.length)];
            const biology = i < 2 ? 0 : 2 + Math.floor(rnd() * 3);
            insertPlayer.run(playerId, `SynthMember${i + 1}`, 1, origin.id, biology, 2 + Math.floor(rnd() * 3), 10000 + i * 137, 20 + i);
            insertMember.run(playerId, 1000 + i * 10);
            ours.push(playerId);
            playerId++;
        }
        const others = [];
        for (let i = 0; i < 18; i++) {
            const allianceId = 2 + (i % 3);
            const origin = systems[Math.floor(rnd() * systems.length)];
            insertPlayer.run(playerId, `SynthRival${i + 1}`, allianceId, origin.id, 0, 1 + Math.floor(rnd() * 4), 5000 + i * 91, 8 + i);
            others.push(playerId);
            playerId++;
        }

        const everyone = [...ours, ...others];
        let planetKey = 1;
        for (const s of systems) {
            if (rnd() > SCANNED_SHARE) continue;              // never scanned: no rows at all
            const planets = 4 + Math.floor(rnd() * 9);

            // Free planets are decided per SYSTEM, not per planet. Rolling per planet meant
            // almost every system ended up with at least one, and the "free planets" layer
            // highlighted the entire galaxy.
            const hasFree = rnd() < 0.3;
            const freeCount = hasFree ? 1 + Math.floor(rnd() * 3) : 0;

            for (let index = 1; index <= planets; index++) {
                const free = index <= freeCount;
                const owner = free ? null : everyone[Math.floor(rnd() * everyone.length)];
                insertPlanet.run(
                    planetKey++, s.id, index, owner,
                    owner ? 200 + Math.floor(rnd() * 5000) : 0,
                    owner ? Math.floor(rnd() * 6) : 0,
                    owner && rnd() < 0.04 ? 1 : 0
                );
            }
        }
    });

    run();
}

if (!FORCE && !isEmpty()) {
    console.error('This database already has systems, planets or players in it.');
    console.error('Seeding would delete them. Re-run with --force if that is what you want,');
    console.error('and be certain it is not the production database.');
    process.exit(2);
}

if (FORCE) wipe();
seed();

const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM systems) AS systems,
    (SELECT COUNT(*) FROM planets) AS planets,
    (SELECT COUNT(*) FROM players) AS players,
    (SELECT COUNT(DISTINCT system_id) FROM planets) AS scanned`).get();

console.log(`Seeded ${counts.systems} systems, ${counts.scanned} of them scanned (${counts.systems - counts.scanned} never visited),`);
console.log(`${counts.planets} planets and ${counts.players} players. All synthetic.`);
console.log('Open the dashboard and click Galaxy Archive in the sidebar.');
