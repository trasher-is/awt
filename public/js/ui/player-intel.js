// public/js/ui/player-intel.js
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
                    <a href="/Game/Players/Profile/${p.id}" class="text-blue-400 hover:underline font-semibold" target="_top">${p.name || 'Unknown'}</a> 
                    <span class="text-xs text-muted-foreground ml-1">(#${p.id})</span>
                `;
            }
            
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