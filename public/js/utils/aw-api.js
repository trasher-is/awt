// Client for the game's REST API (/api/v1/*). One copy, used by both realms.
//
// LOADING: no import/export statements — Node require()s it, the browser runs it as a
// side-effect module import with the API on globalThis. Same pattern as the other shared
// modules in this directory.
//   • Browser: import '../utils/aw-api.js';  then globalThis.AWApi
//     (import '../utils/game-rate-limit.js' first — this file reads globalThis.AWGameRate
//     at call time and throws a clear error when the gate is missing.)
//   • Node:    require('../../public/js/utils/aw-api.js')   (for the tests)
//
// ─── WHY EVERY CALL GOES THROUGH THE RATE GATE ────────────────────────────────
// Requests to /api/v1/* are same-origin here, but the hub's reverse proxy forwards them
// to the game server, so they are game traffic and they count against the five requests
// per second the game's administrator permits this tool. That number is a promise made
// to a person, not a tuning knob. Every function below therefore routes through
// AWGameRate.gameFetch — the shared queue whose rolling window lives in localStorage so
// the wrapper document and the injected game iframe spend ONE budget, not two. A bare
// fetch('/api/v1/...') anywhere in public/js fails the enforcement scan in
// src/utils/game-rate-limit.test.js, by design.
//
// The proxy attaches the member's own game session cookie and strips the hub's; this
// file adds no auth of its own, and it never runs on the server — the server has no
// game session.
//
// ─── WHAT CALLERS GET BACK ────────────────────────────────────────────────────
// Every function resolves (never rejects for network/HTTP/parse trouble) with one of:
//   { ok: true,  data }                     — parsed JSON body (null when the body is empty)
//   { ok: false, status, reason: 'session' } — the body was HTML: the hub's login redirect
//                                              or the game's Identity login page. Checked
//                                              before anything else so an expired session
//                                              surfaces as itself, never as a parse error.
//   { ok: false, status, reason: 'http' }    — non-2xx with a non-HTML body (the API's
//                                              ProblemDetails JSON lands here; status is
//                                              passed through verbatim for the caller)
//   { ok: false, status, reason: 'parse' }   — 2xx but the body is not JSON
//   { ok: false, status: 0, reason: 'network' } — fetch itself threw
//
// Paths and shapes follow the game's published OpenAPI 3.0.1 spec (/swagger/v1/swagger.json).
// They are spec-derived: no /api/v1 response has ever been observed through the proxy.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Tests swap the network function so no request leaves the machine. The override is
    // still scheduled through the rate gate: even a test — or a misuse in the browser —
    // cannot turn this into a path around the five-per-second agreement.
    let fetchOverride = null;
    function _setFetch(fn) { fetchOverride = typeof fn === 'function' ? fn : null; }

    // Resolved on every call, not once at load: the browser reads whatever
    // globalThis.AWGameRate is NOW (module evaluation order must not matter), and Node
    // requires the gate directly so the tests get the same instance the module uses.
    function gate() {
        const g = globalThis.AWGameRate;
        if (g && typeof g.gameFetch === 'function') return g;
        if (typeof module === 'object' && module !== null && module.exports) {
            return require('./game-rate-limit.js');
        }
        throw new Error("AWApi: globalThis.AWGameRate is missing — import '../utils/game-rate-limit.js' before calling the game API");
    }

    // Query string from a plain object; null/undefined values are omitted so optional
    // search parameters (BattleReport/search has many) never arrive as "undefined".
    function query(params) {
        const q = new URLSearchParams();
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== null && value !== undefined) q.set(key, value);
        }
        const s = q.toString();
        return s ? '?' + s : '';
    }

    async function requestJson(path, init) {
        // Outside the try below on purpose: a missing rate gate is a programming error
        // (wrong import order) and must fail loudly, not soften into reason 'network'.
        const g = gate();
        let res;
        try {
            res = await (fetchOverride ? g.schedule(() => fetchOverride(path, init)) : g.gameFetch(path, init));
        } catch (err) {
            return { ok: false, status: 0, reason: 'network' };
        }

        let text;
        try {
            text = await res.text();
        } catch (err) {
            return { ok: false, status: res.status || 0, reason: 'network' };
        }

        // HTML means a login page: the hub's requireAuth redirect or the game's Identity
        // page, both of which fetch follows into a 200. Checked before res.ok and before
        // JSON.parse — JSON never starts with '<', so the sniff cannot misfire.
        const contentType = res.headers && typeof res.headers.get === 'function'
            ? (res.headers.get('content-type') || '')
            : '';
        if (/text\/html/i.test(contentType) || /^\s*</.test(text)) {
            return { ok: false, status: res.status, reason: 'session' };
        }

        if (!res.ok) return { ok: false, status: res.status, reason: 'http' };

        if (!text || !text.trim()) return { ok: true, data: null };
        try {
            return { ok: true, data: JSON.parse(text) };
        } catch (err) {
            return { ok: false, status: res.status, reason: 'parse' };
        }
    }

    // ─── ENDPOINTS ────────────────────────────────────────────────────────────

    // All known systems: [{id, name, fullName, info, populationLevel, x, y}] — x/y are
    // nullable, so consumers filter `x != null && y != null` before doing geometry.
    function getSolarSystems() {
        return requestJson('/api/v1/SolarSystem');
    }

    // One system, including planets[] and ownership when in vision.
    function getSolarSystem(id) {
        return requestJson('/api/v1/SolarSystem/' + encodeURIComponent(id));
    }

    // A system's planets: [{id, index, name, ownerId, ownerName, allianceId, allianceTag,
    // populationLevel, starbaseLevel, isUnknownOwner, hasSiege, starbaseOrders}].
    function getSystemPlanets(id) {
        return requestJson('/api/v1/SolarSystem/' + encodeURIComponent(id) + '/planets');
    }

    // All active players (no filter): [{id, allianceId, isActivePlayer, name, allianceTag,
    // joinedAt, playerLevel, playsFromCountryCode, pointsScored, rank}].
    function getPlayers() {
        return requestJson('/api/v1/Player');
    }

    // One player's full detail, including intelligenceReport when the caller has vision.
    function getPlayer(id) {
        return requestJson('/api/v1/Player/' + encodeURIComponent(id));
    }

    // Player name/id search: same ListPlayer shape as getPlayers(), just filtered by q.
    function searchPlayers({ q, limit } = {}) {
        return requestJson('/api/v1/Player/search' + query({ q, limit }));
    }

    // A rectangular area of the map: [{id, rectangle, alliances, players, solarSystems}].
    // Each solarSystems[] entry additionally carries {capturedAt, format, isInVision,
    // planets[]} on top of the base SolarSystem shape.
    function getMapSectors({ x1, y1, x2, y2 } = {}) {
        return requestJson('/api/v1/Map/sectors' + query({ x1, y1, x2, y2 }));
    }

    // Alliance name/tag/id search: [{id, name, tag, fullName, memberCount, pointsScored, rank}].
    function searchAlliances({ q, limit } = {}) {
        return requestJson('/api/v1/Alliance/search' + query({ q, limit }));
    }

    // System name/id search: [{id, name, fullName, info, populationLevel, x, y}] — same
    // shape as getSolarSystems(), just filtered by q.
    function searchSolarSystems({ q, limit } = {}) {
        return requestJson('/api/v1/SolarSystem/search' + query({ q, limit }));
    }

    // The game's own travel time between two planets, by SYSTEM ID (not coordinates):
    // {days, hours, minutes, seconds, timeSpan, totalSeconds}. Answers for the logged-in
    // player — their race speed is baked in, only energyLevel is a parameter.
    function getTravelTime({ fromSystem, fromPlanetIndex, toSystem, toPlanetIndex, energyLevel } = {}) {
        return requestJson('/api/v1/Fleet/travelTime'
            + query({ fromSystem, fromPlanetIndex, toSystem, toPlanetIndex, energyLevel }));
    }

    // Battle-report search. `params` uses the spec's dotted names verbatim, e.g.
    // {'FirstParty.AllianceId': 7, OrderBy: 'DateTime', OrderDirection: 'Descending',
    //  Take: 50, BattleDateFrom: '2026-08-01T00:00:00Z'}.
    function searchBattleReports(params) {
        return requestJson('/api/v1/BattleReport/search' + query(params));
    }

    // Write a starbase order's geometry. The API exposes no read of the current
    // geometry, so this is write-only by design; callers confirm with the member first.
    function putOrderGeometry(orderId, { range, angleDegree1, angleDegree2 } = {}) {
        return requestJson('/api/v1/Starbase/orders/' + encodeURIComponent(orderId) + '/geometry', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ range, angleDegree1, angleDegree2 }),
        });
    }

    // ─── MAPPING ──────────────────────────────────────────────────────────────

    // API planet objects -> the existing POST /hub-api/sync/system body. The ONE shared
    // mapper: the travel calculator's Update button and the system-intel refresh both use
    // it, so the API-sourced payload can never drift between them.
    //   id → game_planet_id          index → planet_index
    //   populationLevel → population  starbaseLevel → starbase
    //   isUnknownOwner → is_unknown   hasSiege → is_sieged (0/1)
    //   ownerId/ownerName/allianceId/allianceTag → owner {id, name, alliance_id,
    //   alliance_tag}, or null when the planet has no owner.
    // has_fleet is null: the API says nothing about stationed fleets, and NULL keeps
    // "not observed" distinct from a fabricated "observed absent". No fleet rows either —
    // /sync/system ignores its fleets array anyway (alliance scans own fleet data).
    function mapPlanetsToSyncPayload(systemId, apiPlanets) {
        const planets = (Array.isArray(apiPlanets) ? apiPlanets : [])
            .filter(p => p && typeof p === 'object')
            .map(p => ({
                game_planet_id: p.id,
                planet_index: p.index,
                name: typeof p.name === 'string' ? p.name : null,
                population: p.populationLevel,
                starbase: p.starbaseLevel,
                owner: p.ownerId != null
                    ? {
                        id: p.ownerId,
                        name: p.ownerName,
                        alliance_id: p.allianceId != null ? p.allianceId : null,
                        alliance_tag: p.allianceTag != null ? p.allianceTag : null,
                    }
                    : null,
                has_fleet: null,
                is_unknown: !!p.isUnknownOwner,
                is_sieged: p.hasSiege ? 1 : 0,
            }));
        return { system_id: parseInt(systemId, 10), planets, fleets: [] };
    }

    // API system objects (getSolarSystems/searchSolarSystems shape) -> the existing
    // POST /hub-api/sync/galaxy body. The ONE shared mapper: galaxy-map.js's seedFromApi
    // and search.js's live-search fallback both use it, so the payload can never drift
    // between the two call sites. Systems without coordinates are dropped — x/y land in
    // INTEGER-affinity columns and /sync/galaxy's own coord() guard would skip them
    // anyway, but there is no reason to ship rows the server will just discard.
    function mapSolarSystemsToSyncPayload(apiSystems) {
        const systems = (Array.isArray(apiSystems) ? apiSystems : [])
            .filter(s => s && s.x != null && s.y != null)
            .map(s => ({
                id: s.id, name: s.name, x: s.x, y: s.y,
                full_name: typeof s.fullName === 'string' ? s.fullName : null,
                info: typeof s.info === 'string' ? s.info : null,
                population_level: Number.isInteger(s.populationLevel) ? s.populationLevel : null,
            }));
        return { systems };
    }

    return {
        getSolarSystems, getSolarSystem, getSystemPlanets, getMapSectors,
        getTravelTime, searchBattleReports, putOrderGeometry,
        searchAlliances, searchSolarSystems,
        getPlayers, getPlayer, searchPlayers,
        mapPlanetsToSyncPayload, mapSolarSystemsToSyncPayload,
        _setFetch,
    };
});
