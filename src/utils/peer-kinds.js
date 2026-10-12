// What a hub can share with a partner hub, and exactly which fields of it.
//
// One list, read by both sides: the feed (peer-feed.js) sends only these fields, and the
// importer (peer-import.js) keeps only these fields, whatever a partner actually sends.
// A field missing here is not shared — that is the whole access-control story for
// columns, so adding one is a decision about what other alliances get to see.
//
// Deliberately NOT here, in any kind: login and activity timestamps, country, local
// time, anything about who in our alliance entered or scraped something (intel_source,
// intel_entered_by), and flags that only mean something from our own point of view
// (planets.is_ally, siege_is_friendly, announced/backfill bookkeeping). Account, plan,
// route, trade, notes and Discord tables have no kind at all and never will; incomings
// share the attack report only, never who covers it or the defence plan.

const int = 'int';
const num = 'num';
const text = 'text';

const PLANET_FIELDS = {
    planet_index: int, game_planet_id: int, name: text,
    owner_id: int, owner_name: text, owner_tag: text,
    population: int, starbase: int, is_sieged: int, has_fleet: int,
};

const KINDS = {
    systems: {
        label: 'Systems & planets',
        fields: { name: text, x: int, y: int },
        nested: { planets: { fields: PLANET_FIELDS, max: 64 } },
    },
    players: {
        label: 'Player intel reports',
        fields: {
            name: text, alliance_id: int, alliance_tag: text,
            level: int, science_level: int, culture_level: int, points: int, ranking: int,
            race_growth: int, race_science: int, race_culture: int, race_production: int,
            race_speed: int, race_attack: int, race_defense: int, race_trader: int, race_sul: int,
            biology: int, economy: int, energy: int, mathematics: int, physics: int, social: int,
            trade_revenue: int, artefact: text,
            total_planets: int, total_population: int, cv_used: int, cv_limit: int,
            production_rate: int, science_rate: int, culture_rate: int,
            origin_system: int, home_system_id: int, home_planet_index: int,
            has_intel: int, intel_updated_at: text,
        },
    },
    alliances: {
        label: 'Alliances',
        fields: { name: text, tag: text, full_name: text, member_count: int, ranking: int, points_current: int },
    },
    fleets: {
        label: 'Fleet sightings',
        fields: {
            game_fleet_id: int, owner_id: int, owner_name: text, owner_tag: text,
            system_id: int, planet_index: int, destination_system_id: int, destination_planet_index: int,
            transports: int, colony_ships: int, destroyers: int, cruisers: int, battleships: int,
            combat_value: int, arrival_at: text,
        },
    },
    // One item per player: the ranking scrape rewrites a player's rows wholesale (new ids
    // every time), so a per-row key would leave a partner holding every old position.
    fleet_locations: {
        label: 'Fleet locations (strongest fleets)',
        fields: { owner_name: text, owner_tag: text },
        nested: {
            fleets: {
                fields: {
                    rank: int, destroyers: int, cruisers: int, battleships: int, cv: int,
                    system_id: int, system_name: text, planet_index: int, planet_label: text,
                },
                max: 16,
            },
        },
    },
    // The attack itself only: attacker, target, ships, arrival. Who covers it, defence
    // choices and the Discord alert stay ours.
    incomings: {
        label: 'Incomings on our planets',
        fields: {
            attacker_id: int, attacker_name: text, attacker_tag: text,
            target_system_id: int, target_planet_index: int, target_planet_name: text,
            cv: int, transports: int, destroyers: int, cruisers: int, battleships: int,
            arrival_unix: int,
        },
    },
    battle_reports: {
        label: 'Battle reports',
        fields: {
            started_at: text, winner: text, conquered_planet: int, killed_population: int,
            system_id: int, planet_index: int, win_chance: num,
            att_alliance_id: int, att_alliance_tag: text, att_player_id: int, att_player_name: text,
            att_has_won: int, att_combat_value: int, att_survived_cv: int, att_lost_cv: int, att_xp_gained: int,
            att_destroyers: int, att_destroyers_lost: int, att_cruisers: int, att_cruisers_lost: int,
            att_battleships: int, att_battleships_lost: int,
            def_alliance_id: int, def_alliance_tag: text, def_player_id: int, def_player_name: text,
            def_has_won: int, def_combat_value: int, def_survived_cv: int, def_lost_cv: int, def_xp_gained: int,
            def_destroyers: int, def_destroyers_lost: int, def_cruisers: int, def_cruisers_lost: int,
            def_battleships: int, def_battleships_lost: int, def_starbases: int, def_starbases_lost: int,
        },
    },
};

const KIND_NAMES = Object.keys(KINDS);

const MAX_TEXT = 200;

// Coerce one value to its declared type; anything that does not fit becomes null rather
// than being stored as whatever a partner happened to send.
function coerce(type, v) {
    if (v === null || v === undefined) return null;
    if (type === int) {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN);
        return Number.isSafeInteger(n) ? n : null;
    }
    if (type === num) {
        const n = typeof v === 'number' ? v : NaN;
        return Number.isFinite(n) ? n : null;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    return String(v).slice(0, MAX_TEXT);
}

function pickFields(fields, src) {
    const out = {};
    for (const [k, type] of Object.entries(fields)) out[k] = coerce(type, src ? src[k] : undefined);
    return out;
}

// The one shaping function both directions use: unknown fields are dropped, known ones
// coerced, nested lists capped.
function shape(kind, data) {
    const def = KINDS[kind];
    if (!def || !data || typeof data !== 'object' || Array.isArray(data)) return null;
    const out = pickFields(def.fields, data);
    for (const [name, sub] of Object.entries(def.nested || {})) {
        const list = Array.isArray(data[name]) ? data[name].slice(0, sub.max) : [];
        out[name] = list.filter(x => x && typeof x === 'object').map(x => pickFields(sub.fields, x));
    }
    return out;
}

function normaliseScopes(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map(String).filter(k => KINDS[k]))];
}

module.exports = { KINDS, KIND_NAMES, shape, normaliseScopes };
