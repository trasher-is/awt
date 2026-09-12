const db = require('../database');
const { observedNumber, positiveMachineNumber } = require('../utils/observed-number');
const { parseTimestamp } = require('../../public/js/utils/sqlite-time');
const tradeRepo = require('./trade');

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
const futurePartnerStmt = db.prepare(`
    SELECT p.id, p.name, p.total_planets, p.stats_scraped_at,
           s.planets_text, s.updated_at AS sheet_updated_at
    FROM players p LEFT JOIN alliance_member_stats s ON s.player_id = p.id
    WHERE p.name = ? COLLATE NOCASE LIMIT 1
`);


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

// Only reported partners are completed agreements. Confirmed coordination-board
// rows are exposed separately as future candidates, never counted as completed TAs.
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

// A complete saved footprint can estimate a partner's current trade contribution.
// Expose its oldest supporting timestamp; matching counts do not guarantee live data.
function qualifiedPartnerSnapshot(name) {
    const partner = futurePartnerStmt.get(name);
    const result = { player_id: partner?.id ?? null, name: partner?.name ?? name,
        population10_planets: null, observed_at: null };
    if (!partner) return result;
    const totals = [
        { count: leadingInteger(partner.planets_text), time: parseTimestamp(partner.sheet_updated_at) },
        { count: integer(partner.total_planets), time: parseTimestamp(partner.stats_scraped_at) },
    ].filter(source => source.count !== null && source.time).sort((a, b) => b.time - a.time);
    if (!totals.length) return result;
    const { count: total, time: countTime } = totals[0];
    if (total < 1) return result;
    if (totals.some(source => source.time.getTime() === countTime.getTime() && source.count !== total)) return result;
    const planets = planetsStmt.all(partner.id);
    if (total !== planets.length) return result;
    const populations = planets.map(planet => integer(planet.population, 1, 100));
    const times = planets.map(planet => parseTimestamp(planet.updated_at));
    if (populations.includes(null) || times.includes(null)) return result;
    result.population10_planets = populations.filter(population => population >= 10).length;
    result.observed_at = new Date(Math.min(countTime.getTime(), ...times.map(time => time.getTime()))).toISOString();
    return result;
}

function getFuturePartners(player) {
    const self = player.name.toLowerCase();
    const completed = new Set(tradeRepo.getPartnerObservations().get(self)?.known_partners ?? []);
    const candidates = new Map();
    // The existing repository returns ID order. This is reproducible candidate order,
    // not a prediction or recommendation of the future activation sequence.
    for (const agreement of tradeRepo.getActiveAgreements()) {
        if (agreement.status !== 'confirmed') continue;
        const pair = agreement.pair_key.split('|');
        if (!pair.includes(self)) continue;
        const other = pair.find(name => name !== self);
        if (!other || completed.has(other) || candidates.has(other)) continue;
        const displayName = agreement.player_a.toLowerCase() === other ? agreement.player_a : agreement.player_b;
        candidates.set(other, qualifiedPartnerSnapshot(displayName));
    }
    return [...candidates.values()];
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
    return { player, planets, future_partners: getFuturePartners(row) };
}

function getMarket() {
    const row = priceStmt.get();
    return { pp_price: positiveMachineNumber(row?.value), updated_at: row?.updated_at ?? null };
}

module.exports = { getPlayers, getPlayerSnapshot, getMarket };
