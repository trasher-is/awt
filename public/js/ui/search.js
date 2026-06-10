import { loadPlayerIntel } from './player-intel.js';

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

    resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2"><i class="fa-solid fa-circle-notch fa-spin"></i> Ieškoma...</div>';
    try {
        const res = await fetch(`/hub-api/search/${type}?q=${encodeURIComponent(q)}`);
        const data = await res.json();

        if (!data.success || data.results.length === 0) {
            resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2 bg-card rounded border border-border">Nerasta.</div>';
            return;
        }

        if (type === 'player') {
            resultsContainer.innerHTML = data.results.map(p => `
                <button data-player-id="${p.id}" class="btn-search-player text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${p.alliance_tag ? `<span class="text-muted-foreground font-normal">[${p.alliance_tag}]</span> ` : ''}${p.name}</span>
                    <span class="text-s text-muted-foreground font-mono">#${p.id}</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-player').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = e.currentTarget.getAttribute('data-player-id');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    loadPlayerIntel(id);
                });
            });
        } else if (type === 'system') {
            resultsContainer.innerHTML = data.results.map(s => `
                <button data-path="/Game/Map/SolarSystem/${s.id}" class="btn-search-system text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${s.name}</span>
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
        }
    } catch (err) { resultsContainer.innerHTML = '<div class="text-s text-red-500 text-center py-2">Klaida.</div>'; }
}

export function navToIframe(path) {
    const gameFrame = document.getElementById('game-frame');
    if (gameFrame) gameFrame.src = path;
    if (window.innerWidth < 768 && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
}