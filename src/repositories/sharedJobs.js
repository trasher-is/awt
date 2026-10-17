const db = require('../database');
const { nextDailyWindow } = require('../../public/js/utils/daily-reset.js');

// Background jobs the whole hub shares, run from ONE member's browser at a time.
//
// Every request a job sends to the game rides on that member's own game session and counts
// as them being active there (2026-10-16). So instead of every open hub tab running every
// job on its own clock, a job is claimed here first, and a claim is granted only when:
//
//   • intervalMs has passed since anyone last ran it (hub-wide, not per browser) — or, for
//     a `daily` job, the game's daily reset (00:00 Berlin, +5 min) has passed since — AND
//   • the member asking is not the one who ran it last — unless that last run was at least
//     sameMemberMs ago. With several members online the job rotates, one then another;
//     with only one member online it runs for them at most every sameMemberMs.
//
// A claim is recorded the moment it is granted, so two browsers asking at once cannot both
// win (better-sqlite3 runs the transaction synchronously).
//
// The manual scan buttons are recorded here too (record()), so every button can say when
// it last ran and who ran it. They are member clicks, so they are never refused.
const HOUR = 60 * 60 * 1000;
const RESET_BUFFER_MINUTES = 5;
const JOBS = {
    // Rankings only change once a day in-game: once per game day, after the reset.
    // Battle reports are published at the reset too: battle-sync pulls them at 00:05 and
    // their details are fetched once, 30 min later, after that pull has stored them.
    'battle-sync':                { daily: true,                sameMemberMs: 6 * HOUR },
    'battle-report-detail':       { daily: true, resetBufferMinutes: 30, sameMemberMs: 6 * HOUR },
    'ranking-highest-population': { daily: true,                sameMemberMs: 6 * HOUR },
    'ranking-best-planets':       { daily: true,                sameMemberMs: 6 * HOUR },
    'ranking-bonus-goals':        { daily: true,                sameMemberMs: 6 * HOUR },
    // Manual buttons only: recorded, never claimed. The galaxy seed was a 10-minute rotating
    // job until 2026-10-17; a stale tab still asking to claim it is refused.
    'galaxy-seed':                null,
    'player-api-scan':            null,
    'player-page-scan':           null,
};

const getStmt = db.prepare(`SELECT job, last_user_id, last_game_name, last_at_ms FROM shared_jobs WHERE job = ?`);
const allStmt = db.prepare(`SELECT job, last_user_id, last_game_name, last_at_ms FROM shared_jobs`);
const upsertStmt = db.prepare(`
    INSERT INTO shared_jobs (job, last_user_id, last_game_name, last_at_ms) VALUES (@job, @userId, @gameName, @at)
    ON CONFLICT(job) DO UPDATE SET last_user_id = excluded.last_user_id,
        last_game_name = excluded.last_game_name, last_at_ms = excluded.last_at_ms
`);

const isJob = job => Object.prototype.hasOwnProperty.call(JOBS, job);
const isClaimable = job => isJob(job) && JOBS[job] !== null;

function actorOf(actor) {
    return {
        userId: actor && Number.isInteger(actor.userId) ? actor.userId : null,
        gameName: actor && actor.gameName ? String(actor.gameName).slice(0, 64) : null,
    };
}

// When `userId` may next run `job`, given its last run (null = never ran: now).
function nextAllowedAt(job, row, userId) {
    if (!row) return 0;
    const { intervalMs, daily, resetBufferMinutes = RESET_BUFFER_MINUTES, sameMemberMs } = JOBS[job];
    const anyone = daily
        ? nextDailyWindow(resetBufferMinutes, new Date(row.last_at_ms)).getTime()
        : row.last_at_ms + intervalMs;
    const sameMember = userId != null && row.last_user_id === userId;
    return sameMember ? Math.max(anyone, row.last_at_ms + sameMemberMs) : anyone;
}

const claimTx = db.transaction((job, actor, now) => {
    const row = getStmt.get(job);
    const at = nextAllowedAt(job, row, actor.userId);
    if (now < at) return { granted: false, next_at_ms: at, last: row };
    upsertStmt.run({ job, ...actor, at: now });
    return { granted: true, last: row };
});

function claim(job, actor, now = Date.now()) {
    if (!isClaimable(job)) throw new Error(`unknown shared job: ${job}`);
    return claimTx(job, actorOf(actor), now);
}

function record(job, actor, now = Date.now()) {
    if (!isJob(job)) throw new Error(`unknown shared job: ${job}`);
    upsertStmt.run({ job, ...actorOf(actor), at: now });
}

function status() {
    const out = {};
    for (const row of allStmt.all()) {
        if (!isJob(row.job)) continue;
        out[row.job] = { last_at_ms: row.last_at_ms, last_by: row.last_game_name };
    }
    return out;
}

module.exports = { JOBS, claim, record, status, isJob, isClaimable, nextAllowedAt };
