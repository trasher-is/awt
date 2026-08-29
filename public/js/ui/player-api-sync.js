// Player API background sync — wrapper realm only, mirrors battle-sync.js's shape.
//
// Two independent jobs on two independent clocks:
//   1. ListPlayer pull: the full active-roster list, cheap (one API call), kept fresh.
//      Cadence decays with round age — frequent early (most members join in the first two
//      weeks, not day one, waiting for a better starting location), relaxed later.
//   2. Player/{id} sweep: a slow, staleness-ordered background scan filling in the
//      activity/status fields ListPlayer doesn't have. Claims a batch via
//      /hub-api/sync/player-scan-claim (see that route's comment for what "claim" means
//      here), then calls Player/{id} once per claimed id. There is no rolling per-account
//      budget constant — SWEEP_BATCH_SIZE simply caps how many ids a single tick claims
//      (15 calls, once a minute, well under the game admin's 200-calls-per-5-minutes
//      limit), leaving the rest of that allowance for a member's own deliberate lookups
//      elsewhere in the hub. A re-entrancy flag (`sweeping`) keeps a slow tick from
//      overlapping the next scheduled one; the staleness query itself also floors out once
//      every player was scanned within the last 6 hours, so a fully-caught-up roster lets
//      the sweep go idle instead of burning calls re-scanning fields that haven't changed.
//
// Cross-tab dedup follows battle-sync.js's localStorage-lock pattern exactly.

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';

const AWApi = globalThis.AWApi;

const LIST_LOCK_KEY = 'awt.playerListSync.lock.v1';
const LIST_LOCK_TTL_MS = 4 * 60 * 1000; // shorter than even the frequent 5-min cadence
const LIST_INTERVAL_FREQUENT_MS = 5 * 60 * 1000;   // first ~2 weeks of a round
const LIST_INTERVAL_RELAXED_MS = 6 * 60 * 60 * 1000; // after that
const FREQUENT_PHASE_DAYS = 14;

const SWEEP_LOCK_KEY = 'awt.playerSweepSync.lock.v1';
const SWEEP_LOCK_TTL_MS = 50 * 1000; // shorter than the 60s sweep interval
const SWEEP_INTERVAL_MS = 60 * 1000;
// Hardcoded for this landing — see this plan's Global Constraints re: not wiring this to
// app_settings yet. Tune here directly if the 150-of-200 split needs adjusting.
const SWEEP_BATCH_SIZE = 15; // 15 calls/minute ≈ well under the 150-of-200-per-5-min reserve

function claimLock(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ttlMs) return false;
        localStorage.setItem(key, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage (private mode etc.) — degrade to "always run", same as game-rate-limit.js's fallback philosophy
    }
}

let listIntervalHandle = null;

async function pickListCadence() {
    try {
        const res = await fetch('/hub-api/round-age');
        const data = await res.json().catch(() => ({}));
        if (data && Number.isInteger(data.days_since) && data.days_since > FREQUENT_PHASE_DAYS) {
            return LIST_INTERVAL_RELAXED_MS;
        }
    } catch (err) { /* default to frequent on any failure — safer than under-syncing early */ }
    return LIST_INTERVAL_FREQUENT_MS;
}

async function runListPull() {
    if (!claimLock(LIST_LOCK_KEY, LIST_LOCK_TTL_MS)) return;
    try {
        const res = await AWApi.getPlayers();
        if (!res.ok || !Array.isArray(res.data) || !res.data.length) return;
        // The ONE shared API->sync mapper (aw-api.js) — never a local copy of it.
        const { players } = AWApi.mapPlayersToSyncPayload(res.data);
        const syncRes = await fetch('/hub-api/sync/player-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ players }),
        });
        const syncBody = await syncRes.json().catch(() => ({}));
        if (!syncRes.ok || !syncBody.success) {
            console.warn('[PlayerApiSync] list sync rejected:', syncRes.status, syncBody.error || '');
        }
    } catch (err) {
        console.warn('[PlayerApiSync] list pull failed:', err.message);
    }
}

async function scheduleNextListPull() {
    if (listIntervalHandle) clearTimeout(listIntervalHandle);
    const cadence = await pickListCadence();
    listIntervalHandle = setTimeout(async () => {
        await runListPull();
        scheduleNextListPull();
    }, cadence);
}

let sweeping = false;
async function runSweepTick() {
    // Re-entrancy guard: a tick can easily run long (up to SWEEP_BATCH_SIZE sequential
    // getPlayer calls + POSTs can exceed the 60s interval), and the cross-tab
    // claimLock/localStorage check above solves a DIFFERENT problem (another tab/window
    // running its own tick), not this one — an overlapping tick in the SAME tab would
    // otherwise always re-claim successfully and ticks could stack with no ceiling.
    if (sweeping) return;
    if (!claimLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)) return;
    sweeping = true;
    try {
        const claimRes = await fetch(`/hub-api/sync/player-scan-claim?limit=${SWEEP_BATCH_SIZE}`, { method: 'POST' });
        const claimed = await claimRes.json().catch(() => ({}));
        if (!claimRes.ok || !claimed.success) {
            console.warn('[PlayerApiSync] scan-claim failed:', claimRes.status, claimed.error || '');
            return;
        }
        const ids = Array.isArray(claimed.ids) ? claimed.ids : [];
        for (const id of ids) {
            const res = await AWApi.getPlayer(id);
            if (!res.ok || !res.data) continue;
            const d = res.data;
            const intel = d.intelligenceReport;
            const player = {
                id: d.id, name: typeof d.name === 'string' ? d.name : null,
                alliance_id: Number.isInteger(d.allianceId) ? d.allianceId : null,
                level: Number.isInteger(d.playerLevel) ? d.playerLevel : null,
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
                biology: intel ? intel.biologyLevel : null,
                economy: intel ? intel.economyLevel : null,
                energy: intel ? intel.energyLevel : null,
                mathematics: intel ? intel.mathematicsLevel : null,
                physics: intel ? intel.physicsLevel : null,
                social: intel ? intel.socialLevel : null,
                trade_revenue: intel ? intel.tradeBonus : null,
                artefact: intel && intel.activeArtefact ? JSON.stringify(intel.activeArtefact) : null,
                race_growth: intel && intel.race ? intel.race.growth : null,
                race_science: intel && intel.race ? intel.race.science : null,
                race_culture: intel && intel.race ? intel.race.culture : null,
                race_production: intel && intel.race ? intel.race.production : null,
                race_speed: intel && intel.race ? intel.race.speed : null,
                race_attack: intel && intel.race ? intel.race.attack : null,
                race_defense: intel && intel.race ? intel.race.defense : null,
                race_trader: intel && intel.race ? intel.race.trader : null,
                race_sul: intel && intel.race ? intel.race.sul : null,
            };
            const detailRes = await fetch('/hub-api/sync/player-detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player }),
            });
            const detailBody = await detailRes.json().catch(() => ({}));
            if (!detailRes.ok || !detailBody.success) {
                console.warn('[PlayerApiSync] player-detail sync failed for', id, detailRes.status, detailBody.error || '');
            }
        }
    } catch (err) {
        console.warn('[PlayerApiSync] sweep tick failed:', err.message);
    } finally {
        sweeping = false;
    }
}

let started = false;
export function initPlayerApiSync() {
    if (started) return;
    started = true;
    scheduleNextListPull();
    setInterval(runSweepTick, SWEEP_INTERVAL_MS);
}
