// Which Discord alert does an incoming report belong to? (issue #143)
//
// An incoming used to be identified by "system:planet:attacker" alone. That made the
// webhook auto-post and the News-page "announce" button edit ONE message per attacker
// per planet — correct while a report is about the same fleet, wrong the moment the same
// attacker launches a second wave at the same planet: the new attack, with its own arrival
// time, silently overwrote the alert for the first one and nobody was pinged for it.
//
// The identity is now the base key PLUS the arrival time, with a tolerance:
//   • a stored row's arrival is within ARRIVAL_TOLERANCE_SEC of the reported one
//                                    -> that row's key: same fleet, re-announced (edit)
//   • a stored row has no arrival yet and was touched recently
//                                    -> that row's key, and the caller stamps the arrival on it
//   • otherwise                      -> "<base>:<arrival>": a new wave, a new message
//   • arrival unknown (0), or already in the past
//                                    -> a fresh time-less row if there is one, else the live
//                                       wave landing soonest, else the base key as before —
//                                       a reporter that drops the time must not open a
//                                       second message for a fleet already announced
//
// Both reporters carry the fleet's ARRIVAL: the webhook from the game's Discord message
// (<t:unix>, or a minute-precision date), the News page from the row's timestamp cell (it
// is passed to the interceptor maths as the impact time already). If one of them ever
// stopped carrying it, that reporter would fall into the untimed rule above rather than
// splitting every incoming into two messages.
//
// Why a tolerance and not equality: the two reporters do not agree to the second. The
// webhook falls back to a minute-precision date ("Sep 9, 2026 13:45") when the game's
// Discord message carries no <t:unix> token; the News page parses "hh:mm:ss". Two minutes
// covers that gap while still splitting waves launched further apart than that.
//
// Pure: no database access. Callers pass the rows sharing the base key (see
// src/repositories/incoming.js's findIncomingByBaseKey) so this can be tested in isolation.

const ARRIVAL_TOLERANCE_SEC = 120;
// A row that never learned its arrival (legacy key, or a report with no parseable time)
// is only treated as "the same fleet" while it is fresh — a week-old orphan must not
// swallow this week's attack the way the base-key-only design did.
const UNKNOWN_ARRIVAL_MAX_AGE_SEC = 24 * 3600;

// Shared base identity: "system:planet:attacker" (attacker lowercased, trimmed).
function baseKeyFor(data) {
    const t = (data && data.target) || {};
    const name = (data && data.attacker && data.attacker.name ? data.attacker.name : '').toLowerCase().trim();
    return `${t.systemId}:${t.planetIndex}:${name}`;
}

// The reported arrival as a positive unix second, or 0 when absent/unparseable.
function arrivalOf(data) {
    const n = parseInt(data && data.arrivalUnix, 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

function knownArrival(row) {
    const n = Number(row && row.arrival_unix);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC, no zone marker) -> unix seconds.
function updatedAtSec(row) {
    if (!row || !row.updated_at) return 0;
    const ms = Date.parse(String(row.updated_at).replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Pick the alert key for a report.
 *   rows: [{ alert_key, arrival_unix, updated_at }] — every stored incoming with this base key
 * Returns { alertKey, isNew, stampArrival }:
 *   isNew        — no stored row carries this key yet
 *   stampArrival — the caller should record the reported arrival against the key
 *                  (a fresh key, or an existing row that had no arrival yet)
 */
function pickAlertKey(baseKey, arrivalUnix, rows, opts = {}) {
    const tolerance = opts.toleranceSec != null ? opts.toleranceSec : ARRIVAL_TOLERANCE_SEC;
    const maxUnknownAge = opts.unknownMaxAgeSec != null ? opts.unknownMaxAgeSec : UNKNOWN_ARRIVAL_MAX_AGE_SEC;
    const nowSec = opts.nowSec != null ? opts.nowSec : Math.floor(Date.now() / 1000);
    const list = Array.isArray(rows) ? rows.filter(r => r && r.alert_key) : [];

    // An arrival at or before now has already landed: it cannot identify a LIVE incoming
    // (a late re-post of an old alert must not open a message for a fleet that is gone), so
    // it is treated exactly like a report that carries no time at all.
    const arrival = Number.isInteger(arrivalUnix) && arrivalUnix > nowSec ? arrivalUnix : 0;
    if (!arrival) {
        // No timing to tell waves apart. A fresh time-less row (legacy key, or an earlier
        // report without a time) is the same message as before; otherwise attach to the live
        // wave that lands soonest — the one the News page is looking at — so a reporter that
        // drops the time never opens a second message for a fleet already announced. Only
        // when nothing live is stored does the plain base key start a new row (pre-#143).
        const freshUntimed = list.filter(r => !knownArrival(r) && (nowSec - updatedAtSec(r)) <= maxUnknownAge);
        if (freshUntimed.length) {
            const legacy = freshUntimed.find(r => r.alert_key === baseKey) || freshUntimed[0];
            return { alertKey: legacy.alert_key, isNew: false, stampArrival: false };
        }
        const live = list.filter(r => knownArrival(r) > nowSec).sort((a, b) => knownArrival(a) - knownArrival(b));
        if (live.length) return { alertKey: live[0].alert_key, isNew: false, stampArrival: false };
        return { alertKey: baseKey, isNew: !list.some(r => r.alert_key === baseKey), stampArrival: false };
    }

    // 1. Same fleet, already known by its arrival: the closest row inside the tolerance.
    let best = null, bestDiff = Infinity;
    for (const r of list) {
        const a = knownArrival(r);
        if (!a) continue;
        const diff = Math.abs(a - arrival);
        if (diff <= tolerance && diff < bestDiff) { best = r; bestDiff = diff; }
    }
    if (best) return { alertKey: best.alert_key, isNew: false, stampArrival: false };

    // 2. A row announced without a time (legacy key, or an unparseable report) that is still
    //    fresh: adopt it and let the caller stamp the arrival, so the next report matches
    //    by time. Prefer the plain base key, which is what legacy rows are stored under.
    const unknown = list.filter(r => !knownArrival(r) && (nowSec - updatedAtSec(r)) <= maxUnknownAge);
    if (unknown.length) {
        const legacy = unknown.find(r => r.alert_key === baseKey) || unknown[0];
        return { alertKey: legacy.alert_key, isNew: false, stampArrival: true };
    }

    // 3. A new wave.
    return { alertKey: `${baseKey}:${arrival}`, isNew: true, stampArrival: true };
}

module.exports = { ARRIVAL_TOLERANCE_SEC, UNKNOWN_ARRIVAL_MAX_AGE_SEC, baseKeyFor, arrivalOf, pickAlertKey };
