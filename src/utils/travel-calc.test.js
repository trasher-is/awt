// Travel-time formula calibration harness.
//
// Run with:  node src/utils/travel-calc.test.js
//
// The Discord alerts (and !tt / !ghosts) use calcTravelSeconds. To verify/fix the
// formula we need GROUND TRUTH from the game: open a fleet deployment ("Deploy a
// fleet to this location") and read the exact travel time the game shows for a known
// route + your energy + race_speed. Add one CASE per measurement below.
//
// For each case fill in:
//   from:    [systemX, systemY, planetIndex]   (origin)
//   to:      [systemX, systemY, planetIndex]   (destination)
//   energy:  attacker's Energy science level
//   speed:   attacker's race_speed modifier (-4..+4)
//   alliance:true if it's an allied (50%) move, else false
//   expect:  "HH:MM:SS" exactly as the game displays it
//
// System coords come from the `systems` table (x,y). Get them with:
//   sqlite3 awt.db "SELECT id,name,x,y FROM systems WHERE id IN (137, ...);"

const { calcTravelSeconds, formatTime } = require('./travel-calc');

const hmsToSecs = (s) => {
    const [h, m, sec] = s.split(':').map(Number);
    return h * 3600 + m * 60 + sec;
};

// ─── FILL THESE IN WITH REAL MEASUREMENTS ──────────────────────────────
const CASES = [
    // { desc: 'same-system 1→6, eng 5, spd 0',
    //   from: [100, 200, 1], to: [100, 200, 6], energy: 5, speed: 0, alliance: false,
    //   expect: '01:23:45' },
    //
    // { desc: 'deep space A→B, eng 8, spd 2',
    //   from: [100, 200, 3], to: [140, 215, 4], energy: 8, speed: 2, alliance: false,
    //   expect: '03:10:00' },

    { desc: 'same-system 1→6, eng 9, spd +4',
    from: [100, 200, 1], to: [100, 200, 6], energy: 9, speed: 4, alliance: false,
    expect: '03:14:42' },

    { desc: 'same-system 1→12, eng 15, spd -2',
    from: [100, 200, 1], to: [100, 200, 12], energy: 15, speed: -2, alliance: false,
    expect: '04:39:01' },

    { desc: 'same-system 1→12, eng 27, spd -4',
    from: [100, 200, 1], to: [100, 200, 12], energy: 27, speed: -4, alliance: false,
    expect: '02:16:20' },

    { desc: 'same-system 1→2, eng 0, spd 0',
    from: [100, 200, 1], to: [100, 200, 2], energy: 0, speed: 0, alliance: false,
    expect: '05:59:24' },

    { desc: 'same-system 1→3, eng 0, spd 0',
    from: [100, 200, 1], to: [100, 200, 3], energy: 0, speed: 0, alliance: false,
    expect: '07:15:41' },

    { desc: 'same-system 1→12, eng 0, spd 0',
    from: [100, 200, 1], to: [100, 200, 12], energy: 0, speed: 0, alliance: false,
    expect: '14:11:23' },

    { desc: 'deep space A→B, eng 8, spd 2',
    from: [-20, -22, 1], to: [-6, 3, 6], energy: 8, speed: 2, alliance: false,
    expect: '112:08:18' },

    { desc: 'deep space A→B, eng 25, spd 1',
    from: [-4, -1, 4], to: [-2, -8, 10], energy: 25, speed: 1, alliance: true,
    expect: '03:35:27' },

    { desc: 'deep space A→B, eng 45, spd 4',
    from: [0, 0, 1], to: [22, 15, 12], energy: 45, speed: 4, alliance: false,
    expect: '03:26:16' },

];
// ───────────────────────────────────────────────────────────────────────

if (CASES.length === 0) {
    console.log('No calibration cases yet. Add real game measurements to CASES[] and re-run.');
    process.exit(0);
}

let worst = 0;
for (const c of CASES) {
    const [sx, sy, sp] = c.from;
    const [ex, ey, ep] = c.to;
    const got = calcTravelSeconds(sx, sy, sp, ex, ey, ep, c.energy, c.speed, c.alliance);
    const want = hmsToSecs(c.expect);
    const errPct = want ? Math.abs(got - want) / want * 100 : 0;
    worst = Math.max(worst, errPct);
    const flag = errPct <= 2 ? '✅' : errPct <= 10 ? '⚠️ ' : '❌';
    console.log(`${flag} ${c.desc}`);
    console.log(`     got ${formatTime(got)} (${got}s)  want ${c.expect} (${want}s)  err ${errPct.toFixed(1)}%`);
}
console.log(`\nWorst error: ${worst.toFixed(1)}%`);
process.exit(worst <= 2 ? 0 : 1);
