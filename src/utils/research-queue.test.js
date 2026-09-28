// Research tracker: the queue order and finish times (research-queue.js), and the Discord
// reply built from them (research-lines.js).
//
// Run with: node src/utils/research-queue.test.js

const Q = require('../../public/js/utils/research-queue.js');
const { buildResearchOverview, buildResearchDetail, memberField } = require('./research-lines.js');

let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
}
console.log('research-queue.test.js');

const H = 3600, MIN = 60;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const base = [
    { science: 'Biology', level: 10, active_seconds: null, queued: [] },
    { science: 'Economy', level: 8, active_seconds: null, queued: [] },
    { science: 'Energy', level: 6, active_seconds: null, queued: [] },
    { science: 'Mathematics', level: 11, active_seconds: null, queued: [] },
    { science: 'Physics', level: 14, active_seconds: null, queued: [] },
    { science: 'Social', level: 9, active_seconds: null, queued: [] },
];
const rows = patch => base.map(r => Object.assign({}, r, patch[r.science] || {}));

console.log('\n── The active research leads the queue ' + '─'.repeat(36));
{
    // Physics in progress, carrying the 1 icon; Math queued 2nd, Physics again 3rd.
    const q = Q.buildQueue(rows({
        Physics: { active_seconds: 2 * H, queued: [{ slot: '1', seconds: 2 * H + 30, active: true }, { slot: '3', seconds: 5 * H }] },
        Mathematics: { queued: [{ slot: '2', seconds: 3 * H }] },
    }));
    ok('three items, in icon order', q.map(i => `${i.science} ${i.target_level}`).join(',') === 'Physics 15,Mathematics 12,Physics 16', q);
    ok('only the first is active', q[0].active && !q[1].active && !q[2].active, q);
    ok('the in-progress item uses the live countdown, not its queue timer', q[0].seconds === 2 * H, q[0]);
}
{
    // The live countdown sits on a row with no queue icon: it still goes first.
    const q = Q.buildQueue(rows({
        Energy: { active_seconds: 40 * MIN },
        Biology: { queued: [{ slot: '1', seconds: H }] },
    }));
    ok('an unflagged active row is prepended ahead of slot 1', q.map(i => `${i.science} ${i.target_level}`).join(',') === 'Energy 7,Biology 11', q);
    ok('and it is the active one', q[0].active && !q[1].active, q);
}
{
    const q = Q.buildQueue(rows({}));
    ok('nothing running and nothing queued is an empty queue', q.length === 0, q);
}
{
    const q = Q.buildQueue(rows({
        Social: { active_seconds: H, queued: [{ slot: '1', seconds: H, active: true }, { slot: 'repeat', seconds: 2 * H }] },
    }));
    ok('a repeat item is kept and flagged', q.length === 2 && q[1].repeat && q[1].target_level === 11, q);
}
{
    const q = Q.buildQueue([...rows({ Physics: { active_seconds: -5 } }), { science: 'Culture', level: 3, active_seconds: 100 }, { science: 'Physics', level: 99, active_seconds: 10 }]);
    ok('negative timers, Culture, and a duplicate science row are ignored', q.length === 0, q);
}
{
    const q = Q.buildQueue(rows({ Physics: { active_seconds: Q.MAX_SECONDS + 1 } }));
    ok('an absurd timer is a misread, not research', q.length === 0, q);
}

console.log('\n── Finish times chain; status rolls forward ' + '─'.repeat(31));
const items = Q.schedule(Q.buildQueue(rows({
    Physics: { active_seconds: 2 * H, queued: [{ slot: '1', seconds: 2 * H, active: true }] },
    Mathematics: { queued: [{ slot: '2', seconds: 3 * H }] },
})), T0);
ok('the second item starts when the first ends', items[1].starts_at_ms === items[0].finishes_at_ms && items[1].finishes_at_ms === T0 + 5 * H * 1000, items);
const snap = { name: 'Harpyie', observed_at_ms: T0, science_rate: 293.3, levels: { Physics: 14, Mathematics: 11 }, items };
{
    const st = Q.statusAt(snap, T0 + 30 * MIN * 1000);
    ok('half an hour in: Physics 15 is current and exact', st.current.science === 'Physics' && st.current_exact, st);
    ok('Math 12 is upcoming', st.upcoming.length === 1 && st.upcoming[0].target_level === 12, st.upcoming);
}
{
    const st = Q.statusAt(snap, T0 + 3 * H * 1000);
    ok('after Physics lands, Math is current but no longer exact', st.current.science === 'Mathematics' && !st.current_exact, st);
    ok('Physics counts as done', st.done.length === 1, st.done);
}
{
    const st = Q.statusAt(snap, T0 + 6 * H * 1000);
    ok('past the whole queue there is no current, and it knows when it ran out', !st.current && st.idle_since_ms === T0 + 5 * H * 1000, st);
}
ok('durations read naturally', Q.formatDuration(2 * H * 1000 + 13 * MIN * 1000) === '2h 13m' && Q.formatDuration(26 * H * 1000) === '1d 2h' && Q.formatDuration(45 * 1000) === '45s');

console.log('\n── Discord reply ' + '─'.repeat(58));
{
    const now = T0 + 47 * MIN * 1000;
    const f = memberField(snap, now);
    ok('shows the level being researched and the exact time left', /Physics 15\*\* · 1h 13m left/.test(f.value), f.value);
    ok('finish time is a Discord timestamp', f.value.includes(`<t:${Math.floor((T0 + 2 * H * 1000) / 1000)}:t>`), f.value);
    ok('lists what is queued next', /then Mathematics 12/.test(f.value), f.value);
    ok('says when the page was read', f.value.includes(`<t:${Math.floor(T0 / 1000)}:R>`), f.value);

    const later = memberField(snap, T0 + 3 * H * 1000);
    ok('a rolled-forward item is marked as approximate', /~2h 0m left/.test(later.value), later.value);
    ok('and warns nothing is queued after it', /nothing queued after this/.test(later.value), later.value);

    const idle = { name: 'Idle', observed_at_ms: T0, levels: {}, items: [] };
    const busy2 = Object.assign({}, snap, { name: 'Soon', items: Q.schedule(Q.buildQueue(rows({ Energy: { active_seconds: 10 * MIN } })), T0) });
    const o = buildResearchOverview([snap, idle, busy2], ['NoHub'], T0 + MIN * 1000);
    ok('idle members sort first, then soonest finish', o.fields.slice(0, 3).map(x => x.name).join(',') === 'Idle,Soon,Harpyie', o.fields.map(x => x.name));
    ok('the idle member says so', /nothing being researched/.test(o.fields[0].value), o.fields[0]);
    ok('members who never reported are listed, not dropped', o.fields[3].name === 'No research reported yet' && o.fields[3].value.includes('NoHub'), o.fields[3]);
    ok('every field fits Discord\'s 1024 limit', o.fields.every(x => x.value.length <= 1024));

    const stale = memberField(snap, T0 + 7 * H * 1000);
    ok('a read older than 6h is flagged', /⚠️ read/.test(stale.value), stale.value);

    const d = buildResearchDetail(snap, now);
    ok('detail lists the whole queue with levels and rate', /2\. Mathematics 12/.test(d.description) && /Phys 14/.test(d.description) && /293\.3\/h/.test(d.description), d.description);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
