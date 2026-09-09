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
function buildSystemChangeLines(events) {
    const list = Array.isArray(events) ? events : [];
    return {
        ownerLines: list.filter(e => e && e.type === 'OWNER_CHANGE').map(ownerLine),
        popLines: list.filter(e => e && e.type === 'POP_DROP').map(popLine),
    };
}

module.exports = { ownerChangeKind, buildSystemChangeLines };
