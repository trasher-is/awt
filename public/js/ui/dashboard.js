import { handleSearchInput } from './search.js';
import { loadPlans, savePlan, deletePlan, setIntelSystemId } from './system-intel.js';
import {
    openDatabasePanel,
    openSystemDatabasePanel,
    openPlanetDatabasePanel,
    openFleetDatabasePanel,
    openEnemyIntelPanel,
    openAllianceStatsPanel,
    openTradeAgreementsPanel,
    openBattleCalcPanel,
    openTravelCalcPanel,
    openRoutePlannerPanel,
    openBuildOrderPanel
} from './archives.js';
import { runPlayerScan } from '../scrapers/mass-scanner.js';
import '../utils/sqlite-time.js';    // side-effect import: puts the model on globalThis
import '../utils/vision-model.js';   // side-effect import: the !vision rule, defined once

const { formatSqliteUtc } = globalThis.AWSqliteTime;

let toolUser = null;
let currentSystemId = null;

export function getCurrentSystemId() { return currentSystemId; }

// --- DOM INITIALIZATION & EVENT LISTENERS ---
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const gameFrame = document.getElementById('game-frame');
    if (gameFrame) gameFrame.src = urlParams.get('p') || '/';

    document.getElementById('mobile-trigger')?.addEventListener('click', toggleSidebar);
    document.getElementById('sidebar-toggle-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('save-plan-btn')?.addEventListener('click', savePlan);
    document.getElementById('logout-btn')?.addEventListener('click', logout);

    document.getElementById('search-player-input')?.addEventListener('input', () => handleSearchInput('player'));
    document.getElementById('search-system-input')?.addEventListener('input', () => handleSearchInput('system'));
    document.getElementById('search-alliance-input')?.addEventListener('input', () => handleSearchInput('alliance'));

    document.getElementById('admin-panel-btn')?.addEventListener('click', () => {
        window.location.href = '/admin';
    });

    document.getElementById('open-war-room-btn')?.addEventListener('click', openEnemyIntelPanel);
    document.getElementById('open-alliance-stats-btn')?.addEventListener('click', openAllianceStatsPanel);
    document.getElementById('open-trade-agreements-btn')?.addEventListener('click', openTradeAgreementsPanel);
    document.getElementById('open-players-db-btn')?.addEventListener('click', openDatabasePanel);
    document.getElementById('open-systems-db-btn')?.addEventListener('click', openSystemDatabasePanel);
    document.getElementById('open-planets-db-btn')?.addEventListener('click', openPlanetDatabasePanel);
    document.getElementById('open-fleets-db-btn')?.addEventListener('click', openFleetDatabasePanel);
    document.getElementById('open-battle-calc-btn')?.addEventListener('click', openBattleCalcPanel);
    document.getElementById('open-travel-calc-btn')?.addEventListener('click', openTravelCalcPanel);
    document.getElementById('open-route-planner-btn')?.addEventListener('click', openRoutePlannerPanel);
    document.getElementById('open-build-order-btn')?.addEventListener('click', openBuildOrderPanel);
    // Loaded on demand: the map pulls a canvas renderer nobody needs until they ask for it.
    document.getElementById('open-galaxy-map-btn')?.addEventListener('click', async () => {
        const { openGalaxyMapPanel } = await import('./galaxy-map.js');
        await openGalaxyMapPanel(toolUser && toolUser.id);
    });
    document.getElementById('link-discord-btn')?.addEventListener('click', requestDiscordLinkCode);

    document.getElementById('btn-mass-scan')?.addEventListener('click', runMassGalaxyScan);
    document.getElementById('btn-mass-scan-players')?.addEventListener('click', runMassPlayerScan);
    document.getElementById('btn-deep-scan-players')?.addEventListener('click', runDeepScanPlayers);
    document.getElementById('btn-sync-battles')?.addEventListener('click', runManualBattleSync);
    refreshBattleReportsWatermark();
    refreshDeepScanStatus();

    // --- EVENT DELEGATION FOR DYNAMIC ELEMENTS ---
    // Player/system/alliance search results are NOT wired here — search.js binds a
    // listener directly to each result button as it renders them (executeSearch). A
    // leftover duplicate delegation used to live here too: every result click fired
    // navToIframe twice, which on mobile closed the sidebar and then immediately reopened
    // it (toggleSidebar flipped 'expanded' off then straight back on in the same click).

    document.getElementById('plans-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-delete-plan');
        if (btn) {
            const planetIdx = btn.getAttribute('data-planet');
            deletePlan(planetIdx);
        }
    });

    if (localStorage.getItem('sidebarOpen') === 'true' && window.innerWidth >= 768) {
        document.getElementById('sidebar')?.classList.add('expanded');
        document.getElementById('mobile-trigger')?.classList.add('hidden');
        refreshDbStats(); 
    } else if (window.innerWidth < 768) {
        document.getElementById('mobile-trigger')?.classList.remove('hidden');
    }
    
    initWrapper();

    // Background battle-report sync (first pull 10 s after load, then every 30 min).
    // Loaded on demand like the galaxy map: the dashboard shell never blocks on it.
    import('./battle-sync.js')
        .then(({ initBattleSync }) => initBattleSync())
        .catch(err => console.warn('[BattleSync] failed to start:', err));

    // Background player API sync (ListPlayer roster refresh + staleness-ordered Player/{id}
    // detail sweep). Same on-demand-load pattern as battle-sync above.
    import('./player-api-sync.js')
        .then(({ initPlayerApiSync }) => initPlayerApiSync())
        .catch(err => console.warn('[PlayerApiSync] failed to start:', err));

    // Background battle-report ship-detail sweep. Same on-demand-load pattern as the
    // other two background sync modules above.
    import('./battle-report-detail-sync.js')
        .then(({ initBattleReportDetailSync }) => initBattleReportDetailSync())
        .catch(err => console.warn('[BattleReportDetailSync] failed to start:', err));
});

// --- CORE UI CONTROLS ---
export function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const mobileBtn = document.getElementById('mobile-trigger');
    if (!sidebar) return;
    
    sidebar.classList.toggle('expanded');
    const isOpen = sidebar.classList.contains('expanded');
    localStorage.setItem('sidebarOpen', isOpen);
    
    if (window.innerWidth < 768 && mobileBtn) {
        isOpen ? mobileBtn.classList.add('hidden') : mobileBtn.classList.remove('hidden');
    }
    if (isOpen) refreshDbStats();
}

// Bind to the global window so other components can reach it
window.toggleSidebar = toggleSidebar;

export function showToast(message) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    if (!toast || !toastMsg) return;
    
    toastMsg.innerText = message;
    toast.classList.add('toast-active');
    toast.classList.remove('toast-enter');
    setTimeout(() => { 
        toast.classList.remove('toast-active'); 
        toast.classList.add('toast-enter'); 
    }, 2500);
}
window.showToast = showToast;

async function initWrapper() {
    try {
        const res = await fetch('/hub-api/me');
        if (res.ok) {
            toolUser = await res.json();
            if (toolUser.role === 'admin') {
                const adminBtn = document.getElementById('admin-panel-btn');
                if (adminBtn) adminBtn.style.display = 'flex';
            }
        }
    } catch (err) {}
}

// The Hub half of the Discord link challenge. You are already logged in here, which is
// the proof "!link <name>" never had — that command took a name and bound whoever typed
// it, so anyone could claim any unlinked account.
async function requestDiscordLinkCode() {
    const box = document.getElementById('link-discord-box');
    const codeEl = document.getElementById('link-discord-code');
    const noteEl = document.getElementById('link-discord-note');
    if (!box || !codeEl) return;

    box.classList.remove('hidden');
    codeEl.textContent = '…';
    noteEl.textContent = '';
    try {
        const res = await fetch('/hub-api/link-code', { method: 'POST' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
        if (d.alreadyLinked) {
            codeEl.textContent = '—';
            noteEl.textContent = d.message;
            return;
        }
        codeEl.textContent = `!link ${d.code}`;
        const mins = Math.round((d.expiresInSeconds || 600) / 60);
        noteEl.textContent = `Or /link code:${d.code} — expires in ${mins} minutes, single use.`;
    } catch (err) {
        codeEl.textContent = '—';
        noteEl.textContent = err.message;
    }
}

async function logout() {
    await fetch('/hub-api/logout', { method: 'POST' }); 
    window.location.href = '/hub-assets/login.html'; 
}

async function refreshDbStats() {
    try {
        const res = await fetch('/hub-api/intel/summary');
        const data = await res.json();
        if (data.success) {
            if (document.getElementById('stat-planets')) document.getElementById('stat-planets').innerText = data.planets;
            if (document.getElementById('stat-players')) document.getElementById('stat-players').innerText = data.players;
            if (document.getElementById('stat-fleets')) document.getElementById('stat-fleets').innerText = data.fleets || 0;
            if (document.getElementById('stat-alliances')) document.getElementById('stat-alliances').innerText = data.alliances;
        }
    } catch (err) {}
}

// --- MULTI-FRAME LISTENER (lenient guard) ---
window.addEventListener('message', async (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;

    if (data.type === 'GAME_CONTEXT') {
        const p = data.payload;
        if (p.path) {
            const currentUrl = new URL(window.location);
            if (currentUrl.searchParams.get('p') !== p.path) window.history.replaceState(null, '', `/dashboard?p=${p.path}`);
        }

        if (p.playerName && toolUser && toolUser.gameName) {
            if (toolUser.role !== 'admin' && p.playerName.toLowerCase() !== toolUser.gameName.toLowerCase()) {
                const response = await fetch('/hub-api/nuke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detectedName: p.playerName }) });
                const nukeData = await response.json();
                if (nukeData.banned) {
                    document.body.innerHTML = `<div style="color:red; font-size:24px; padding:50px; text-align:center;"><h1>SECURITY BREACH DETECTED</h1><p>Banned.</p></div>`;
                    setTimeout(() => window.location.href = '/hub-assets/login.html', 3000);
                    return;
                }
            }
        }

        const ctxContainer = document.getElementById('context-tools');
        const btnMap = document.getElementById('btn-ctx-map');
        const sysLabel = document.getElementById('ui-sys-id');

        // Relaxed check that won't break the rest of the code if elements are missing in the wrapper file
        if (ctxContainer) {
            const isIntel = p.isSystemView || p.isPlayerView || p.isMap;
            if (isIntel) {
                ctxContainer.classList.add('hidden');
                if (btnMap) btnMap.classList.add('hidden');
                if (sysLabel) sysLabel.classList.add('hidden');

                if (p.isSystemView && p.systemId) {
                    currentSystemId = p.systemId;
                    ctxContainer.classList.remove('hidden');
                    if (sysLabel) {
                        sysLabel.classList.remove('hidden');
                        // Set immediately from what GAME_CONTEXT already knows (the id);
                        // loadPlans below refines this to "System Data - #{id} {name}"
                        // once the system's name comes back from the hub archive.
                        sysLabel.innerText = `System Data - #${p.systemId}`;
                    }
                    loadPlans(p.systemId);
                }
                // p.isPlayerView: no sidebar panel to populate anymore — the profile page
                // shows Hub data injected directly (page-injections.js's
                // initProfileHubIntel). Still counts as "intel" above so ctxContainer
                // (system tools) hides while viewing a profile, same as before.
                if (p.isMap && p.mapX && p.mapY) {
                    ctxContainer.classList.remove('hidden');
                    if (btnMap) btnMap.classList.remove('hidden');
                    const mapCoords = document.getElementById('ui-map-coords');
                    if (mapCoords) mapCoords.innerText = `${p.mapX} / ${p.mapY}`;
                }
            } else if (p.path && !p.path.includes('/Profile/') && !p.path.includes('/SolarSystem/')) {
                ctxContainer.classList.add('hidden');
                if (btnMap) btnMap.classList.add('hidden');
            }
        }
    } else if (data.type === 'SHOW_TOAST') {
        showToast(data.payload);
        refreshDbStats();
    }
});

const container = document.getElementById('scan-progress-container');
const textStatus = document.getElementById('scan-status-text');
const textCount = document.getElementById('scan-count-text');
const bar = document.getElementById('scan-progress-bar');

function updateScanProgress(statusMsg, current, total) {
    if (textStatus) textStatus.innerText = statusMsg;
    if (textCount) textCount.innerText = total > 0 ? `${current}/${total}` : '';
    let percent = total > 0 ? Math.round((current / total) * 100) : 0;
    if (bar) bar.style.width = `${Math.min(percent, 100)}%`;
}

function setScanButtonsDisabled(disabled) {
    document.getElementById('btn-mass-scan').disabled = disabled;
    document.getElementById('btn-mass-scan-players').disabled = disabled;
    const deepBtn = document.getElementById('btn-deep-scan-players');
    if (deepBtn) deepBtn.disabled = disabled;
}

async function runMassGalaxyScan() {
    setScanButtonsDisabled(true);
    container?.classList.replace('hidden', 'flex');
    // Loaded on demand, same discipline as battle-sync.js/player-api-sync.js below — the
    // dashboard shell never blocks on it.
    const { seedGalaxyFromApi } = await import('../scrapers/api-galaxy-seed.js');
    const result = await seedGalaxyFromApi(updateScanProgress);
    if (result.ok) {
        const msg = `Indexed ${result.systemsIndexed} systems, ${result.alliancesIndexed} alliances, seeded ${result.planetsProcessed} planets across ${result.systemsProcessed} of them`;
        updateScanProgress(msg, result.systemsProcessed, result.systemsIndexed);
        showToast(msg);
    } else {
        updateScanProgress(result.error, 0, 0);
        showToast(result.error);
    }
    setScanButtonsDisabled(false);
    setTimeout(() => refreshDbStats(), 500);
}

async function runMassPlayerScan() {
    setScanButtonsDisabled(true);
    container?.classList.replace('hidden', 'flex');
    await runPlayerScan(updateScanProgress);
    setScanButtonsDisabled(false);
    setTimeout(() => refreshDbStats(), 500);
}

// "Deep scan": the manual, immediate, much-bigger cousin of the quiet background sweep
// (player-api-sync.js's runSweepTick, 15 players/minute). Forces the roster list fresh
// first, then claims and scans up to DEEP_SCAN_LIMIT stale players in one shot. Claiming
// bumps last_api_scan_at right away, so if 150 isn't the whole roster, running it again —
// from this browser after the cooldown, or from a teammate's browser right now — simply
// picks up the NEXT stale batch instead of re-claiming these ones.
const DEEP_SCAN_LIMIT = 150;

async function runDeepScanPlayers() {
    setScanButtonsDisabled(true);
    container?.classList.replace('hidden', 'flex');
    const { deepScanPlayers } = await import('./player-api-sync.js');
    const result = await deepScanPlayers(DEEP_SCAN_LIMIT, updateScanProgress);
    if (result.ok) {
        const msg = `Deep scan: updated ${result.scanned}/${result.claimed} player(s)`
            + (result.failed ? `, ${result.failed} failed` : '')
            + (result.listUpdated != null ? ` · roster refreshed (${result.listUpdated} active players)` : '');
        updateScanProgress(msg, result.scanned, result.claimed || 1);
        showToast(msg);
    } else if (result.error === 'cooldown') {
        showToast('Deep scan already ran recently on this browser — try again in a few minutes, or have another member run it.');
    } else if (result.error === 'session') {
        showToast('Deep scan needs your game session — log into the game first, then try again.');
    } else {
        updateScanProgress(`Deep scan failed: ${result.error}`, 0, 0);
        showToast(`Deep scan failed: ${result.error}`);
    }
    setScanButtonsDisabled(false);
    setTimeout(() => refreshDbStats(), 500);
    refreshDeepScanStatus();
}

// Status line under the Deep scan button: how many players are on record and "fresh" (by
// the exact same 6-hour floor the claim itself uses), and when the most recent claim of
// any size last touched a row — so members can see at a glance whether it's worth clicking
// again or better left for the cooldown/a teammate.
async function refreshDeepScanStatus() {
    const el = document.getElementById('deep-scan-status');
    if (!el) return;
    try {
        const res = await fetch('/hub-api/sync/player-scan-status');
        const data = await res.json();
        if (!data.success) { el.textContent = ''; return; }
        const fresh = data.total - data.stale;
        const lastScan = formatSqliteUtc(data.last_scan_at, undefined, 'never');
        el.textContent = `${fresh}/${data.total} players fresh · last scan: ${lastScan}`;
    } catch (err) {
        el.textContent = '';
    }
}

// Manual "sync now" for battle reports — the background battle-sync.js module already
// pulls every 30 min, and battle-report-detail-sync.js's ship-detail sweep runs on its
// own separate 90 s timer; this runs BOTH immediately, back-to-back, for a member who
// wants !mortal/!lastseen to reflect a fight right now instead of waiting on either clock.
async function runManualBattleSync() {
    const btn = document.getElementById('btn-sync-battles');
    const originalHtml = btn ? btn.innerHTML : null;
    if (btn) btn.disabled = true;
    try {
        if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Syncing reports...';
        const { triggerManualSync } = await import('./battle-sync.js');
        const syncResult = await triggerManualSync();
        if (!syncResult.ok) {
            // No alliance yet is no longer a failure case here — battle-sync.js falls
            // back to a per-player search instead, so anything reaching this branch is a
            // genuine problem (bridge unresolved, or the search itself failed).
            showToast(`Battle-report sync failed: ${syncResult.error || 'unknown error'}`);
            return;
        }

        if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Scraping details...';
        const { triggerManualSweep, triggerManualLocationBackfill } = await import('./battle-report-detail-sync.js');
        const sweepResult = await triggerManualSweep();

        // Legacy gap: reports already scraped before planet capture existed, or by a
        // stale browser tab still running old JS, are stuck with ship_detail_scraped_at
        // set but no location — triggerManualSweep's claim never revisits them (it only
        // looks at ship_detail_scraped_at IS NULL). This is the separate one-time pass.
        if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Backfilling locations...';
        const backfillResult = await triggerManualLocationBackfill();

        const syncMsg = syncResult.inserted > 0 ? `Synced ${syncResult.inserted} new report(s)` : 'Reports up to date';
        const parts = [syncMsg];
        parts.push(sweepResult.ok ? `scraped location/CV for ${sweepResult.scraped} report(s)` : `ship-detail sweep failed (${sweepResult.error || 'unknown error'})`);
        if (backfillResult.claimed > 0 || !backfillResult.ok) {
            parts.push(backfillResult.ok ? `backfilled location for ${backfillResult.scraped}/${backfillResult.claimed} legacy report(s)` : `location backfill failed (${backfillResult.error || 'unknown error'})`);
        }
        showToast(parts.join('. ') + '.');
        refreshBattleReportsWatermark();
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

// "Synced through: <date>" under the button — the date battle-sync.js's next pull will
// use as BattleDateFrom. Reads the hub-wide DB value via a GET, not battle-sync.js's own
// newestStartedAt (a per-tab module variable that resets to null on every fresh load), so
// it reflects reality even before this tab has run a sync of its own.
async function refreshBattleReportsWatermark() {
    const el = document.getElementById('battle-reports-watermark');
    if (!el) return;
    try {
        const res = await fetch('/hub-api/sync/battle-reports-watermark');
        const data = await res.json();
        el.textContent = data.newest_started_at
            ? `Synced through: ${new Date(data.newest_started_at).toLocaleString()}`
            : 'No reports synced yet';
    } catch (err) {
        el.textContent = '';
    }
}