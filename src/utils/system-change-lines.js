// What the bot says when a planet changes hands or loses population (issue #156).
//
// Before: "Planet 3: Old → New" and "Planet 3: population 5 → 3" — a number changed, with
// no word on who did what to whom. Now every planet-state change carries attribution:
//   • an owner change says whether the planet was conquered (and from whom), lost to
//     Empty/Unknown, or colonized (a free planet, or an Unknown planet's leftover people)
//   • a population kill names the victim and, when the hub knows it, who inflicted it:
//     the conqueror on an owner-change tick, or the attacker of a bombardment matched
//     from a recent battle report at the same planet. A system scan itself cannot see
//     the attacker, so when no report matches the line SAYS so rather than guessing.
//
// Pure string building, no Discord client: src/routes/sync.js classifies the change,
// src/discord_bot.js's announceSystemChanges delivers the lines, and the test drives
// this module directly.

// Classify an owner change. `isUnknown` is the game's own "Unknown" owner state on the
// new observation; `oldPop` is the population the PREVIOUS observation held. A free planet
// has 0 population, so a null->owner change with leftover population means an Unknown
// planet was colonized (see docs/game-rules.md, Colonizing).
function ownerChangeKind({ oldOwnerId, newOwnerId, isUnknown, oldPop }) {
    const hadOwner = oldOwnerId != null;
    const hasOwner = newOwnerId != null;
    if (hadOwner && hasOwner) return 'conquered';
    if (hadOwner && !hasOwner) return isUnknown ? 'lost_unknown' : 'lost';
    return Number(oldPop) > 0 ? 'colonized_unknown' : 'colonized';
}

const bold = s => `**${s}**`;

function ownerLine(e) {
    const planet = `🪐 ${bold(`Planet ${e.planet_index}`)}`;
    const oldOwner = e.old_owner || 'Unknown';
    const newOwner = e.new_owner || 'Unknown';
    const wiped = Number(e.old_pop) > 0 ? ` — ${e.old_pop} population wiped` : '';
    switch (e.kind) {
        case 'conquered':
            return `${planet}: ${bold(newOwner)} conquered it from ${oldOwner}${wiped}`;
        case 'lost_unknown':
            return `${planet}: ${oldOwner} lost it — now Unknown (resigned or abandoned)`;
        case 'lost':
            return `${planet}: ${oldOwner} lost it — now Empty`;
        case 'colonized_unknown':
            return `${planet}: ${bold(newOwner)} colonized an Unknown planet${Number(e.old_pop) > 0 ? ` — ${e.old_pop} leftover population wiped` : ''}`;
        case 'colonized':
            return `${planet}: ${bold(newOwner)} colonized a free planet`;
        default:
            // An event without a classification (older callers): the pre-#156 wording.
            return `${planet}: ${e.old_owner || 'Empty'} → ${bold(e.new_owner || 'Empty')}`;
    }
}

function popLine(e) {
    const planet = `📉 ${bold(`Planet ${e.planet_index}`)}`;
    const oldPop = Number(e.old_pop), newPop = Number(e.new_pop);
    const killed = Number.isFinite(oldPop) && Number.isFinite(newPop) ? oldPop - newPop : null;
    switch (e.kind) {
        case 'conquest':
            return `${planet}: ${bold(e.by || 'Unknown')} wiped ${killed} population of ${e.victim || 'Unknown'} (conquest)`;
        case 'colonization':
            return `${planet}: ${bold(e.by || 'Unknown')} wiped ${killed} leftover population of an Unknown planet (colonization)`;
        case 'population_loss':
            return `${planet}: ${e.owner || 'Unknown'} lost ${killed} population (${oldPop} → ${newPop}) — cause not visible from a system scan`;
        case 'bombardment': {
            const who = e.attacker
                ? `bombarded by ${bold(e.attacker)}`
                : 'attacker not visible from a system scan';
            return `${planet}: ${e.owner || 'Unknown'} lost ${killed} population (${oldPop} → ${newPop}) — ${who}`;
        }
        default:
            return `${planet}: population ${e.old_pop} → ${e.new_pop}`;
    }
}

// events: [{ type: 'OWNER_CHANGE' | 'POP_DROP', ... }] -> { ownerLines, popLines }
//
// popLines excludes kind:'colonization' (2026-09-12): that's an Unknown/free planet's
// leftover population getting wiped when someone settles it — not a real player losing
// anything, so it has no place in a "who's fighting who" feed. The matching OWNER_CHANGE
// event (kind:'colonized'/'colonized_unknown') still goes to ownerLines — colonizing in
// peace is exactly the kind of galaxy activity the System Change channel is for.
function buildSystemChangeLines(events) {
    const list = Array.isArray(events) ? events : [];
    return {
        ownerLines: list.filter(e => e && e.type === 'OWNER_CHANGE').map(ownerLine),
        popLines: list.filter(e => e && e.type === 'POP_DROP' && e.kind !== 'colonization').map(popLine),
    };
}

// ─── PER-SYSTEM MILESTONE CHANNEL (2026-09-12) ─────────────────────────────────
// A curated subset of the same events, for a Discord channel a member created for one
// specific system (matched by name in discord_bot.js — no admin config needed). Deliberately
// NOT everything System Change shows for that system — see announceSystemMilestones's own
// comment for why a second firehose defeats the point of having a dedicated channel.

const OWNER_GAIN_KINDS = new Set(['conquered', 'colonized', 'colonized_unknown']);

// An OWNER_CHANGE counts as "enemy entered" only when someone actually GAINED the planet
// (not lost_unknown/lost, which have no new owner to judge) and that new owner's tag isn't
// friendly — including an unaffiliated player (no tag at all), who is still not "ours".
function isEnemyGain(e, friendlyTagsUpper) {
    if (!e || e.type !== 'OWNER_CHANGE' || !OWNER_GAIN_KINDS.has(e.kind)) return false;
    const tag = e.new_owner_alliance_tag ? String(e.new_owner_alliance_tag).toUpperCase() : null;
    return !tag || !friendlyTagsUpper.has(tag);
}

function milestoneLine(e) {
    switch (e.type) {
        case 'SIEGE_STARTED':
            return `🚨 ${bold(`Planet ${e.planet_index}`)}: ${e.owner || 'this planet'} is under siege!`;
        case 'OWNER_CHANGE':
            return `⚔️ ${bold(`Planet ${e.planet_index}`)}: taken by ${bold(e.new_owner || 'an enemy')} (${e.old_owner || 'Free'} lost it)`;
        case 'SYSTEM_SECURED':
            return `🎉 This system is now fully secured — every planet is friendly!`;
        default:
            return null;
    }
}

// events: the SAME array sync.js builds for buildSystemChangeLines, plus SIEGE_STARTED
// and a synthetic SYSTEM_SECURED marker. friendlyTagsUpper: a Set of UPPERCASE tags (own
// alliance + admin-configured NAP/allies — see friendly-alliance-tags.js).
function buildSystemMilestoneLines(events, friendlyTagsUpper) {
    const list = Array.isArray(events) ? events : [];
    const tags = friendlyTagsUpper || new Set();
    return list
        .filter(e => e && (e.type === 'SIEGE_STARTED' || e.type === 'SYSTEM_SECURED' || isEnemyGain(e, tags)))
        .map(milestoneLine)
        .filter(Boolean);
}

module.exports = { ownerChangeKind, buildSystemChangeLines, buildSystemMilestoneLines };
