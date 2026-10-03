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
import { scrapeSystemById } from './system-parser.js';

const AWApi = globalThis.AWApi;
const { isStaleCapture } = globalThis.AWCaptureFreshness;

const SECTOR_BOUNDS = { x1: -40, y1: -40, x2: 40, y2: 40 }; // known map bounds ~-32..32, padded

// ─── SCAN LOG (diagnostics) ────────────────────────────────────────────────────
// Each scan reports one summary row to the hub (POST /hub-api/sync/scan-run -> galaxy_scan_runs) and
// stamps every system it posts with a run id and the age of its data. Why: two hubs recorded phantom
// population drops (a read one level low right after a growth tick) and nothing could say whether the
// browser cache, a cache in front of the game, a payload posted long after it was fetched, a throttled
// tab or a freshly opened one was to blame. See src/utils/scan-run.js for what each field answers.
// Everything here is best effort: it can never fail, delay or alter a scan.
let runCounter = 0; // scans started by THIS document; 0 is the first since the tab loaded

function clock() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

// randomUUID only exists in secure contexts (https): elsewhere it is absent, not a throw.
function makeRunId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// "Hidden at any moment during the run": a hidden tab has its timers throttled and can be frozen.
function watchVisibility() {
    const hasDocument = typeof document !== 'undefined';
    const hiddenAtStart = hasDocument && document.visibilityState === 'hidden';
    let wentHidden = hiddenAtStart;
    const onChange = () => { if (document.visibilityState === 'hidden') wentHidden = true; };
    if (hasDocument) document.addEventListener('visibilitychange', onChange);
    return {
        hiddenAtStart,
        wentHidden: () => wentHidden,
        stop: () => { if (hasDocument) document.removeEventListener('visibilitychange', onChange); },
    };
}

function createRunContext(opts) {
    return {
        runId: makeRunId(),
        runIndex: runCounter++,
        trigger: opts && opts.trigger === 'auto' ? 'auto' : 'manual',
        startedAt: clock(),
        watch: watchVisibility(),
        fetchedAt: null, meta: null,
        systemsTotal: 0, systemsPosted: 0, planetsPosted: 0, inVision: 0,
        postCount: 0, postMsTotal: 0, postMsMax: 0,
    };
}

function reportScanRun(ctx, result) {
    try {
        const meta = ctx.meta || {};
        const body = {
            run_id: ctx.runId,
            trigger: ctx.trigger,
            result: result && result.ok ? 'ok' : 'error',
            error: result && !result.ok ? String(result.error || '').slice(0, 200) : null,
            tab_age_s: Math.round(clock() / 1000),
            run_index: ctx.runIndex,
            hidden_at_start: ctx.watch.hiddenAtStart,
            went_hidden: ctx.watch.wentHidden(),
            systems_total: ctx.systemsTotal,
            systems_posted: ctx.systemsPosted,
            planets_posted: ctx.planetsPosted,
            in_vision: ctx.inVision,
            duration_ms: Math.round(clock() - ctx.startedAt),
            fetch_ms: meta.fetch_ms !== undefined ? meta.fetch_ms : null,
            post_ms_avg: ctx.postCount ? Math.round(ctx.postMsTotal / ctx.postCount) : null,
            post_ms_max: ctx.postCount ? Math.round(ctx.postMsMax) : null,
            response_status: meta.status !== undefined ? meta.status : null,
            cache_state: meta.cache_state || 'unknown',
            transfer_size: meta.transfer_size !== undefined ? meta.transfer_size : null,
            encoded_body_size: meta.encoded_body_size !== undefined ? meta.encoded_body_size : null,
            delivery_type: meta.delivery_type !== undefined ? meta.delivery_type : null,
            // A duration, not a timestamp, so this browser's clock never matters to the server.
            fetched_ago_ms: ctx.fetchedAt !== null ? Math.round(clock() - ctx.fetchedAt) : null,
            headers: meta.headers || {},
        };
        fetch('/hub-api/sync/scan-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
        }).catch(() => {});
    } catch (err) {
        // Never breaks a scan, but never silent either: a scan path that swallows errors lets a
        // partial scan look successful (see scrape-report.js).
        console.warn('[GalaxyScanLog] could not report this scan:', err && err.message);
    }
}

// onProgress(status, current, total) — current/total are 0 for indeterminate steps (the
// initial fetch, the index POST) and reflect systems-processed-so-far during the per-
// system planet loop. opts.trigger is 'auto' for the background tick, 'manual' (the default)
// for a button.
export async function seedGalaxyFromApi(onProgress = () => {}, opts = {}) {
    const ctx = createRunContext(opts);
    try {
        const result = await runSeed(onProgress, ctx);
        reportScanRun(ctx, result);
        return result;
    } catch (err) {
        reportScanRun(ctx, { ok: false, error: err && err.message });
        throw err;
    } finally {
        ctx.watch.stop();
    }
}

async function runSeed(onProgress, ctx) {
    onProgress('Asking the game for the map sectors…', 0, 0);
    const res = await AWApi.getMapSectors(SECTOR_BOUNDS, { meta: true });
    ctx.fetchedAt = clock();
    ctx.meta = res.meta || null;
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
    ctx.systemsTotal = allSystems.length;
    if (!allSystems.length) {
        return { ok: false, error: 'The game returned no systems in that area — nothing to seed.' };
    }

    // Planets arrive with owner/alliance ids only since the game's "map payload reduction"
    // change — put the names back before anything maps them (a no-op on the old shape).
    // A failed lookup is not fatal: /sync/system keeps the name it already has on record.
    onProgress('Resolving planet owners…', 0, 0);
    const owners = await AWApi.resolveSectorOwners(sectors);
    if (!owners.ok) console.warn('[GalaxySeed] some owner/alliance names could not be resolved this run');

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

    // No dedicated "list every alliance" API exists. The old sector alliances[] and, since
    // the id-only change, the Alliance/byIds answer the resolve step above already paid
    // for are the only bulk sources — both are read, so no extra request here.
    const { alliances: alliancePayload } = AWApi.mapSectorAlliancesToSyncPayload(sectors, owners.alliances);
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
    const siegeConfirmQueue = [];
    for (const sys of allSystems) {
        if (!sys || !Number.isInteger(sys.id)) continue;
        // isInVision alone isn't enough — see capture-freshness.js: the API can say
        // isInVision:true for a stale, hours-old snapshot (confirmed live: a real capture
        // exactly at the daily reset boundary, 20+ hours old, for a system only an ally
        // had personal vision on).
        const isInVision = !!sys.isInVision && !isStaleCapture(sys.capturedAt);
        visionFlags.push({ id: sys.id, is_in_vision: isInVision });

        const planets = Array.isArray(sys.planets) ? sys.planets : [];
        // A system this account can actually see comes back live, with no capturedAt at all
        // — the stamp only appears when the game is handing back a CACHED picture (always
        // the daily reset). The same system is live for a member with vision of it and a
        // midnight cache for everyone else, so saying which this is decides whose picture
        // wins server-side. Out of vision with no stamp, we simply do not know: send
        // neither and let the payload be unordered.
        const payload = AWApi.mapPlanetsToSyncPayload(sys.id, planets, sys.capturedAt, isInVision);
        // Which client path sent this — recorded beside every population change (population_trace).
        payload.source = 'api-seed';
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
        // Every detected change announces to Discord now (2026-09-12) — this used to send
        // scan_mode: 'silent' to suppress that during a bulk seed, but the announcer only
        // ever fires on a genuine transition against a real prior observation, so there was
        // never an actual flood risk; silencing it just meant conquests/pop-kills caught by
        // this seed announced nowhere. See /sync/system's own comment.

        // Which scan this is, and how old its data already is as it is posted: every system in a run
        // is posted one after another from a single fetch, so the last ones can be a while old.
        payload.run_id = ctx.runId;
        payload.fetch_age_ms = Math.round(clock() - ctx.fetchedAt);
        const postStartedAt = clock();
        const syncRes = await fetch('/hub-api/sync/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const postMs = clock() - postStartedAt;
        ctx.postCount++;
        ctx.postMsTotal += postMs;
        if (postMs > ctx.postMsMax) ctx.postMsMax = postMs;
        if (syncRes.ok) {
            systemsProcessed++;
            planetsProcessed += payload.planets.length;
            ctx.systemsPosted = systemsProcessed;
            ctx.planetsPosted = planetsProcessed;
            // The API reported a siege here that nobody has been able to attribute yet. Its
            // hasSiege flag is a bare boolean, equally true for a friendly fleet in orbit,
            // so acting on it alone once had the bot announcing an allied transit as an
            // enemy attack. The live system page DOES say whose siege it is, so queue one
            // page fetch to settle it (see the confirm pass after this loop).
            const body = await syncRes.json().catch(() => null);
            if (body && body.siege_unconfirmed && isInVision) siegeConfirmQueue.push(sys.id);
        }
        onProgress(`Seeding planets… ${systemsProcessed}/${allSystems.length} systems (${planetsProcessed} planets)`, systemsProcessed, allSystems.length);
    }

    ctx.inVision = visionFlags.filter(v => v.is_in_vision).length;
    if (visionFlags.length) {
        await fetch('/hub-api/sync/system-in-vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systems: visionFlags }),
        });
    }

    // SIEGE CONFIRM PASS: the only way to tell an enemy siege from an allied fleet parked in
    // orbit is the live system page, which labels the row and names the besieger — the API
    // cannot (see siege-indicator-parser.js). One page fetch per unattributed siege settles
    // it, and the answer is then remembered server-side, so a siege costs exactly one
    // confirm for as long as it lasts rather than one per tick. Cheap on purpose: page
    // fetches are not charged against the game's 200-per-5min API budget, only the shared
    // 5/sec gate, and only systems THIS account can actually see are queued (out of vision
    // the hub serves a synthetic page whose rows are script-rendered, so a scrape of one
    // parses to nothing and posts nothing — harmless, but a wasted request).
    //
    // Run after the main loop rather than inline so a slow page never stalls the seed, and
    // sequentially so a burst of new sieges cannot monopolise the shared request gate.
    let siegesConfirmed = 0;
    for (const systemId of siegeConfirmQueue) {
        onProgress(`Confirming siege in system ${systemId}…`, systemsProcessed, allSystems.length);
        try {
            if (await scrapeSystemById(systemId)) siegesConfirmed++;
        } catch (err) {
            console.warn('[GalaxySeed] siege confirm scrape failed for system', systemId, err.message);
        }
    }

    return {
        ok: true, systemsIndexed: indexPayload.length, alliancesIndexed: alliancePayload.length,
        systemsProcessed, planetsProcessed, siegesConfirmed,
    };
}

// Automatic background seeding — a frequent poll, not once a day.
// Briefly (2026-09-12) this ran once daily instead, on the theory that out-of-vision
// systems only truly refresh at the reset so re-asking sooner was wasted budget — true as
// far as it went, but it missed the actual point of this seed: system-change/pop-drop
// Discord announcements (src/routes/sync.js's announceSystemChanges) are driven by
// whatever this seed detects, and detection only happens when it runs. Real, in-vision
// changes (a conquest, a pop-kill, a colonization) need to be CAUGHT close to when they
// happen to be worth announcing — once a day turns "who's fighting where, right now" into
// a single overnight dump. And unlike the player sweep, running this more often costs
// nothing extra against the agreed budget: it's ONE Map/sectors call per run regardless of
// interval, so there is no real tradeoff to make here. Real live vision (bio-range) is a
// wholly separate concept handled elsewhere — see vision-model.js.
//
// IMPORTANT — what this still does NOT fix: even at a tight interval, Map/sectors only
// reports live data for systems currently isInVision (see the isInVision/vision_uncertain
// handling above and capture-freshness.js). It cannot produce fresh data for systems
// nobody has vision on — no amount of asking changes what the game will say about them.
// Getting THOSE current still needs either real vision (scouting/holding territory) or a
// member's browser physically visiting that system's page (spy.js's live DOM scrape, see
// issue #168 for the fuller writeup).
const AUTO_SEED_LOCK_KEY = 'awt.galaxyAutoSeed.lock.v1';
const AUTO_SEED_LOCK_TTL_MS = 4 * 60 * 1000; // shorter than AUTO_SEED_INTERVAL_MS
const AUTO_SEED_INTERVAL_MS = 5 * 60 * 1000;

function claimAutoSeedLock() {
    try {
        const raw = localStorage.getItem(AUTO_SEED_LOCK_KEY);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < AUTO_SEED_LOCK_TTL_MS) return false;
        localStorage.setItem(AUTO_SEED_LOCK_KEY, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same as player-api-sync.js
    }
}

async function runAutoSeedTick() {
    if (!claimAutoSeedLock()) return;
    try {
        const result = await seedGalaxyFromApi(undefined, { trigger: 'auto' });
        if (!result.ok) console.warn('[GalaxyAutoSeed] tick failed:', result.error);
    } catch (err) {
        console.warn('[GalaxyAutoSeed] tick failed:', err.message);
    }
}

let started = false;
export function startAutoGalaxySeed() {
    if (started) return;
    started = true;
    runAutoSeedTick();
    setInterval(runAutoSeedTick, AUTO_SEED_INTERVAL_MS);
}
