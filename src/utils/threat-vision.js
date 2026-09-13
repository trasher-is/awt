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

module.exports = { resolveThreatOrigin, assessThreat, filterThreatsInRange, SOURCE_GAME, SOURCE_ESTIMATED };
