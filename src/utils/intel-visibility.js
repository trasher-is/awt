// Decides what, if anything, to announce when a player sync reports whether the alliance
// can currently see that player's intelligence report.
//
// The game's Player detail carries an intelligenceReport whenever ANY alliance member has
// vision — it names the capturer (capturedByPlayerName: "Moardin25") — and null when nobody
// does. So the background sweep already observes real, alliance-wide visibility on every
// pass; the hub was simply discarding the zeros, because players.has_intel latches to 1 the
// first time anyone captures a report and can therefore only ever answer "have we ever seen
// them", never "can we see them now".
//
// WHY A RAW EDGE IS NOT NEWS: vision flickers as fleets drift in and out of range —
// confirmed live, a report captured at 14:10:33 was gone again minutes later. Announcing
// every flip would reproduce the population flip-flop in a different channel. So a change
// has to hold across TWO CONSECUTIVE observations before it counts. At one sweep call per
// 30s across ~160 players each player is revisited roughly every 80 minutes, so that alone
// means a wobble shorter than a couple of hours never reaches the channel.
//
// The "first ever" case is exempt: has_intel can only go 0 -> 1 once in a player's life, so
// there is nothing for it to flap against.

const PLAIN_LOST = 'lost';
const PLAIN_REGAINED = 'regained';
const FIRST_EVER = 'first_ever';

// decide({ prior, observedVisible, now, repeatWindowMs })
//   prior            the players row as it was BEFORE this sync's upsert (null for a
//                    player the hub has never stored), carrying has_intel, intel_visible,
//                    intel_seen_raw and the two per-direction announcement stamps.
//   observedVisible  what this sync saw: true when an intelligenceReport was present.
//
// Returns { announce, confirmedVisible, seenRaw } — announce is null, 'first_ever', 'lost'
// or 'regained'. The caller persists confirmedVisible/seenRaw regardless of whether
// anything is announced; suppressing an announcement must never suppress the bookkeeping,
// or the next pass compares against a state that never happened.
function decideIntelVisibilityChange({ prior, observedVisible, now = new Date(), repeatWindowMs = 12 * 60 * 60 * 1000 }) {
    const seenRaw = observedVisible ? 1 : 0;

    // Never stored: this sync is the first thing we know. Record, say nothing.
    if (!prior) return { announce: null, confirmedVisible: seenRaw, seenRaw };

    // First capture ever. Checked against has_intel rather than the confirmed state,
    // because that is the only field that distinguishes "never seen in this whole round"
    // from "seen before, lost, and now back". Immediate: it cannot repeat.
    //
    // Deliberately BEFORE the "no baseline yet" check below (2026-09-14 fix): a genuinely
    // brand-new player's row carries intel_visible: null right up until their first real
    // detail sync, and if THAT sync is the one that captures them, the no-baseline branch
    // used to intercept it first and record the capture silently — the exact case this
    // comment already claimed was exempt from needing a baseline, but the code never
    // actually reached this check to honor it. Confirmed live: Karmakazi's first-ever
    // capture went unannounced this way. A first-ever capture cannot be a flap by
    // definition, so it never needed a baseline to compare against in the first place.
    if (!prior.has_intel && seenRaw === 1) {
        return { announce: FIRST_EVER, confirmedVisible: 1, seenRaw };
    }

    const confirmed = prior.intel_visible === null || prior.intel_visible === undefined
        ? null
        : (prior.intel_visible ? 1 : 0);

    // No baseline yet — every existing player is in this state the first time this runs.
    // Establish it silently: announcing here would post a line for the entire roster at
    // once, describing nothing that actually changed.
    if (confirmed === null) return { announce: null, confirmedVisible: seenRaw, seenRaw };

    // Not yet two in a row, or nothing changed.
    const priorRaw = prior.intel_seen_raw === null || prior.intel_seen_raw === undefined
        ? null
        : (prior.intel_seen_raw ? 1 : 0);
    if (priorRaw !== seenRaw || seenRaw === confirmed) {
        return { announce: null, confirmedVisible: confirmed, seenRaw };
    }

    // Held across two consecutive observations and differs from the confirmed state: a real
    // transition. It still may not be worth saying again so soon.
    const direction = seenRaw === 0 ? PLAIN_LOST : PLAIN_REGAINED;
    const lastAt = direction === PLAIN_LOST ? prior.intel_lost_announced_at : prior.intel_regained_announced_at;
    if (withinWindow(lastAt, now, repeatWindowMs)) {
        return { announce: null, confirmedVisible: seenRaw, seenRaw };
    }
    return { announce: direction, confirmedVisible: seenRaw, seenRaw };
}

// SQLite CURRENT_TIMESTAMP is UTC without a zone marker; an unparseable or absent stamp
// means "never announced", which must not suppress anything.
function withinWindow(stamp, now, windowMs) {
    if (!stamp) return false;
    const ms = Date.parse(String(stamp).includes('T') ? stamp : `${stamp}Z`);
    if (!Number.isFinite(ms)) return false;
    return (now.getTime() - ms) < windowMs;
}

module.exports = { decideIntelVisibilityChange, FIRST_EVER, PLAIN_LOST, PLAIN_REGAINED };
