import { loadPlayerIntel } from './player-intel.js';
import { esc } from '../utils/escape.js';
import '../utils/game-rate-limit.js'; // side-effect import: the shared 5/s gate AWApi rides
import '../utils/aw-api.js';         // side-effect import: the game API client, gate included

const AWApi = globalThis.AWApi;

let searchTimeout = null;

export function handleSearchInput(type) { 
    clearTimeout(searchTimeout); 
    searchTimeout = setTimeout(() => { executeSearch(type); }, 300); 
}

async function executeSearch(type) {
    const input = document.getElementById(`search-${type}-input`);
    const resultsContainer = document.getElementById(`search-${type}-results`);
    if (!input || !resultsContainer) return;

    const q = input.value.trim();
    if (!q) { 
        resultsContainer.innerHTML = ''; 
        if (type === 'player') {
            document.getElementById('game-frame')?.contentWindow?.postMessage({ type: 'CLEAR_PLAYER_VISION' }, window.location.origin);
        }
        return; 
    }

    resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2"><i class="fa-solid fa-circle-notch fa-spin"></i> Searching...</div>';
    try {
        const res = await fetch(`/hub-api/search/${type}?q=${encodeURIComponent(q)}`);
        const data = await res.json();

        if (!data.success || data.results.length === 0) {
            if (type === 'alliance' || type === 'system') {
                resultsContainer.innerHTML = `
                    <div class="text-s text-muted-foreground text-center py-2 bg-card rounded border border-border">
                        Not found in the hub's records.
                        <button id="btn-search-live-${type}" class="block w-full mt-2 h-7 rounded border border-input bg-zinc-950 text-xs text-foreground hover:bg-accent transition-colors">
                            <i class="fa-solid fa-cloud-arrow-down mr-1"></i>Search the game directly
                        </button>
                    </div>`;
                document.getElementById(`btn-search-live-${type}`)?.addEventListener('click', () => searchLiveViaApi(type, q, resultsContainer));
            } else {
                resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2 bg-card rounded border border-border">Not found.</div>';
            }
            return;
        }

        if (type === 'player') {
            resultsContainer.innerHTML = data.results.map(p => `
                <button data-player-id="${p.id}" class="btn-search-player text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${p.alliance_tag ? `<span class="text-muted-foreground font-normal">[${esc(p.alliance_tag)}]</span> ` : ''}${esc(p.name || `#${p.id}`)}${
                        // Matched on a name from an earlier round rather than the current
                        // one. Say so — otherwise the result looks like a mistake, because
                        // the text shown is not the text that was typed.
                        p.former_name ? `<span class="text-muted-foreground font-normal"> — was ${esc(p.former_name)}${p.former_round ? ` (${esc(p.former_round)})` : ''}</span>` : ''
                    }</span>
                    <span class="text-s text-muted-foreground font-mono">#${p.id}</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-player').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = e.currentTarget.getAttribute('data-player-id');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    loadPlayerIntel(id);
                    
                    // Force-open the sidebar player section during manual search
                    document.getElementById('player-context-tools')?.classList.remove('hidden');
                    document.getElementById('context-tools')?.classList.add('hidden');
                });
            });
        } else if (type === 'system') {
            resultsContainer.innerHTML = data.results.map(s => `
                <button data-path="/Game/Map/SolarSystem/${s.id}" class="btn-search-system text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${esc(s.name)}</span>
                    <span class="text-s text-muted-foreground font-mono">#${s.id} (${s.x}/${s.y})</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-system').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const path = e.currentTarget.getAttribute('data-path');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    navToIframe(path);
                });
            });
        } else if (type === 'alliance') {
            resultsContainer.innerHTML = data.results.map(a => `
                <button data-path="/Game/Alliance/Profile/${a.id}" class="btn-search-alliance text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${a.tag ? `[${esc(a.tag)}] ` : ''}${esc(a.name || `#${a.id}`)}</span>
                    <span class="text-s text-muted-foreground font-mono">${a.member_count != null ? `${a.member_count} members` : `#${a.id}`}</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-alliance').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const path = e.currentTarget.getAttribute('data-path');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    navToIframe(path);
                });
            });
        }
    } catch (err) { resultsContainer.innerHTML = '<div class="text-s text-red-500 text-center py-2">Error.</div>'; }
}

// A manual, member-triggered escape hatch: the hub's own DB found nothing, so ask the
// game's REST API directly, sync whatever it finds into the hub's DB through the existing
// sync routes, then re-run the same DB-backed search so the result renders through the
// normal path. Never fires automatically — only on this explicit click.
async function searchLiveViaApi(type, q, resultsContainer) {
    resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2"><i class="fa-solid fa-circle-notch fa-spin"></i> Asking the game…</div>';
    try {
        if (type === 'alliance') {
            const res = await AWApi.searchAlliances({ q, limit: 20 });
            if (!res.ok) {
                resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">${res.reason === 'session' ? 'Log into the game first, then try again.' : 'The game did not answer.'}</div>`;
                return;
            }
            const alliances = (Array.isArray(res.data) ? res.data : []).map(a => ({
                id: a.id, name: a.name, tag: a.tag, full_name: a.fullName, member_count: a.memberCount,
            }));
            if (alliances.length) {
                await fetch('/hub-api/sync/alliance-search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ alliances }),
                });
            }
        } else if (type === 'system') {
            const res = await AWApi.searchSolarSystems({ q, limit: 20 });
            if (!res.ok) {
                resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">${res.reason === 'session' ? 'Log into the game first, then try again.' : 'The game did not answer.'}</div>`;
                return;
            }
            const systems = (Array.isArray(res.data) ? res.data : [])
                .filter(s => s && s.x != null && s.y != null)
                .map(s => ({
                    id: s.id, name: s.name, x: s.x, y: s.y,
                    full_name: typeof s.fullName === 'string' ? s.fullName : null,
                    info: typeof s.info === 'string' ? s.info : null,
                    population_level: Number.isInteger(s.populationLevel) ? s.populationLevel : null,
                }));
            if (systems.length) {
                await fetch('/hub-api/sync/galaxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ systems }),
                });
            }
        }
        // Re-run the same DB-backed search now that the sync (if anything was found) landed.
        await executeSearch(type);
    } catch (err) {
        resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">Live search failed: ${err.message}</div>`;
    }
}

export function navToIframe(path) {
    const gameFrame = document.getElementById('game-frame');
    if (gameFrame) gameFrame.src = path;
    if (window.innerWidth < 768 && typeof window.toggleSidebar === 'function') window.toggleSidebar();
}