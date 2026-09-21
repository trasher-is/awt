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
    // API v1 breaking change (rolled out live 2026-09-21): playerLevel here is now a
    // decimal, not an int — e.g. 2.65 means Level 2, 65% of the way to Level 3. The
    // integer level is Math.floor(playerLevel); see mapPlayersToSyncPayload.
    function getPlayers() {
        return requestJson('/api/v1/Player');
    }

    // One player's full detail, including intelligenceReport when the caller has vision.
    // API v1 breaking change (rolled out live 2026-09-21): the bare int playerLevel field
    // is gone, replaced by playerLevelDetails: {level, progressPercent, xpEarnedInLevel,
    // xpRequiredForNextLevel, xpRemainingToNextLevel, totalXp}. mapPlayerDetailToSyncPayload
    // carries all six through.
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
    //
    // Confirmed against a real /api/v1/Map/sectors response (2026-08-30): the API's own
    // p.name is NOT bare — it's "Rasaben #10" (name + the same index this row already
    // carries separately as p.index), and p.ownerName is NOT bare either — it's
    // "MrChuckleupagus [SSPX]" (name + the same tag this row already carries separately
    // as p.allianceTag). Storing either verbatim would double up everywhere a caller
    // already appends "#{index}" or "[{tag}]" itself (e.g. !lastseen's planet label,
    // sync.js's own nameOf() helper) and would corrupt players.name with a baked-in
    // alliance suffix. Both are stripped back to bare before they reach the sync payload.
    function stripTrailingIndex(name) {
        return typeof name === 'string' ? name.replace(/\s*#\d+\s*$/, '') : null;
    }
    function stripTrailingAllianceTag(name) {
        return typeof name === 'string' ? name.replace(/\s*\[[^\]]*\]\s*$/, '') : name;
    }
    // How old this picture is, so the server can order two members' conflicting snapshots
    // instead of last-write-wins (see /sync/system's stale-observation guard). Exactly one
    // of these should be given: capturedAt when the game handed back a CACHED view and said
    // how old it is, observationLive when the caller genuinely has vision and is seeing the
    // system right now. The same system is live for one member and a day-old cache for
    // another, so saying which is the whole point — an unstamped payload is treated as
    // unordered and never wins.
    function mapPlanetsToSyncPayload(systemId, apiPlanets, capturedAt = null, observationLive = false) {
        const planets = (Array.isArray(apiPlanets) ? apiPlanets : [])
            .filter(p => p && typeof p === 'object')
            .map(p => ({
                game_planet_id: p.id,
                planet_index: p.index,
                name: stripTrailingIndex(p.name),
                population: p.populationLevel,
                starbase: p.starbaseLevel,
                owner: p.ownerId != null
                    ? {
                        id: p.ownerId,
                        name: stripTrailingAllianceTag(p.ownerName),
                        alliance_id: p.allianceId != null ? p.allianceId : null,
                        alliance_tag: p.allianceTag != null ? p.allianceTag : null,
                    }
                    : null,
                has_fleet: null,
                is_unknown: !!p.isUnknownOwner,
                is_sieged: p.hasSiege ? 1 : 0,
            }));
        const payload = { system_id: parseInt(systemId, 10), planets, fleets: [] };
        if (capturedAt) payload.captured_at = capturedAt;
        else if (observationLive) payload.observation_live = true;
        return payload;
    }

    // API system objects (getSolarSystems/searchSolarSystems/Map-sectors shape) -> the
    // existing POST /hub-api/sync/galaxy body. The ONE shared mapper: galaxy-map.js's
    // seedPlanetsFromSectors and search.js's live-search fallback both use it, so the
    // payload can never drift between call sites. Systems without coordinates are dropped — x/y land in
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

    // Map/sectors' own alliances[] (getMapSectors shape: [{id, rectangle, alliances,
    // players, solarSystems}]) -> the existing POST /hub-api/sync/alliances-from-map body.
    // There is no dedicated "list every alliance" endpoint — this is the only bulk source,
    // and each alliance can appear in more than one sector (it holds territory across
    // several), so this dedupes by id before it ever reaches the wire. Confirmed against a
    // real response (2026-08-30): a sector alliance object is {id, name, tag, color} — no
    // full_name/member_count, unlike Alliance/search.
    function mapSectorAlliancesToSyncPayload(apiSectors) {
        const byId = new Map();
        for (const sec of (Array.isArray(apiSectors) ? apiSectors : [])) {
            for (const a of (Array.isArray(sec && sec.alliances) ? sec.alliances : [])) {
                if (!a || !Number.isInteger(a.id) || byId.has(a.id)) continue;
                byId.set(a.id, {
                    id: a.id,
                    name: typeof a.name === 'string' ? a.name : null,
                    tag: typeof a.tag === 'string' ? a.tag : null,
                });
            }
        }
        return { alliances: [...byId.values()] };
    }

    // API ListPlayer objects (getPlayers/searchPlayers shape) -> the existing POST
    // /hub-api/sync/player-list body. The ONE shared mapper: the background sweep's list
    // pull (player-api-sync.js) and the manual live-search fallback (search.js) both use
    // it, so the API-sourced payload can never drift between the two call sites.
    function mapPlayersToSyncPayload(apiPlayers) {
        const players = (Array.isArray(apiPlayers) ? apiPlayers : [])
            .filter(p => p && typeof p === 'object')
            .map(p => ({
                id: p.id,
                name: typeof p.name === 'string' ? p.name : null,
                alliance_id: Number.isInteger(p.allianceId) ? p.allianceId : null,
                // Needed so the server can seed the alliances row (FOREIGN KEY on
                // players.alliance_id) before writing a player who belongs to an alliance
                // this sync has never seen before — see the real production crash this
                // fixed (2026-08-30): a brand-new round's first ListPlayer pull hit a
                // fresh alliance id with no matching alliances row yet, and the INSERT
                // threw SqliteError: FOREIGN KEY constraint failed.
                alliance_tag: typeof p.allianceTag === 'string' ? p.allianceTag : null,
                // playerLevel is a decimal here (e.g. 2.65 = Level 2, 65% to Level 3) as of
                // the API v1 change that shipped live 2026-09-21 — floor it to the integer
                // level this column stores. The old plain Number.isInteger(p.playerLevel)
                // check silently went to null the moment the API stopped sending an int.
                level: typeof p.playerLevel === 'number' && Number.isFinite(p.playerLevel)
                    ? Math.floor(p.playerLevel) : null,
                points: Number.isInteger(p.pointsScored) ? p.pointsScored : null,
                rank: Number.isInteger(p.rank) ? p.rank : null,
                country: typeof p.playsFromCountryCode === 'string' ? p.playsFromCountryCode : null,
                is_active_player: !!p.isActivePlayer,
                joined: typeof p.joinedAt === 'string' ? p.joinedAt : null,
            }));
        return { players };
    }

    // API Player/{id} detail objects (getPlayer shape, including intelligenceReport when
    // present) -> the existing POST /hub-api/sync/player-detail body. The ONE shared
    // mapper: player-api-sync.js's background sweep tick and its manual "deep scan"
    // counterpart both use it, so the two can never drift apart the way the race_growth
    // bug (2026-08-30) drifted between client and server. Every intel field is nullish-
    // coalesced rather than read bare: not every player race carries all nine race_*
    // bonus categories, and a bare `undefined` is silently dropped by JSON.stringify on
    // the way to the server, which crashed the upsert (better-sqlite3 requires every named
    // parameter present, even when null).
    function mapPlayerDetailToSyncPayload(d) {
        const intel = d && d.intelligenceReport;
        // playerLevel was replaced by this playerLevelDetails object in the API v1 change
        // that shipped live 2026-09-21 — the old bare d.playerLevel read went to null the
        // moment the field disappeared. Every sub-field is read defensively (a player who
        // hasn't leveled since their last detail scan is still a normal, complete object;
        // this guards a malformed/absent one instead).
        const lvl = d.playerLevelDetails;
        const int = v => Number.isInteger(v) ? v : null;
        return {
            id: d.id, name: typeof d.name === 'string' ? d.name : null,
            alliance_id: Number.isInteger(d.allianceId) ? d.allianceId : null,
            level: int(lvl && lvl.level),
            level_progress_percent: int(lvl && lvl.progressPercent),
            xp_earned_in_level: int(lvl && lvl.xpEarnedInLevel),
            xp_required_for_next_level: int(lvl && lvl.xpRequiredForNextLevel),
            xp_remaining_to_next_level: int(lvl && lvl.xpRemainingToNextLevel),
            total_xp: int(lvl && lvl.totalXp),
            points: Number.isInteger(d.pointsScored) ? d.pointsScored : null,
            ranking: Number.isInteger(d.rank) ? d.rank : null,
            country: typeof d.playsFromCountryCode === 'string' ? d.playsFromCountryCode : null,
            is_active_player: d.isActivePlayer ? 1 : 0,
            joined: typeof d.joinedAt === 'string' ? d.joinedAt : null,
            logins: Number.isInteger(d.numberOfLogins) ? d.numberOfLogins : null,
            last_activity_at: typeof d.lastActivityAt === 'string' ? d.lastActivityAt : null,
            last_login_at: typeof d.lastLoginAt === 'string' ? d.lastLoginAt : null,
            resigned_at: typeof d.resignedAt === 'string' ? d.resignedAt : null,
            number_of_battles: Number.isInteger(d.numberOfBattles) ? d.numberOfBattles : null,
            battle_luckiness: typeof d.battleLuckiness === 'number' ? d.battleLuckiness : null,
            multi_status: typeof d.multiStatus === 'string' ? d.multiStatus : null,
            is_top_permanent_ranker: d.isTopPermanentRanker ? 1 : 0,
            has_supporter_badge: d.hasSupporterBadge ? 1 : 0,
            supporter_type: typeof d.supporterType === 'string' ? d.supporterType : null,
            has_intel: intel ? 1 : 0,
            // Who the alliance is seeing them THROUGH. The report is alliance-wide — it
            // arrives whenever any member has vision, naming the one who captured it — so
            // this is what makes "intel regained" actionable rather than merely true: it
            // says whose eyes to keep in range. Not stored; used only for the announcement.
            intel_captured_by: intel && typeof intel.capturedByPlayerName === 'string' ? intel.capturedByPlayerName : null,
            // ORIGIN — the system a player started in, which is where the game measures
            // their vision radius from, so it decides who can see whom. The game only
            // reveals it for a system we ourselves have vision of, and it was being
            // discarded entirely: the profile scrape picked it up only for the handful of
            // players someone had opened by hand, while this sweep walks the whole roster
            // every pass and had it in front of it the whole time.
            //
            // Sent as raw coordinates rather than parsed out of originName ("Sceptrum [72]
            // (-9/12)"): all 381 system coordinates are distinct, so the server can resolve
            // them exactly, and that does not quietly break if the name formatting changes.
            origin_x: d.origin && Number.isFinite(d.origin.x) ? d.origin.x : null,
            origin_y: d.origin && Number.isFinite(d.origin.y) ? d.origin.y : null,
            biology: intel ? (intel.biologyLevel ?? null) : null,
            economy: intel ? (intel.economyLevel ?? null) : null,
            energy: intel ? (intel.energyLevel ?? null) : null,
            mathematics: intel ? (intel.mathematicsLevel ?? null) : null,
            physics: intel ? (intel.physicsLevel ?? null) : null,
            social: intel ? (intel.socialLevel ?? null) : null,
            trade_revenue: intel ? (intel.tradeBonus ?? null) : null,
            artefact: intel && intel.activeArtefact ? JSON.stringify(intel.activeArtefact) : null,
            race_growth: intel && intel.race ? (intel.race.growth ?? null) : null,
            race_science: intel && intel.race ? (intel.race.science ?? null) : null,
            race_culture: intel && intel.race ? (intel.race.culture ?? null) : null,
            race_production: intel && intel.race ? (intel.race.production ?? null) : null,
            race_speed: intel && intel.race ? (intel.race.speed ?? null) : null,
            race_attack: intel && intel.race ? (intel.race.attack ?? null) : null,
            race_defense: intel && intel.race ? (intel.race.defense ?? null) : null,
            race_trader: intel && intel.race ? (intel.race.trader ?? null) : null,
            race_sul: intel && intel.race ? (intel.race.sul ?? null) : null,
        };
    }

    return {
        getSolarSystems, getSolarSystem, getSystemPlanets, getMapSectors,
        getTravelTime, searchBattleReports,
        searchAlliances, searchSolarSystems,
        getPlayers, getPlayer, searchPlayers,
        mapPlanetsToSyncPayload, mapSolarSystemsToSyncPayload, mapPlayersToSyncPayload,
        mapSectorAlliancesToSyncPayload,
        mapPlayerDetailToSyncPayload,
        _setFetch,
    };
});
