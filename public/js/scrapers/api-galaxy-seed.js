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
import '../utils/daily-reset.js';

const AWApi = globalThis.AWApi;
const { isStaleCapture } = globalThis.AWCaptureFreshness;
const AWDailyReset = globalThis.AWDailyReset;

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

// Automatic background seeding — once a day, shortly after the reset, not a poll.
// Previously this ran every 5 minutes all day long, on the assumption that re-asking more
// often kept in-vision systems more current. Confirmed against how the game actually
// behaves (2026-09-12): outside your own bio-range vision (vision-model.js), the galaxy
// only gets a fresh snapshot once a day, at the 00:00 CET/CEST reset — Map/sectors doesn't
// hand back new data between resets no matter how often it's asked, so the old 5-min
// interval was spending API budget to re-read the exact same snapshot, all day, for
// nothing. RESET_BUFFER_MINUTES gives the reset a few minutes to actually land before
// pulling. Real live vision (bio-range) is a wholly separate concept handled elsewhere —
// see vision-model.js — and is unaffected by this schedule change.
//
// IMPORTANT — what this still does NOT fix: pulling right after the reset gets the
// freshest possible read of whatever Map/sectors is willing to say, but it still only
// reports live data for systems currently isInVision (see the isInVision/vision_uncertain
// handling above and capture-freshness.js). It cannot produce fresh data for systems
// nobody has vision on — no amount of asking changes what the game will say about them.
// Getting THOSE current still needs either real vision (scouting/holding territory) or a
// member's browser physically visiting that system's page (spy.js's live DOM scrape, see
// issue #168 for the fuller writeup).
const RESET_BUFFER_MINUTES = 5; // pull at 00:05 Europe/Berlin — a few minutes after the reset lands
const DAY_LOCK_KEY = 'awt.galaxyAutoSeed.lastPullDay.v2'; // Berlin-date of the last SUCCESSFUL seed
const ATTEMPT_LOCK_KEY = 'awt.galaxyAutoSeed.attemptLock.v2'; // short cross-tab mutex, not a daily gate
const ATTEMPT_LOCK_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 60 * 1000; // a failed attempt retries in 30 min, not a full day later
const CATCHUP_DELAY_MS = 10 * 1000; // let the page settle before the very first check

function getLastPulledDay() {
    try { return localStorage.getItem(DAY_LOCK_KEY); } catch (err) { return null; }
}
function setLastPulledDay(day) {
    try { localStorage.setItem(DAY_LOCK_KEY, day); } catch (err) { console.warn('[GalaxyAutoSeed] could not persist last-pulled day:', err.message); }
}
function claimAttemptLock() {
    try {
        const raw = localStorage.getItem(ATTEMPT_LOCK_KEY);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ATTEMPT_LOCK_TTL_MS) return false;
        localStorage.setItem(ATTEMPT_LOCK_KEY, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same as player-api-sync.js
    }
}

function scheduleWake(when) {
    const delay = Math.max(1000, when.getTime() - Date.now());
    setTimeout(tick, delay);
}

// Always checks "did today's pull already succeed" first (across tabs and reloads, via
// the Berlin-date day-lock) rather than assuming a fixed clock tick means work is due —
// that's what makes this safe to call from a catch-up timer, a fresh page load at any
// time of day, or the recurring wake, without ever double-pulling the same day.
async function tick() {
    const today = AWDailyReset.berlinDateKey();
    if (getLastPulledDay() === today) {
        scheduleWake(AWDailyReset.nextDailyWindow(RESET_BUFFER_MINUTES));
        return;
    }
    if (!claimAttemptLock()) {
        // Another tab is already attempting this (or just did) — check back shortly rather
        // than spin; if it succeeded, the day-lock check above picks that up next time.
        scheduleWake(new Date(Date.now() + RETRY_DELAY_MS));
        return;
    }
    try {
        const result = await seedGalaxyFromApi();
        if (result.ok) setLastPulledDay(today);
        else console.warn('[GalaxyAutoSeed] tick failed:', result.error);
    } catch (err) {
        console.warn('[GalaxyAutoSeed] tick failed:', err.message);
    }
    scheduleWake(getLastPulledDay() === today
        ? AWDailyReset.nextDailyWindow(RESET_BUFFER_MINUTES)
        : new Date(Date.now() + RETRY_DELAY_MS));
}

let started = false;
export function startAutoGalaxySeed() {
    if (started) return;
    started = true;
    setTimeout(tick, CATCHUP_DELAY_MS);
}
