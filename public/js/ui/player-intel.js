// public/js/ui/player-intel.js
import { navToIframe } from './search.js';

let playerHeatmapChartInstance = null;

export async function loadPlayerIntel(playerId) {
    if (!playerId) return;
    try {
        const res = await fetch(`/hub-api/intel/player/${playerId}`);
        const data = await res.json();

        if (data.success && data.player) {
            const p = data.player;
            const playerLabel = document.getElementById('ui-player-id');
            if (playerLabel) {
                const allyTag = p.alliance_tag ? `[${p.alliance_tag}] ` : '';
                playerLabel.innerHTML = `
                    <span class="text-muted-foreground font-bold">${allyTag}</span>
                    <a href="#" data-player-profile="${p.id}" class="text-blue-400 hover:underline font-semibold">${p.name || 'Unknown'}</a>
                    <span class="text-xs text-muted-foreground ml-1">(#${p.id})</span>
                `;
                const profileLink = playerLabel.querySelector('[data-player-profile]');
                profileLink?.addEventListener('click', (e) => {
                    e.preventDefault();
                    navToIframe(`/Game/Players/Profile/${p.id}`);
                });
            }

            // Mark the player's planets on the in-game map and render the planet list.
            renderPlayerPlanets(p, data.systems || []);

            const row = (lbl, val) => `<div class="flex justify-between items-center py-0.5"><span class="text-muted-foreground">${lbl}</span><span class="font-medium text-foreground">${val}</span></div>`;
            const trait = (lbl, val) => `<div class="flex justify-between items-center py-0"><span class="text-muted-foreground">${lbl}</span><span class="font-medium text-foreground">${val > 0 ? '+'+val : val}</span></div>`;

            let intelBlocks = '';
            if (!p.has_intel) {
                intelBlocks = `
                    <div class="bg-card border border-border p-3 rounded shadow-sm text-center text-muted-foreground text-xs">
                        <i class="fa-solid fa-triangle-exclamation text-aw-warning mb-1 text-sm"></i><br>
                        <span class="text-foreground font-semibold block mb-0.5">No Intel Data</span>
                        Scan the profile in-game.
                    </div>`;
            } else {
                intelBlocks = `
                    <div class="flex flex-col gap-1 bg-card border border-border p-2 rounded shadow-sm">
                        <div class="text-s text-muted-foreground font-bold uppercase tracking-wider mb-1">Economy</div>
                        ${row('Trade Revenue', (p.trade_revenue || 0).toLocaleString())}
                        ${row('Eco Bonus', `+${p.eco_bonus || 0}%`)}
                        ${row('Artefact', p.artefact || 'None')}
                    </div>
                    <div class="flex flex-col gap-1 bg-card border border-border p-2 rounded shadow-sm">
                        <div class="text-s text-muted-foreground font-bold uppercase tracking-wider mb-1">Race Modifiers</div>
                        ${trait('Growth', p.race_growth || 0)}
                        ${trait('Science', p.race_science || 0)}
                        ${trait('Culture', p.race_culture || 0)}
                        ${trait('Production', p.race_production || 0)}
                        ${trait('Speed', p.race_speed || 0)}
                        ${trait('Attack', p.race_attack || 0)}
                        ${trait('Defense', p.race_defense || 0)}
                        ${p.race_trader && Number(p.race_trader) !== 0 ? trait('Trader', p.race_trader) : ''}
                        ${p.race_sul && Number(p.race_sul) !== 0 ? trait('Sul', p.race_sul) : ''}
                    </div>
                    <div class="flex flex-col gap-1 bg-card border border-border p-2 rounded shadow-sm">
                        <div class="text-s text-muted-foreground font-bold uppercase tracking-wider mb-1">Sciences</div>
                        <div class="grid grid-cols-2 gap-x-4">
                            ${row('Bio', p.biology || 0)}${row('Eco', p.economy || 0)}
                            ${row('Ene', p.energy || 0)}${row('Math', p.mathematics || 0)}
                            ${row('Phy', p.physics || 0)}${row('Soc', p.social || 0)}
                        </div>
                    </div>`;
            }

            document.getElementById('player-stats-list').innerHTML = `
                <div class="flex flex-col gap-2">
                    <div class="flex flex-col gap-1 bg-card border border-border p-2 rounded shadow-sm">
                        ${row('Points', (p.points || 0).toLocaleString())}
                        ${row('Ranking', p.ranking ? `#${p.ranking}` : '-')}
                        ${row('Level (PL)', p.level || '-')}
                        ${row('Planets', `${p.planet_count || 0} of ${p.has_intel ? p.culture_level : '--'}`)}
                        ${row('Status', p.idle_time || 'Unknown')}
                    </div>
                    ${intelBlocks}
                </div>`;

            if (data.heatmap) {
                const ctxH = document.getElementById('playerHeatmapChart')?.getContext('2d');
                if (ctxH) {
                    if (playerHeatmapChartInstance) playerHeatmapChartInstance.destroy();
                    const offsetHours = Math.round(-new Date().getTimezoneOffset() / 60);
                    const localHeatmap = Array(24).fill(0);
                    for (let i = 0; i < 24; i++) {
                        localHeatmap[(i + offsetHours + 24) % 24] = data.heatmap[i];
                    }
                    
                    playerHeatmapChartInstance = new Chart(ctxH, {
                        type: 'bar',
                        data: {
                            labels: Array.from({length: 24}, (_, i) => `${i}h`),
                            datasets: [{ label: 'Activity', data: localHeatmap, backgroundColor: 'rgba(34, 197, 94, 0.6)', borderColor: '#22c55e', borderWidth: 1, borderRadius: 2 }]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            plugins: { legend: { display: false } },
                            scales: { x: { ticks: { color: 'hsl(240 5% 64.9%)', font: { size: 8 } }, grid: { display: false } }, y: { display: false } }
                        }
                    });
                }
            }
        }
    } catch (err) { console.error(err); }
}

function renderPlayerPlanets(p, systems) {
    const gameFrame = document.getElementById('game-frame');

    // Highlight the systems where this player owns planets on the map.
    gameFrame?.contentWindow?.postMessage({
        type: 'HIGHLIGHT_PLAYER_VISION',
        payload: {
            systems: systems.map(s => ({ id: s.id, name: s.name, x: s.x, y: s.y })),
            range: p.biology || 0,
            originSystemId: p.origin_system || null
        }
    }, window.location.origin);

    const list = document.getElementById('player-planets-list');
    if (!list) return;

    if (!systems.length) {
        list.innerHTML = '<span class="text-muted-foreground italic text-xs">No known planets.</span>';
        return;
    }

    list.innerHTML = systems.map(s => `
        <button data-system-path="/Game/Map/SolarSystem/${s.id}" class="btn-player-planet text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md px-2 py-1 text-s transition-colors flex justify-between items-center shadow-sm">
            <span class="truncate font-medium">${s.name || `System #${s.id}`}</span>
            <span class="text-s text-muted-foreground font-mono">${s.x}/${s.y}</span>
        </button>`).join('');

    list.querySelectorAll('.btn-player-planet').forEach(btn => {
        btn.addEventListener('click', (e) => {
            navToIframe(e.currentTarget.getAttribute('data-system-path'));
        });
    });
}