// Nullable building levels captured from Best Planets. Zero is a real level; strings,
// booleans and missing cells must not quietly become zero or a building champion.
const BUILDING_KINDS = ['HF', 'RF', 'GC', 'RL'];
const MAX_BUILDING_LEVEL = 1000000;

function validBuildingLevel(value) {
    return Number.isInteger(value) && value >= 0 && value <= MAX_BUILDING_LEVEL;
}

function normalizeBuildings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(BUILDING_KINDS.map(kind => [kind.toLowerCase(),
        validBuildingLevel(source[kind]) ? source[kind] : null]));
}

function summarizeLeaders(rows) {
    const coverage = Object.fromEntries(BUILDING_KINDS.map(kind => [kind,
        rows.filter(row => validBuildingLevel(row[kind.toLowerCase()])).length]));
    const ranks = new Set(rows.map(row => row.rank));
    const complete = rows.length === 50 && ranks.size === 50
        && rows.every(row => Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= 50)
        && new Set(rows.map(row => row.game_planet_id)).size === 50;
    const leaders = [];
    for (const kind of BUILDING_KINDS) {
        // A maximum among 20 observed planets is not the leader of the full Top 50.
        // Each category is independent: a missing HF does not erase complete RF data.
        if (!complete || coverage[kind] !== 50) continue;
        const field = kind.toLowerCase();
        const winner = [...rows].sort((a, b) => b[field] - a[field]
            || a.rank - b.rank || a.game_planet_id - b.game_planet_id)[0];
        leaders.push({ kind, level: winner[field], game_planet_id: winner.game_planet_id,
            system_id: winner.system_id, planet_index: winner.planet_index, rank: winner.rank });
    }
    return {
        leaders,
        leaders_status: leaders.length === BUILDING_KINDS.length ? 'complete'
            : Object.values(coverage).some(count => count > 0) ? 'incomplete' : 'unavailable',
        leader_coverage: coverage,
    };
}

module.exports = { normalizeBuildings, summarizeLeaders };
