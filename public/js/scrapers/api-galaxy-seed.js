// Single-call galaxy seed — system index AND every system's planets from ONE Map/sectors
// call. Extracted so the Galaxy Archive panel's "Seed galaxy" button (galaxy-map.js) and
// the sidebar's "Galaxy" scraper button (dashboard.js) share the exact same logic instead
// of drifting apart, the same reasoning as aw-api.js's shared mappers.
//
// Replaces the old DOM-based per-system scan (mass-scanner.js's runMassScan): that walked
// every system's live page one at a time and additionally picked up stationed-fleet detail
// (composition, arrival times) the Map/sectors API does not expose at all. This trades that
// fleet visibility away for a scan that finishes in seconds instead of minutes — see PR
// discussion for why that trade was made deliberately, not by accident.
import '../utils/game-rate-limit.js';
import '../utils/aw-api.js';
import '../utils/capture-freshness.js'; // side-effect import: puts the model on globalThis

const AWApi = globalThis.AWApi;
const { isStaleCapture } = globalThis.AWCaptureFreshness;

const SECTOR_BOUNDS = { x1: -40, y1: -40, x2: 40, y2: 40 }; // known map bounds ~-32..32, padded

// onProgress(status, current, total) — current/total are 0 for indeterminate steps (the
// initial fetch, the index POST) and reflect systems-processed-so-far during the per-
// system planet loop.
export async function seedGalaxyFromApi(onProgress = () => {}) {
    onProgress('Asking the game for the map sectors…', 0, 0);
    const res = await AWApi.getMapSectors(SECTOR_BOUNDS);
    if (!res.ok) {
        return {
            ok: false,
            error: res.reason === 'session'
                ? 'Seeding needs your game session — log into the game first, then try again.'
                : `The game API did not answer (${res.reason}${res.status ? `, HTTP ${res.status}` : ''}).`,
        };
    }
    const sectors = Array.isArray(res.data) ? res.data : [];
    const allSystems = sectors.flatMap(sec => Array.isArray(sec.solarSystems) ? sec.solarSystems : []);
    if (!allSystems.length) {
        return { ok: false, error: 'The game returned no systems in that area — nothing to seed.' };
    }

    onProgress(`Indexing ${allSystems.length} systems…`, 0, allSystems.length);
    const { systems: indexPayload } = AWApi.mapSolarSystemsToSyncPayload(allSystems);
    if (indexPayload.length) {
        const indexRes = await fetch('/hub-api/sync/galaxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systems: indexPayload }),
        });
        if (!indexRes.ok) {
            return { ok: false, error: `The archive rejected the system index (HTTP ${indexRes.status}) — aborting before touching planets.` };
        }
    }

    // No dedicated "list every alliance" API exists — each sector's own alliances[] is the
    // only bulk source, so piggyback it on the call this seed already makes rather than a
    // separate request.
    const { alliances: alliancePayload } = AWApi.mapSectorAlliancesToSyncPayload(sectors);
    if (alliancePayload.length) {
        await fetch('/hub-api/sync/alliances-from-map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alliances: alliancePayload }),
        });
    }

    let systemsProcessed = 0;
    let planetsProcessed = 0;
    const visionFlags = [];
    for (const sys of allSystems) {
        if (!sys || !Number.isInteger(sys.id)) continue;
        // isInVision alone isn't enough — see capture-freshness.js: the API can say
        // isInVision:true for a stale, hours-old snapshot (confirmed live: a real capture
        // exactly at the daily reset boundary, 20+ hours old, for a system only an ally
        // had personal vision on).
        const isInVision = !!sys.isInVision && !isStaleCapture(sys.capturedAt);
        visionFlags.push({ id: sys.id, is_in_vision: isInVision });

        const planets = Array.isArray(sys.planets) ? sys.planets : [];
        const payload = AWApi.mapPlanetsToSyncPayload(sys.id, planets);
        if (!isInVision) {
            // Out-of-vision (or in-vision but stale, see isStaleCapture above): the data may
            // not reflect reality right now. This is a SEPARATE concept from is_unknown
            // (2026-09-02: is_unknown is the game's own real "Unknown" owner state — a
            // resigned player's leftover planet, or a game-spawned Unknown — and must be
            // trusted whenever it's reported for real, so it must not be overwritten here).
            // vision_uncertain is the server's actual fog-of-war signal: it tells
            // /sync/system to freeze this planet's owner/population/starbase at their last
            // known values instead of trusting whatever this stale/out-of-vision snapshot
            // says, regardless of what is_unknown happens to say.
            payload.planets = payload.planets.map(p => ({ ...p, vision_uncertain: true }));
        }
        if (!payload.planets.length) continue;
        // Bulk seeding hundreds of systems at once would otherwise flood Discord with
        // owner-change/pop-drop announcements; scan_mode: 'silent' still does every DB
        // write and history log, it just skips the announcement.
        payload.scan_mode = 'silent';

        const syncRes = await fetch('/hub-api/sync/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (syncRes.ok) {
            systemsProcessed++;
            planetsProcessed += payload.planets.length;
        }
        onProgress(`Seeding planets… ${systemsProcessed}/${allSystems.length} systems (${planetsProcessed} planets)`, systemsProcessed, allSystems.length);
    }

    if (visionFlags.length) {
        await fetch('/hub-api/sync/system-in-vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systems: visionFlags }),
        });
    }

    return { ok: true, systemsIndexed: indexPayload.length, alliancesIndexed: alliancePayload.length, systemsProcessed, planetsProcessed };
}
