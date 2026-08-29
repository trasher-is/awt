import { handleSearchInput, navToIframe } from './search.js';
import { loadPlans, savePlan, deletePlan, setIntelSystemId } from './system-intel.js';
import { loadPlayerIntel } from './player-intel.js';
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
import { runMassScan, runPlayerScan } from '../scrapers/mass-scanner.js';
import { initNotes, toggleNotesPanel } from './notes.js';
import '../utils/vision-model.js';   // side-effect import: the !vision rule, defined once

const { visionRadius } = globalThis.AWVision;

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
    document.getElementById('toggle-alliance-vision')?.addEventListener('change', handleAllianceVisionToggle);
    
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
    document.getElementById('notes-trigger')?.addEventListener('click', toggleNotesPanel);
    initNotes();

    document.getElementById('btn-mass-scan')?.addEventListener('click', runMassGalaxyScan);
    document.getElementById('btn-mass-scan-players')?.addEventListener('click', runMassPlayerScan);

    // --- EVENT DELEGATION FOR DYNAMIC ELEMENTS ---
    document.getElementById('search-player-results')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-search-player');
        if (btn) {
            const id = btn.getAttribute('data-player-id');
            document.getElementById('search-player-input').value = '';
            document.getElementById('search-player-results').innerHTML = '';
            loadPlayerIntel(id);
            
            // Ensure the player block shows up in the sidebar
            document.getElementById('player-context-tools')?.classList.remove('hidden');
            document.getElementById('context-tools')?.classList.add('hidden');
        }
    });

    document.getElementById('search-system-results')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-search-system');
        if (btn) {
            const path = btn.getAttribute('data-path');
            document.getElementById('search-system-input').value = '';
            document.getElementById('search-system-results').innerHTML = '';
            navToIframe(path);
        }
    });

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

async function handleAllianceVisionToggle() {
    const isChecked = document.getElementById('toggle-alliance-vision').checked;
    const iframe = document.getElementById('game-frame');
    if (!iframe || !iframe.contentWindow) return;

    if (!isChecked) {
        iframe.contentWindow.postMessage({ type: 'CLEAR_ALLIANCE_VISION' }, window.location.origin);
        return;
    }

    showToast('Collecting alliance radar data...');
    try {
        const [statsRes, playersRes] = await Promise.all([
            fetch('/hub-api/intel/alliance-stats'),
            fetch('/hub-api/intel/players')
        ]);
        const statsData = await statsRes.json();
        const playersData = await playersRes.json();

        if (statsData.success && playersData.success) {
            // The radius rule comes from vision-model.js rather than being spelled out
            // here. It used to be `p.biology > 0` with `range: p.biology`, which silently
            // dropped every member whose biology has never been scraped — the column
            // defaults to 0 — while `!vision` on Discord still reported them using their
            // science level. Two answers to one question, and this was the quiet one.
            const memberIds = new Set(statsData.stats.map(row => Number(row.player_id)));
            const allianceVisionData = playersData.players
                .filter(p => memberIds.has(Number(p.id)) && p.origin_system)
                .map(p => ({
                    playerId: p.id,
                    playerName: p.name,
                    originSystemId: p.origin_system,
                    range: visionRadius(p)
                }));

            iframe.contentWindow.postMessage({ type: 'SHOW_ALLIANCE_VISION', payload: { visions: allianceVisionData } }, window.location.origin);
        } else {
            showToast('Failed to merge radar network');
            document.getElementById('toggle-alliance-vision').checked = false;
        }
    } catch (err) {
        showToast('Data streams unavailable');
        document.getElementById('toggle-alliance-vision').checked = false;
    }
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
        const playerCtxContainer = document.getElementById('player-context-tools');
        const btnMap = document.getElementById('btn-ctx-map');
        const sysLabel = document.getElementById('ui-sys-id');
        const playerLabel = document.getElementById('ui-player-id');
        
        // Relaxed check that won't break the rest of the code if elements are missing in the wrapper file
        if (ctxContainer && playerCtxContainer) {
            const isIntel = p.isSystemView || p.isPlayerView || p.isMap;
            if (isIntel) {
                ctxContainer.classList.add('hidden');
                playerCtxContainer.classList.add('hidden');
                if (btnMap) btnMap.classList.add('hidden');
                if (sysLabel) sysLabel.classList.add('hidden');
                if (playerLabel) playerLabel.classList.add('hidden');

                if (p.isSystemView && p.systemId) {
                    currentSystemId = p.systemId;
                    ctxContainer.classList.remove('hidden'); 
                    if (sysLabel) {
                        sysLabel.classList.remove('hidden');
                        sysLabel.innerText = `System #${p.systemId}`;
                    }
                    loadPlans(p.systemId);
                } 
                if (p.isPlayerView && p.playerId) { 
                    playerCtxContainer.classList.remove('hidden');
                    if (playerLabel) {
                        playerLabel.classList.remove('hidden');
                        playerLabel.innerText = `#${p.playerId}`;
                    }
                    loadPlayerIntel(p.playerId);
                }
                if (p.isMap && p.mapX && p.mapY) {
                    ctxContainer.classList.remove('hidden'); 
                    if (btnMap) btnMap.classList.remove('hidden');
                    const mapCoords = document.getElementById('ui-map-coords');
                    if (mapCoords) mapCoords.innerText = `${p.mapX} / ${p.mapY}`;
                }
            } else if (p.path && !p.path.includes('/Profile/') && !p.path.includes('/SolarSystem/')) {
                ctxContainer.classList.add('hidden');
                playerCtxContainer.classList.add('hidden');
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

async function runMassGalaxyScan() {
    document.getElementById('btn-mass-scan').disabled = true;
    document.getElementById('btn-mass-scan-players').disabled = true;
    container?.classList.replace('hidden', 'flex');
    await runMassScan(updateScanProgress);
    document.getElementById('btn-mass-scan').disabled = false;
    document.getElementById('btn-mass-scan-players').disabled = false;
    setTimeout(() => refreshDbStats(), 500);
}

async function runMassPlayerScan() {
    document.getElementById('btn-mass-scan').disabled = true;
    document.getElementById('btn-mass-scan-players').disabled = true;
    container?.classList.replace('hidden', 'flex');
    await runPlayerScan(updateScanProgress);
    document.getElementById('btn-mass-scan').disabled = false;
    document.getElementById('btn-mass-scan-players').disabled = false;
    setTimeout(() => refreshDbStats(), 500);
}