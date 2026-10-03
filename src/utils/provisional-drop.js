// A population DROP is provisional until a later read confirms it.
//
// Why: a single stale read can show a planet one level below where it really is. Two hubs have
// recorded the same thing (2026-10-03): a member's read lands shortly after a growth tick and
// carries the PRE-growth figure, the hub logs a drop and posts a Population Drop alert, and then
// every other member's read — correctly — claims the old figure again. The regrowth guard refuses
// those corrections for four hours (a "rise" too soon after the last change is distrusted), so
// the wrong figure is also locked in. Real losses do not behave like that: a planet that was
// really bombarded stays low for every reader.
//
// So a lower claim is held back, not applied. It becomes a real drop only when a LATER read
// still shows the planet below the figure the hub holds; a read that shows the held figure (or
// more) first discards it as a blip. Nothing is stored, logged or announced for a held claim.
//
//   a lower claim, nothing pending        -> 'pending'   (created: true)
//   a lower claim, pending, too soon      -> 'pending'
//   a lower claim, pending, late enough   -> 'confirmed' (commit it now)
//   a claim at or above the held figure   -> 'blip' if one was pending, else 'none'
//
// "Late enough": CONFIRM_GAP_MS after the first lower claim when a DIFFERENT member reads it,
// SAME_MEMBER_GAP_MS when the same member does (so the same stale source cannot confirm itself
// within one run, but that member's next five-minute run can). A pending claim older than
// PENDING_TTL_MS is forgotten, and so is one whose planet changed owner or whose held figure
// moved in the meantime.
//
// State is in memory: it is a few seconds-to-minutes window, and losing it on a restart only
// means a real drop is re-detected one read later. A gap of 0 switches the whole thing off
// (every lower claim is 'immediate'), which is also how the older tests keep exercising the
// alert path itself.

const CONFIRM_GAP_MS = 2 * 60 * 1000;
const SAME_MEMBER_GAP_MS = 4 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const SWEEP_EVERY = 500;

function createProvisionalDrops(options = {}) {
    const confirmGapMs = options.confirmGapMs !== undefined ? options.confirmGapMs : CONFIRM_GAP_MS;
    const sameMemberGapMs = options.sameMemberGapMs !== undefined
        ? options.sameMemberGapMs
        : (confirmGapMs > 0 ? Math.max(confirmGapMs, SAME_MEMBER_GAP_MS) : 0);
    const ttlMs = options.ttlMs !== undefined ? options.ttlMs : PENDING_TTL_MS;
    const pending = new Map();
    let calls = 0;

    // Entries are only dropped when their planet is read again, so a planet nobody reads after a
    // blip would sit here forever; this keeps the map from growing without bound.
    function sweep(now) {
        for (const [key, p] of pending) {
            if (now - p.firstAt > ttlMs) pending.delete(key);
        }
    }

    // key: any stable string for the planet. storedPop: the figure the hub holds. claimedPop: what
    // this read says (after the regrowth guard has had its say). ownerId: the stored owner.
    // actor: who is reporting (compared with ===). now: ms.
    function observe(key, { storedPop, claimedPop, ownerId = null, actor = null, now }) {
        if (confirmGapMs <= 0) return { kind: claimedPop < storedPop ? 'immediate' : 'none' };
        if (++calls % SWEEP_EVERY === 0) sweep(now);

        let p = pending.get(key);
        if (p && (now - p.firstAt > ttlMs || p.basePop !== storedPop || p.ownerId !== ownerId)) {
            pending.delete(key);
            p = undefined;
        }

        if (claimedPop >= storedPop) {
            if (!p) return { kind: 'none' };
            pending.delete(key);
            return { kind: 'blip', ageMs: now - p.firstAt, firstActor: p.firstActor, lowClaim: p.lowClaim };
        }

        if (!p) {
            pending.set(key, { basePop: storedPop, ownerId, lowClaim: claimedPop, firstAt: now, firstActor: actor });
            return { kind: 'pending', created: true };
        }
        const gap = now - p.firstAt;
        const needed = actor === p.firstActor ? sameMemberGapMs : confirmGapMs;
        if (gap >= needed) {
            pending.delete(key);
            return { kind: 'confirmed', ageMs: gap, firstActor: p.firstActor };
        }
        p.lowClaim = Math.min(p.lowClaim, claimedPop);
        return { kind: 'pending', created: false };
    }

    return { observe, size: () => pending.size, sweep, config: { confirmGapMs, sameMemberGapMs, ttlMs } };
}

// POP_DROP_CONFIRM_MS: unset = the default above; 0 = off; anything else = that many ms (and the
// same-member gap follows it, never shorter than the default).
function confirmGapFromEnv(env = process.env) {
    const raw = env.POP_DROP_CONFIRM_MS;
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

module.exports = { createProvisionalDrops, confirmGapFromEnv, CONFIRM_GAP_MS, SAME_MEMBER_GAP_MS, PENDING_TTL_MS };
