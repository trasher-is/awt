// Can a player with a biology advantage actually SEE you?
//
// A high biology level on the far side of the map is a statistic, not a threat. The game
// measures vision from the system a player STARTED in to the target, so the question is
// whether their radius reaches your origin — the same rule !vision already uses
// (vision-model.js), applied to the bio threat lists instead of to your own alliance.
//
// THE AWKWARD PART: the game only reveals a player's origin for a system we ourselves have
// vision of. That excludes exactly the players this check matters most for — distant ones
// with more biology than us. So where the real origin is missing we fall back to their
// biggest planet, which against every player whose true origin the game did give us picked
// the right system 34 times out of 34. It is still a guess, and it is labelled as one. The
// fallback also retires itself: as biology climbs the real origins arrive on their own, and
// at biology 25 the whole map is visible.
//
// WHICH WAY UNCERTAINTY FAILS: toward warning. A player we cannot place at all is still
// listed, marked unknown — a threat you were never told about is a worse outcome than one
// you were told about and could dismiss.

const { visionRadius, systemDistance, bioNeededFor } = require('../../public/js/utils/vision-model.js');

const SOURCE_GAME = 'game';
const SOURCE_ESTIMATED = 'estimated';

// Number(null) and Number('') are both 0, so a bare Number.isFinite check silently places
// anything with a missing coordinate at 0,0 — which on this grid is a real system, and would
// make a player we cannot locate look maximally close to everyone. Absent must stay absent.
function coord(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// visionRadius() floors at 1 so that everyone at least sees their own system — which means a
// falsy radius never happens, and "no stats at all" has to be detected from the inputs.
function hasAnyRadarStat(row) {
    const bio = Number(row && row.biology);
    const science = Number(row && row.science_level);
    return (Number.isFinite(bio) && bio > 0) || (Number.isFinite(science) && science > 0);
}

// A threat row as the repository returns it: the real origin when the game gave us one,
// otherwise the biggest-planet estimate, otherwise nothing.
function resolveThreatOrigin(row) {
    if (!row) return { x: null, y: null, systemId: null, source: null };
    const realX = coord(row.origin_x), realY = coord(row.origin_y);
    if (Number.isInteger(row.origin_system) && row.origin_system > 0 && realX !== null && realY !== null) {
        return { x: realX, y: realY, systemId: row.origin_system, source: SOURCE_GAME };
    }
    const estX = coord(row.est_origin_x), estY = coord(row.est_origin_y);
    if (estX !== null && estY !== null) {
        return { x: estX, y: estY, systemId: row.est_origin_system ?? null, source: SOURCE_ESTIMATED };
    }
    return { x: null, y: null, systemId: null, source: null };
}

// viewer: { origin_x, origin_y } — your own origin, the thing they would be seeing.
// Returns { reaches, estimated, unknown, radius, required, origin }.
//   reaches   true when their radius covers the distance, and also when we cannot tell
//   unknown   we could not establish one side of the comparison, so `reaches` is a
//             precaution rather than a finding
function assessThreat(row, viewer) {
    const origin = resolveThreatOrigin(row);
    const viewerX = coord(viewer && viewer.origin_x);
    const viewerY = coord(viewer && viewer.origin_y);

    if (viewerX === null || viewerY === null) {
        return { reaches: true, estimated: false, unknown: 'your own origin is not on record', radius: null, required: null, origin };
    }
    if (origin.x === null || origin.y === null) {
        return { reaches: true, estimated: false, unknown: 'their origin is unknown and they hold no planets we can see', radius: null, required: null, origin };
    }

    if (!hasAnyRadarStat(row)) {
        return { reaches: true, estimated: false, unknown: 'neither biology nor science level recorded', radius: null, required: null, origin };
    }
    const radius = visionRadius(row);

    const required = bioNeededFor(systemDistance(origin.x, origin.y, viewerX, viewerY));
    return {
        reaches: radius >= required,
        // How many biology levels short they are. The single most dangerous player on the
        // map is the one parked ONE level outside your radius: they see you the moment they
        // finish a research tick, and they choose when that happens. A plain yes/no gate
        // hides them until it is already too late to matter.
        levelsAway: Math.max(0, required - radius),
        estimated: origin.source === SOURCE_ESTIMATED,
        unknown: null,
        radius,
        required,
        origin,
    };
}

// Keeps only the players who can reach you, tagging each with how sure we are. Sorting and
// limits stay with the caller; this decides membership only.
function filterThreatsInRange(rows, viewer) {
    return (Array.isArray(rows) ? rows : []).map(row => {
        const verdict = assessThreat(row, viewer);
        return verdict.reaches ? { ...row, vision: verdict } : null;
    }).filter(Boolean);
}

// Someone this close to reaching you is news even though they cannot see you yet.
const DEFAULT_CLOSING_LEVELS = 2;

// Sorts candidates into the two pills.
//
//   RED    confirmed biology a decisive margin above yours AND able to see you right now
//   YELLOW everything else still worth watching: a smaller confirmed gap, an unscanned
//          player whose science ceiling clears the lower bar, or anyone — however large
//          their gap — who is merely CLOSING rather than already watching
//
// Why closing belongs in yellow rather than red: it is a warning, not a sighting, and the
// two should not look alike. Before this, both gates flipped on the same research tick — a
// player at biology 15, sixteen systems out, cleared neither the +6 bar nor the vision check,
// then cleared both at once on reaching 16. The list went from silent to "already watching
// you" with nothing in between, which is precisely the moment warning is worth having.
//
// `myBio` is the viewer's own biology; confirmedMargin is the red bar's gap.
function classifyThreat(row, viewer, { myBio, confirmedMargin, closingLevels = DEFAULT_CLOSING_LEVELS }) {
    const vision = assessThreat(row, viewer);
    const closing = !vision.reaches
        && Number.isFinite(vision.levelsAway)
        && vision.levelsAway > 0
        && vision.levelsAway <= closingLevels;

    if (!vision.reaches && !closing) return { band: null, vision };

    const bio = Number(row && row.biology);
    const confirmedGap = row && row.has_intel && Number.isFinite(bio) ? bio - Number(myBio) : null;
    const decisive = confirmedGap !== null && confirmedGap >= confirmedMargin;

    return { band: (vision.reaches && decisive) ? 'red' : 'yellow', vision, closing };
}

// rows: every candidate already past the LOWER bar — confirmed and unscanned alike. Which
// pill each lands in is decided here, not by the query, so a player cannot fall between the
// two bars and vanish from both (which is exactly what a confirmed +5 did when the single
// margin was split in two).
function splitThreats(rows, viewer, options) {
    const red = [], yellow = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const { band, vision, closing } = classifyThreat(row, viewer, options);
        if (!band) continue;
        (band === 'red' ? red : yellow).push({ ...row, vision, closing: !!closing });
    }
    return { red, yellow };
}

module.exports = {
    resolveThreatOrigin, assessThreat, filterThreatsInRange,
    classifyThreat, splitThreats, DEFAULT_CLOSING_LEVELS,
    SOURCE_GAME, SOURCE_ESTIMATED,
};
