const db = require('../database');
const { parseLocaleNumber } = require('../../public/js/utils/parse-number.js');

const rosterStmt = db.prepare(`
    SELECT p.id, p.name
    FROM alliance_member_stats s JOIN players p ON p.id = s.player_id
    ORDER BY p.name COLLATE NOCASE, p.id
`);
const playerStmt = db.prepare(`
    SELECT p.id, p.name, p.level, p.social, p.has_intel,
           p.race_growth, p.race_production, p.race_science, p.race_trader,
           p.trade_revenue, p.trade_partners, p.artefact AS profile_artefact,
           p.total_planets, p.updated_at, p.stats_scraped_at, p.intel_updated_at,
           s.planets_text, s.level_text, s.astro_dollars, s.production_points,
           s.production_rate, s.science_rate, s.culture_rate, s.artefact AS sheet_artefact,
           s.updated_at AS sheet_updated_at, s.sciences_updated_at AS sheet_sciences_updated_at
    FROM alliance_member_stats s JOIN players p ON p.id = s.player_id
    WHERE p.id = ?
`);
const planetsStmt = db.prepare(`
    SELECT p.game_planet_id AS id, p.name, p.system_id, s.name AS system_name,
           p.planet_index, p.population, p.is_sieged, p.updated_at
    FROM planets p LEFT JOIN systems s ON s.id = p.system_id
    WHERE p.owner_id = ?
    ORDER BY p.system_id, p.planet_index
`);
const priceStmt = db.prepare(`SELECT value, updated_at FROM app_settings WHERE key = 'pp_price'`);
const partnerIdStmt = db.prepare('SELECT id FROM players WHERE name = ? COLLATE NOCASE LIMIT 1');

// parseLocaleNumber intentionally returns zero for garbage. Planning cannot treat
// missing input as free money/zero output, so validate the stored observation first.
const NUMBER_TEXT = /^\+?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?:[ \u00a0\u202f\u2009\u2007]\d{3})+(?:[.,]\d+)?)$/;
function observedNumber(value, rate = false) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const text = (rate ? value.replace(/\s*\/\s*h\s*$/i, '') : value).trim();
    if (!NUMBER_TEXT.test(text)) return null;
    const number = parseLocaleNumber(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value.trim()))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
function leadingInteger(value) {
    if (typeof value !== 'string') return null;
    const match = /^(?:(?:Lvl\.?|Level)\s*)?(\d+)(?:\s|\(|\/|$)/i.exec(value.trim());
    return match ? integer(match[1]) : null;
}
function observedText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Only reported partners are completed agreements. The coordination board's proposed
// and confirmed rows are intentions, so this repository deliberately never reads it.
function completedPartners(raw, player) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let values;
    try { values = JSON.parse(raw); } catch (_) { return null; }
    if (!Array.isArray(values)) return null;
    const unique = new Map();
    for (const value of values) {
        const id = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))
            ? integer(value, 1) : null;
        const name = typeof value === 'string' ? value.trim() : null;
        if (id !== null) {
            if (id !== player.id) unique.set(String(id), id);
        } else if (name && !/^\d+$/.test(name)) {
            const known = partnerIdStmt.get(name);
            if (known) {
                if (known.id !== player.id) unique.set(String(known.id), known.id);
            } else if (name.toLowerCase() !== player.name.toLowerCase()) {
                const key = name.toLowerCase();
                if (!unique.has(key)) unique.set(key, name);
            }
        } else {
            // A partial array is not a trustworthy total of completed agreements.
            return null;
        }
    }
    return [...unique.values()];
}

function getPlayers() {
    return rosterStmt.all();
}

function getPlayerSnapshot(playerId) {
    const row = playerStmt.get(playerId);
    if (!row) return null;
    const hasIntel = row.has_intel === 1;
    const planets = planetsStmt.all(playerId).map(planet => ({
        ...planet,
        population: integer(planet.population),
        is_sieged: planet.is_sieged === 1 ? true : planet.is_sieged === 0 ? false : null,
        farm: null, factory: null, lab: null, cybernetics: null,
        local_pp: null, growth_progress: null,
    }));
    const totalPlanets = leadingInteger(row.planets_text) ?? integer(row.total_planets, 1);
    const sheetArtefact = observedText(row.sheet_artefact);
    const artefact = sheetArtefact ?? (hasIntel ? observedText(row.profile_artefact) : null);
    const player = {
        id: row.id, name: row.name,
        level: leadingInteger(row.level_text) ?? integer(row.level, 1),
        social: hasIntel ? integer(row.social) : null,
        has_intel: hasIntel,
        race_growth: hasIntel ? integer(row.race_growth, -4, 4) : null,
        race_production: hasIntel ? integer(row.race_production, -4, 4) : null,
        race_science: hasIntel ? integer(row.race_science, -4, 4) : null,
        race_trader: hasIntel ? integer(row.race_trader, 0, 1) : null,
        trade_revenue: hasIntel ? observedNumber(row.trade_revenue) : null,
        total_planets: totalPlanets,
        trade_partners: completedPartners(row.trade_partners, row),
        artefact,
        artefact_source: artefact === null ? null : sheetArtefact !== null ? 'alliance_member_stats' : 'bio_intel',
        updated_at: row.updated_at,
        stats_scraped_at: row.stats_scraped_at,
        intel_updated_at: row.intel_updated_at,
        sheet_updated_at: row.sheet_updated_at,
        sheet_sciences_updated_at: row.sheet_sciences_updated_at,
        known_planet_count: planets.length,
        missing_planet_count: totalPlanets === null ? null : Math.max(0, totalPlanets - planets.length),
        planet_count_matches: totalPlanets === null ? null : totalPlanets === planets.length,
        economy_sources: {},
    };
    // The similarly named players columns are schema defaults: neither the profile nor
    // Statistics upsert records them, even when stats_scraped_at is present. Only the
    // member sheet provides observations for these planning inputs.
    for (const field of ['astro_dollars', 'production_points', 'production_rate', 'science_rate', 'culture_rate']) {
        player[field] = observedNumber(row[field], field.endsWith('_rate'));
        player.economy_sources[field] = player[field] === null ? null : 'alliance_member_stats';
    }
    return { player, planets };
}

function getMarket() {
    const row = priceStmt.get();
    // /sync/trade-prices serializes a numeric API value with String(), not localized
    // display text. A three-digit fraction such as 0.125 must remain a fraction here.
    const text = typeof row?.value === 'string' ? row.value.trim() : '';
    const price = /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : null;
    return { pp_price: Number.isFinite(price) && price > 0 ? price : null, updated_at: row?.updated_at ?? null };
}

module.exports = { getPlayers, getPlayerSnapshot, getMarket };
