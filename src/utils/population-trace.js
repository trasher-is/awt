// Labels for the population trace (see population_trace in src/database.js).
//
// /sync/system is fed by four client paths that all look alike to the server once they are
// JSON: the on-page DOM scrape, the off-page DOM fetch, the API galaxy seed and the travel
// calculator's API "Update" button. When a planet's stored population turns out to have been
// wrong, the question is which of them said it — so each stamps a `source`, and the server
// records it beside the change. The client is not trusted (a mobile or hub-modified build
// can send anything), so an unknown value is stored as 'other', never verbatim.
//
// 'unlabelled' is deliberate information, not a fallback to hide: a client build that
// predates this field (a tab left open across a deploy, a cached script) sends nothing, and
// old builds are exactly the kind of source worth being able to point at.

const SOURCES = new Set(['dom-page', 'dom-fetch', 'api-seed', 'api-update']);

function normaliseSource(raw) {
    if (raw === undefined || raw === null || raw === '') return 'unlabelled';
    return typeof raw === 'string' && SOURCES.has(raw) ? raw : 'other';
}

// The three cases /sync/system's stale-observation guard already distinguishes, in the same
// precedence: a cached picture (captured_at) outranks a live claim, and a payload with
// neither is unordered.
function observationKind(body) {
    if (body && body.captured_at) return 'cached';
    if (body && body.observation_live) return 'live';
    return 'unordered';
}

module.exports = { SOURCES, normaliseSource, observationKind };
