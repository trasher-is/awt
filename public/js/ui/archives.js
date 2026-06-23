// public/js/ui/archives.js
let rawDbPlayers = [], dbSortCol = 'points', dbSortAsc = false;
let rawDbSystems = [], sysDbSortCol = 'id', sysDbSortAsc = true;
let rawDbPlanets = [], plnDbSortCol = 'system_id', plnDbSortAsc = true;
let rawDbFleets = [], fltDbSortCol = 'cv', fltDbSortAsc = false;
let rawDbAllyStats = [], allyStatsSortCol = 'player_id', allyStatsSortAsc = true;

function closeOtherPanels(exceptId) {
    ['database-panel', 'system-database-panel', 'planet-database-panel', 'fleet-database-panel', 'alliance-stats-panel', 'enemy-intel-panel', 'trade-agreements-panel'].forEach(id => {
        if (id !== exceptId) document.getElementById(id)?.classList.replace('translate-x-0', 'translate-x-full');
    });
}

function convertLegacyClickAttributes(panel, panelContextType) {
    panel.querySelectorAll('th[onclick]').forEach(th => {
        const onClickValue = th.getAttribute('onclick');
        const match = onClickValue.match(/\('(.*)'\)/);
        if (match) {
            const columnField = match[1];
            th.removeAttribute('onclick'); 
            th.addEventListener('click', () => {
                if (panelContextType === 'player') { if (dbSortCol === columnField) dbSortAsc = !dbSortAsc; else { dbSortCol = columnField; dbSortAsc = false; } renderPlayerTable(); }
                if (panelContextType === 'system') { if (sysDbSortCol === columnField) sysDbSortAsc = !sysDbSortAsc; else { sysDbSortCol = columnField; sysDbSortAsc = true; } renderSystemTable(); }
                if (panelContextType === 'planet') { if (plnDbSortCol === columnField) plnDbSortAsc = !plnDbSortAsc; else { plnDbSortCol = columnField; plnDbSortAsc = true; } renderPlanetTable(); }
                if (panelContextType === 'fleet') { if (fltDbSortCol === columnField) fltDbSortAsc = !fltDbSortAsc; else { fltDbSortCol = columnField; fltDbSortAsc = false; } renderFleetTable(); }
                if (panelContextType === 'ally') { if (allyStatsSortCol === columnField) allyStatsSortAsc = !allyStatsSortAsc; else { allyStatsSortCol = columnField; allyStatsSortAsc = true; } renderAllyStatsTable(); }
            });
        }
    });

    panel.querySelector('button[onclick*="close"]')?.removeAttribute('onclick');
    panel.querySelector('button')?.addEventListener('click', () => {
        panel.classList.replace('translate-x-0', 'translate-x-full');
    });
}

export async function openDatabasePanel() {
    let panel = document.getElementById('database-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/players-db.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('database-panel');
        convertLegacyClickAttributes(panel, 'player');
        panel.querySelector('#db-search-input')?.addEventListener('input', renderPlayerTable);
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('database-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    document.getElementById('db-table-body').innerHTML = '<tr><td colspan="26" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Intelligence...</td></tr>';
    try {
        const res = await fetch('/hub-api/intel/players');
        const data = await res.json();
        if (data.success) { rawDbPlayers = data.players; renderPlayerTable(); }
    } catch (err) { document.getElementById('db-table-body').innerHTML = '<tr><td colspan="26" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
}

export async function openSystemDatabasePanel() {
    let panel = document.getElementById('system-database-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/systems-db.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('system-database-panel');
        convertLegacyClickAttributes(panel, 'system');
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('system-database-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    
    document.getElementById('sys-db-table-body').innerHTML = '<tr><td colspan="7" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Archive...</td></tr>';
    try {
        const res = await fetch('/hub-api/intel/systems_db');
        const data = await res.json();
        if (data.success) { rawDbSystems = data.systems; renderSystemTable(); }
    } catch (err) { document.getElementById('sys-db-table-body').innerHTML = '<tr><td colspan="7" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
}

export async function openPlanetDatabasePanel() {
    let panel = document.getElementById('planet-database-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/planets-db.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('planet-database-panel');
        convertLegacyClickAttributes(panel, 'planet');
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('planet-database-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    
    document.getElementById('pln-db-table-body').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Archive...</td></tr>';
    try {
        const res = await fetch('/hub-api/intel/planets_db');
        const data = await res.json();
        if (data.success) { rawDbPlanets = data.planets; renderPlanetTable(); }
    } catch (err) { document.getElementById('pln-db-table-body').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
}

export async function openFleetDatabasePanel() {
    let panel = document.getElementById('fleet-database-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/fleets-db.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('fleet-database-panel');
        convertLegacyClickAttributes(panel, 'fleet');
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('fleet-database-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    
    document.getElementById('flt-db-table-body').innerHTML = '<tr><td colspan="11" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Archive...</td></tr>';
    try {
        const res = await fetch('/hub-api/intel/fleets_db');
        const data = await res.json();
        if (data.success) { 
            rawDbFleets = data.fleets.map(f => ({...f, cv: (f.destroyers * 3) + (f.cruisers * 24) + (f.battleships * 60)})); 
            renderFleetTable(); 
        }
    } catch (err) { document.getElementById('flt-db-table-body').innerHTML = '<tr><td colspan="11" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
}

// --- WAR ROOM (ENEMY INTEL) LOGIKA ---
let warRoomData = [];
let warRoomSortCol = '';
let warRoomSortAsc = false;
let selectedAllianceId = null;

export async function openEnemyIntelPanel() {
    let panel = document.getElementById('enemy-intel-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/enemy-intel.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('enemy-intel-panel');

        panel.querySelector('#close-war-room-btn')?.addEventListener('click', () => {
            panel.classList.replace('translate-x-0', 'translate-x-full');
        });

        panel.querySelector('#btn-refresh-enemy-intel')?.addEventListener('click', refreshActiveWarAlliance);

        panel.querySelectorAll('th[data-sort-col]').forEach(th => {
            th.addEventListener('click', (e) => {
                const col = e.currentTarget.getAttribute('data-sort-col');
                const type = e.currentTarget.getAttribute('data-sort-type');
                sortWarRoom(col, type);
            });
        });
    }

    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('enemy-intel-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    
    loadWarRoomAlliancesList();
}

function parseIdleStringToSeconds(idleStr) {
    if (!idleStr || idleStr === 'Unknown') return -1;
    if (/active|online/i.test(idleStr)) return 0;
    
    let secs = 0;
    const d = idleStr.match(/(\d+)\s*d/);
    const h = idleStr.match(/(\d+)\s*h/);
    const m = idleStr.match(/(\d+)\s*m/);
    const s = idleStr.match(/(\d+)\s*s/);
    
    if (!d && !h && !m && !s) return -1;
    if (d) secs += parseInt(d[1]) * 86400;
    if (h) secs += parseInt(h[1]) * 3600;
    if (m) secs += parseInt(m[1]) * 60;
    if (s) secs += parseInt(s[1]);
    return secs;
}

function formatRaceModifier(val, isMasked) {
    if (isMasked) return '<span class="text-zinc-600">?</span>';
    if (val === null || val === undefined) return '<span class="text-zinc-500">-</span>';
    return val > 0 ? `<span class="text-emerald-500 font-bold">+${val}</span>` : val < 0 ? `<span class="text-rose-500 font-bold">${val}</span>` : `<span class="text-zinc-400">${val}</span>`;
}

async function loadWarRoomAlliancesList() {
    try {
        const res = await fetch('/hub-api/intel/war-room/alliances');
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        const pillsBox = document.getElementById('war-room-alliance-pills');
        pillsBox.innerHTML = '';

        if(data.alliances.length === 0) {
            pillsBox.innerHTML = '<span class="text-xs text-muted-foreground font-mono">No external alliance profiles scanned.</span>';
            return;
        }

        data.alliances.forEach(a => {
            const btn = document.createElement('button');
            btn.className = `px-3 py-1 text-xs font-mono font-bold uppercase rounded border transition-all flex items-center gap-1.5 ${
                selectedAllianceId === a.id 
                ? 'bg-red-500 text-black border-red-400 shadow shadow-red-500/20' 
                : 'bg-zinc-900 text-zinc-300 border-border hover:bg-zinc-800 hover:text-white'
            }`;
            btn.addEventListener('click', () => selectWarRoomAlliance(a.id, a.tag, a.last_scan_time));
            btn.innerHTML = `<span>[${a.tag}]</span><span class="px-1 py-0.25 bg-black/40 rounded text-[10px] text-muted-foreground border border-white/5">${a.active_members_count}</span>`;
            pillsBox.appendChild(btn);
        });
    } catch (err) {}
}

function selectWarRoomAlliance(allianceId, tag, lastScanTime) {
    selectedAllianceId = allianceId;
    document.getElementById('btn-refresh-enemy-intel').removeAttribute('disabled');
    
    if (lastScanTime) {
        const d = new Date(lastScanTime);
        document.getElementById('enemy-intel-last-scanned').innerText = `Last Scanned: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
    } else {
        document.getElementById('enemy-intel-last-scanned').innerText = 'Last Scanned: N/A';
    }

    loadWarRoomMatrixData();
    loadWarRoomAlliancesList();
}

// Production bonus from a player's artifact. Only Cathedral (CD), Major (MJ) and
// Horizon (HOR) artifacts at levels 1-3 boost production: +10% / +20% / +30%.
// Anything else (incl. "N/A" or empty) is neutral (1x).
function artifactProdMultiplier(artefact) {
    if (!artefact) return 1;
    const m = String(artefact).toUpperCase().match(/(CD|MJ|HOR)\s*([123])/);
    if (!m) return 1;
    return 1 + parseInt(m[2], 10) * 0.10;
}

async function loadWarRoomMatrixData() {
    if (!selectedAllianceId) return;
    const tbody = document.getElementById('enemy-intel-table-body');
    tbody.innerHTML = `<tr><td colspan="14" class="text-center py-6 font-mono text-zinc-400"><i class="fa-solid fa-spinner fa-spin me-2 text-red-500"></i> Decrypting intelligence matrices from DB indexes...</td></tr>`;

    try {
        const res = await fetch(`/hub-api/intel/war-room/players?alliance_id=${selectedAllianceId}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        warRoomData = data.players.map(p => {
            const factories = p.total_factories || 0;
            const pop = p.total_population || 0;
            const eco = p.economy || 0;
            const social = p.social || 0;

            // ~Prod/h = (factories + population) base, scaled by race production trait,
            // trade revenue %, and a qualifying production artifact.
            //   race_production: -4..+4, each step = 4%  ->  1 + race_production*0.04
            //   trade_revenue:   stored as % (e.g. 49 = +49%)  ->  1 + tr/100
            //   artifact:        CD/MJ/HOR lvl 1/2/3 = +10/20/30%
            const base = factories + pop;
            const raceMult = 1 + (p.race_production || 0) * 0.04;
            const trMult = 1 + (p.trade_revenue || 0) / 100;
            const estimatedProd = base * raceMult * trMult * artifactProdMultiplier(p.artefact);
            const dailyPP = estimatedProd * 24;
            const costFor3CV = 30 - Math.floor(eco * 0.3);
            const cvDay = costFor3CV > 0 ? Math.floor((dailyPP / costFor3CV) * 3) : 0;
            const maxCv = pop * (social + 3) * 10;
            const idleSecs = parseIdleStringToSeconds(p.idle_time);

            return { ...p, calculated_prod: estimatedProd, cv_day: cvDay, max_cv: maxCv, idle_seconds: idleSecs };
        });

        if (warRoomSortCol) executeWarRoomSortingRoutine();
        else renderWarRoomTable(warRoomData);
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="14" class="text-center py-6 text-red-500 font-bold">API Sync Failure Exception Event: ${err.message}</td></tr>`;
    }
}

function renderWarRoomTable(data) {
    const tbody = document.getElementById('enemy-intel-table-body');
    tbody.innerHTML = '';

    if(data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="14" class="text-center py-6 text-zinc-500">No scanned player rows mapped to this target index loop</td></tr>`;
        return;
    }

    data.forEach(p => {
        // Changed from !p.economy to !p.has_intel check
        const isUnknown = !p.has_intel;
        let idleStyle = "color: #a1a1aa;"; 
        if (p.idle_seconds >= 0) {
            const idleMins = p.idle_seconds / 60;
            const cappedMins = Math.min(idleMins, 360); 
            const hue = 120 - (cappedMins / 360) * 120;
            idleStyle = `background-color: hsla(${hue}, 75%, 12%, 0.45); color: hsl(${hue}, 90%, 65%); border: 1px solid hsla(${hue}, 75%, 25%, 0.3);`;
        }

        const q = '<span class="text-zinc-600 font-bold">?</span>';
        const tr = document.createElement('tr');
        tr.className = "hover:bg-zinc-900/40 transition-colors border-b border-zinc-900/60";
        tr.innerHTML = `
            <td class="sticky left-0 z-10 bg-black px-2 py-1 font-bold text-foreground break-words leading-tight w-[110px] border-r border-zinc-800"><a href="/Game/Players/Profile/${p.id}" target="_blank" class="hover:underline hover:text-red-400">${p.name}</a></td>
            <td class="px-2 py-1 text-right text-zinc-300">${isUnknown ? q : p.economy}</td>
            <td class="px-2 py-1 text-right text-emerald-400 font-bold">${Math.round(p.calculated_prod).toLocaleString()}</td>
            <td class="px-2 py-1 text-right text-primary">${isUnknown ? q : (p.trade_revenue || 0) + '%'}</td>
            <td class="px-2 py-1 text-right text-amber-400 font-bold">${isUnknown ? q : p.cv_day.toLocaleString()}</td>
            <td class="px-2 py-1 text-right text-cyan-400">${isUnknown ? q : p.max_cv.toLocaleString()}</td>
            <td class="px-2 py-1 text-right">${formatRaceModifier(p.race_attack, isUnknown)}</td><td class="px-2 py-1 text-right">${formatWarRoomModifier(p.race_defense, isUnknown)}</td><td class="px-2 py-1 text-right">${formatRaceModifier(p.race_speed, isUnknown)}</td>
            <td class="px-2 py-1 text-right text-zinc-300">${isUnknown ? q : (p.physics || 0)}</td>
            <td class="px-2 py-1 text-right text-zinc-300">${isUnknown ? q : (p.mathematics || 0)}</td>
            <td class="px-2 py-1 text-right text-zinc-300">${isUnknown ? q : (p.energy || 0)}</td>
            <td class="px-2 py-1"><span class="px-1.5 py-0.5 rounded text-[11px] font-mono tracking-wide whitespace-nowrap" style="${idleStyle}">${p.idle_time || 'Unknown'}</span></td>
            <td class="px-2 py-1 text-right text-zinc-400 font-bold">${p.total_planets || 0} / ${isUnknown ? '?' : (p.culture_level || '?')}</td>
        `;
        tbody.appendChild(tr);
    });
}

function formatWarRoomModifier(val, isMasked) {
     return formatRaceModifier(val, isMasked);
}

function sortWarRoom(colKey, type) {
    if (warRoomSortCol === colKey) warRoomSortAsc = !warRoomSortAsc;
    else { warRoomSortCol = colKey; warRoomSortAsc = (type === 'string'); }
    executeWarRoomSortingRoutine();
}

function executeWarRoomSortingRoutine() {
    warRoomData.sort((a, b) => {
        let valA = a[warRoomSortCol]; let valB = b[warRoomSortCol];
        if (typeof valA === 'string') { valA = valA ? valA.toLowerCase() : ''; valB = valB ? valB.toLowerCase() : ''; } 
        else { valA = valA === null || valA === undefined ? (warRoomSortAsc ? 99999999 : -99999999) : valA; valB = valB === null || valB === undefined ? (warRoomSortAsc ? 99999999 : -99999999) : valB; }

        if (valA < valB) return warRoomSortAsc ? -1 : 1;
        if (valA > valB) return warRoomSortAsc ? 1 : -1;
        return 0;
    });
    renderWarRoomTable(warRoomData);
}

// UPDATED: Live re-filtering of enemy alliance members from the game page
async function refreshActiveWarAlliance() {
    if (!selectedAllianceId) return;
    const btn = document.getElementById('btn-refresh-enemy-intel');
    const icon = document.getElementById('icon-refresh-enemy-intel');
    if (!btn || btn.disabled) return;

    btn.setAttribute('disabled', 'true');
    if (icon) icon.className = 'fa-solid fa-circle-notch fa-spin';

    if (typeof window.showToast === 'function') window.showToast('Fetching alliance member list...');

    try {
        // 1. Load the alliance profile directly from the AstroWars game
        const res = await fetch(`/Game/Alliance/Profile/${selectedAllianceId}`);
        if (!res.ok) throw new Error('Failed to fetch game alliance profile data');
        
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        
        // 2. Collect the ID links of all members in it
        const links = doc.querySelectorAll('a[href^="/Game/Players/Profile/"]');
        const playerIds = Array.from(links)
            .map(link => parseInt(link.getAttribute('href').split('/').pop(), 10))
            .filter(id => !isNaN(id));
            
        const uniqueIds = Array.from(new Set(playerIds));

        if (uniqueIds.length === 0) {
            if (typeof window.showToast === 'function') window.showToast('No members found in alliance profile');
            btn.removeAttribute('disabled');
            if (icon) icon.className = 'fa-solid fa-rotate';
            return;
        }

        if (typeof window.showToast === 'function') window.showToast(`Updating ${uniqueIds.length} members...`);

        // 3. Dynamically import the mass scanner to avoid circular dependencies
        const { scanPlayerList } = await import('../scrapers/mass-scanner.js');
        
        // Run a deep refresh through the scraper
        await scanPlayerList(uniqueIds, (statusMsg, current, total) => {
            btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${current}/${total}`;
        });

        if (typeof window.showToast === 'function') window.showToast('Scan completed successfully!');
        
        // 4. Reload the matrix from the DB
        await loadWarRoomMatrixData();
    } catch (err) {
        console.error(err);
        if (typeof window.showToast === 'function') window.showToast(`Error: ${err.message}`);
    } finally {
        if (btn) {
            btn.removeAttribute('disabled');
            btn.innerHTML = `<i id="icon-refresh-enemy-intel" class="fa-solid fa-rotate"></i> Rescan Alliance`;
        }
    }
}

export async function openAllianceStatsPanel() {
    let panel = document.getElementById('alliance-stats-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/alliance-stats.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('alliance-stats-panel');
        convertLegacyClickAttributes(panel, 'ally');
        
        const updateBtn = document.getElementById('btn-update-alliance-stats');
        if (updateBtn) {
            updateBtn.removeAttribute('onclick');
            updateBtn.addEventListener('click', triggerAllianceStatsUpdate);
        }
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('alliance-stats-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    
    document.getElementById('ally-stats-table-body').innerHTML = '<tr><td colspan="17" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Reading Alliance Records...</td></tr>';
    await refreshAllianceStatsData();
}

export async function refreshAllianceStatsData() {
    try {
        const res = await fetch('/hub-api/intel/alliance-stats');
        const data = await res.json();
        if (data.success) { rawDbAllyStats = data.stats; renderAllyStatsTable(); }
    } catch (err) {}
}

// Extract trade-partner names from a member's /Game/Alliance/Member page.
// The "Trade Partners" table has the header in <thead> and partner rows in
// <tbody> (each: player link + alliance tag + Receiving/Giving %). We scope to
// that table and pull the player-profile links — which skips the column-label
// row, the "Sum" row, and the [TAG] alliance links automatically.
function parseTradePartners(mDoc) {
    let table = null;
    mDoc.querySelectorAll('th').forEach(th => {
        if (!table && /trade partners/i.test(th.innerText)) table = th.closest('table');
    });
    if (!table) return [];

    const partners = [];
    table.querySelectorAll('a[href*="/Game/Players/Profile/"]').forEach(a => {
        const name = a.innerText.trim();
        if (name) partners.push(name);
    });
    return partners;
}

export async function triggerAllianceStatsUpdate() {
    const btn = document.getElementById('btn-update-alliance-stats');
    const icon = document.getElementById('icon-update-alliance-stats');
    if (btn) btn.disabled = true;
    if (icon) icon.className = 'fa-solid fa-circle-notch fa-spin';
    
    if (typeof window.showToast === 'function') window.showToast('Fetching alliance member list...');
    try {
        const res = await fetch('/Game/Alliance');
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const memberLinks = Array.from(doc.querySelectorAll('a[href*="/Game/Alliance/Member/"]'));
        if (memberLinks.length === 0) {
            if (typeof window.showToast === 'function') window.showToast('No members found');
            return;
        }

        if (typeof window.showToast === 'function') window.showToast(`Updating ${memberLinks.length} members' data...`);
        const syncedIds = [];
        const tradePairs = [];
        for (const link of memberLinks) {
            try {
                const targetUrl = link.href;
                const idMatch = targetUrl.match(/\/Member\/(\d+)/);
                if (!idMatch) continue;

                const mRes = await fetch(targetUrl);
                const mDoc = new DOMParser().parseFromString(await mRes.text(), 'text/html');
                const tds = Array.from(mDoc.querySelectorAll('td'));
                const name = mDoc.querySelector('a[href*="/Game/Players/Profile/"]')?.innerText.trim();
                if (!name) continue;

                // Collect this member's completed trade agreements from their Trade Partners table.
                parseTradePartners(mDoc).forEach(partner => tradePairs.push([name, partner]));

                const planetTd = tds.find(td => td.innerHTML.includes('Planets<br>(Next Culture)'));
                let planetsText = '', nextCultureSeconds = null;
                if (planetTd && planetTd.nextElementSibling) {
                    planetsText = planetTd.nextElementSibling.innerText.split('(')[0].trim();
                    const timerSpan = planetTd.nextElementSibling.querySelector('#nextCulture');
                    if (timerSpan) nextCultureSeconds = parseInt(timerSpan.getAttribute('data-value'), 10);
                }

                const getRate = (lbl) => { const td = tds.find(t => t.innerText.trim() === lbl); return td?.nextElementSibling ? td.nextElementSibling.innerText.trim().split(' ')[0] : ''; };
                const getSimpleVal = (lbl) => { const td = tds.find(t => t.innerText.trim() === lbl); return td?.nextElementSibling ? td.nextElementSibling.innerText.trim() : ''; };
                const getSimpleValInt = (lbl) => { const td = tds.find(t => t.innerText.trim() === lbl); return td?.nextElementSibling ? parseInt(td.nextElementSibling.innerText.trim(), 10) || 0 : 0; };

                const pLevelTd = tds.find(t => t.innerText.includes('Player Level') && t.querySelector('a[data-href*="PlayerLevelTable"]'));
                const cvLimitTd = tds.find(t => t.innerText.includes('CV Limit'));

                const payload = {
                    player_id: parseInt(idMatch[1], 10), name, planets_text: planetsText, next_culture_seconds: nextCultureSeconds,
                    science_rate: getRate('Science'), culture_rate: getRate('Culture'), production_rate: getRate('Production'),
                    astro_dollars: getSimpleVal('Astro Dollars'), production_points: getSimpleVal('Production Points'), artefact: getSimpleVal('Artefact'),
                    level_text: pLevelTd?.nextElementSibling ? pLevelTd.nextElementSibling.innerText.trim().replace(/\s+/g, ' ') : '',
                    cv_limit_text: cvLimitTd?.nextElementSibling ? cvLimitTd.nextElementSibling.innerText.trim().replace(/\s+/g, ' ') : '',
                    economy: getSimpleValInt('Economy'), energy: getSimpleValInt('Energy'), mathematics: getSimpleValInt('Mathematics'), physics: getSimpleValInt('Physics'), population: getSimpleValInt('Population')
                };

                await fetch('/hub-api/sync/alliance-stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                syncedIds.push(payload.player_id);
            } catch (e) {}
        }
        // Reconcile the roster: drop stats for members who have since resigned/left,
        // so they no longer appear in alliance stats or the trade-agreements board.
        if (syncedIds.length) {
            try {
                await fetch('/hub-api/sync/alliance-roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_ids: syncedIds }) });
            } catch (e) {}
        }
        // Sync completed trade agreements gathered from members' Trade Partners tables.
        if (tradePairs.length) {
            try {
                await fetch('/hub-api/sync/trade-partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs: tradePairs }) });
            } catch (e) {}
        }
        if (typeof window.showToast === 'function') window.showToast('Sinchronizacija baigta');
        await refreshAllianceStatsData();
    } catch (err) {
        if (typeof window.showToast === 'function') window.showToast('Sinchronizacija nutraukta');
    } finally {
        if (btn) btn.disabled = false;
        if (icon) icon.className = 'fa-solid fa-rotate';
    }
}

// Parse a DB timestamp that may be ISO ("2026-06-22T10:00:00.000Z") or a sqlite
// "YYYY-MM-DD HH:MM:SS" (UTC, no zone) into a localized short string.
function fmtIntelDate(val) {
    if (!val) return '-';
    let d = new Date(val);
    if (isNaN(d) && typeof val === 'string') d = new Date(val.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '-';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// True if the intel timestamp is parseable and older than 24h (used to grey stale sciences).
function isIntelStale(val) {
    if (!val) return false;
    let d = new Date(val);
    if (isNaN(d) && typeof val === 'string') d = new Date(val.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return false;
    return (Date.now() - d.getTime()) > 24 * 3600 * 1000;
}

function renderPlayerTable() {
    const input = document.getElementById('db-search-input');
    const q = (input ? input.value : '').toLowerCase();
    let f = rawDbPlayers.filter(p => (p.name && p.name.toLowerCase().includes(q)) || (p.id && p.id.toString().includes(q)) || (p.alliance_tag && p.alliance_tag.toLowerCase().includes(q)));
    f.sort((a, b) => { let v1 = a[dbSortCol]||0, v2 = b[dbSortCol]||0; if(typeof v1==='string')v1=v1.toLowerCase(); if(typeof v2==='string')v2=v2.toLowerCase(); return v1<v2 ? (dbSortAsc?-1:1) : (v1>v2 ? (dbSortAsc?1:-1) : 0); });
    const countEl = document.getElementById('db-result-count'); if (countEl) countEl.innerText = f.length;
    const tbody = document.getElementById('db-table-body'); if (!tbody) return;

    const q0 = '<span class="text-zinc-600">?</span>';   // intel-gated unknown
    tbody.innerHTML = f.map(p => {
        const intel = !!p.has_intel;
        // Public columns are always shown; deep-scan columns show "?" until intel is captured.
        const gated = (val, fmt) => intel ? (fmt ? fmt(val) : (val ?? 0)) : q0;
        // Sciences go grey once the captured intel is older than 24h.
        const stale = isIntelStale(p.intel_updated_at);
        const sci = (color) => stale ? 'text-zinc-500' : color;
        return `
        <tr class="hover:bg-accent/50 transition-colors">
            <td class="p-3 font-medium text-foreground sticky left-0 z-10 bg-card"><a href="/Game/Players/Profile/${p.id}" target="_blank" class="hover:underline hover:text-primary">${p.name || 'Unknown'}</a></td>
            <td class="p-3 text-aw-warning">${p.alliance_tag ? `[${p.alliance_tag}]` : '-'}</td>
            <td class="p-3">${p.level || 0}</td>
            <td class="p-3 text-blue-300">${p.science_level || 0}</td>
            <td class="p-3 text-purple-300">${p.culture_level || 0}</td>
            <td class="p-3 text-primary font-medium">${(p.points || 0).toLocaleString()}</td>
            <td class="p-3 border-l border-border">${p.planet_count || 0}</td>
            <td class="p-3 text-primary">${(p.total_population || 0).toLocaleString()}</td>
            <td class="p-3 whitespace-nowrap">${intel ? `${(p.cv_used || 0).toLocaleString()}/${(p.cv_limit || 0).toLocaleString()}` : q0}</td>
            <td class="p-3 border-l border-border">${formatRaceModifier(p.race_growth, !intel)}</td>
            <td class="p-3">${formatRaceModifier(p.race_science, !intel)}</td>
            <td class="p-3">${formatRaceModifier(p.race_culture, !intel)}</td>
            <td class="p-3">${formatRaceModifier(p.race_production, !intel)}</td>
            <td class="p-3">${formatRaceModifier(p.race_speed, !intel)}</td>
            <td class="p-3">${formatRaceModifier(p.race_attack, !intel)}</td>
            <td class="p-3">${formatRaceModifier(p.race_defense, !intel)}</td>
            <td class="p-3 text-center">${intel ? (p.race_trader > 0 ? '<i class="fa-solid fa-check text-emerald-400"></i>' : '') : q0}</td>
            <td class="p-3 text-primary border-l border-border">${intel ? (p.trade_revenue || 0) + '%' : q0}</td>
            <td class="p-3 ${sci('text-green-400')} border-l border-border">${gated(p.biology)}</td>
            <td class="p-3 ${sci('text-yellow-400')}">${gated(p.economy)}</td>
            <td class="p-3 ${sci('text-purple-400')}">${gated(p.energy)}</td>
            <td class="p-3 ${sci('text-orange-400')}">${gated(p.mathematics)}</td>
            <td class="p-3 ${sci('text-blue-400')}">${gated(p.physics)}</td>
            <td class="p-3 ${sci('text-pink-400')}">${gated(p.social)}</td>
            <td class="p-3 border-l border-border">${intel ? (p.artefact || '-') : q0}</td>
            <td class="p-3 text-muted-foreground border-l border-border">${fmtIntelDate(p.intel_updated_at)}</td>
        </tr>`;
    }).join('');
}

function renderSystemTable() {
    const input = document.getElementById('sys-db-search-input');
    const q = (input ? input.value : '').toLowerCase();
    let f = rawDbSystems.filter(s => (s.name && s.name.toLowerCase().includes(q)) || (s.id && s.id.toString().includes(q)));
    f.sort((a, b) => { let v1 = a[sysDbSortCol]||0, v2 = b[sysDbSortCol]||0; if(typeof v1==='string')v1=v1.toLowerCase(); if(typeof v2==='string')v2=v2.toLowerCase(); return v1<v2 ? (sysDbSortAsc?-1:1) : (v1>v2 ? (sysDbSortAsc?1:-1) : 0); });
    const countEl = document.getElementById('sys-db-result-count'); if (countEl) countEl.innerText = f.length;
    const tbody = document.getElementById('sys-db-table-body'); if (!tbody) return;
    tbody.innerHTML = f.map(s => `
        <tr class="hover:bg-accent/50 transition-colors">
            <td class="p-3 font-mono">${s.id}</td><td class="p-3 font-medium text-foreground">${s.name || 'Unknown'}</td><td>${s.x}</td><td>${s.y}</td><td class="p-3 border-l border-border text-aw-ally">${s.planet_count || 0}</td><td class="p-3 text-aw-enemy">${s.fleet_count || 0}</td><td class="p-3 border-l border-border text-muted-foreground">${new Date(s.updated_at).toLocaleString()}</td>
        </tr>`).join('');
}

function renderPlanetTable() {
    const input = document.getElementById('pln-db-search-input');
    const q = (input ? input.value : '').toLowerCase();
    let f = rawDbPlanets.filter(p => (p.system_name && p.system_name.toLowerCase().includes(q)) || (p.owner_name && p.owner_name.toLowerCase().includes(q)));
    f.sort((a, b) => { let v1 = a[plnDbSortCol]||0, v2 = b[plnDbSortCol]||0; if(typeof v1==='string')v1=v1.toLowerCase(); if(typeof v2==='string')v2=v2.toLowerCase(); return v1<v2 ? (plnDbSortAsc?-1:1) : (v1>v2 ? (plnDbSortAsc?1:-1) : 0); });
    const countEl = document.getElementById('pln-db-result-count'); if (countEl) countEl.innerText = f.length;
    const tbody = document.getElementById('pln-db-table-body'); if (!tbody) return;
    tbody.innerHTML = f.map(p => `
        <tr class="hover:bg-accent/50 transition-colors">
            <td class="p-3 font-mono">${p.system_id}</td><td>${p.system_name || 'Unknown'}</td><td class="p-3 font-medium text-foreground">#${p.planet_index}</td><td class="p-3 border-l border-border">${p.owner_name || 'Empty'}</td><td class="p-3 text-aw-warning">${p.alliance_tag ? `[${p.alliance_tag}]` : '-'}</td><td class="p-3 border-l border-border text-primary">${(p.population || 0).toLocaleString()}</td><td class="p-3 text-aw-warning">${p.starbase || 0}</td><td class="p-3 border-l border-border text-muted-foreground">${new Date(p.updated_at).toLocaleString()}</td>
        </tr>`).join('');
}

function renderFleetTable() {
    const input = document.getElementById('flt-db-search-input');
    const q = (input ? input.value : '').toLowerCase();
    let f = rawDbFleets.filter(f => (f.system_name && f.system_name.toLowerCase().includes(q)) || (f.owner_name && f.owner_name.toLowerCase().includes(q)));
    f.sort((a, b) => { let v1 = a[fltDbSortCol]||0, v2 = b[fltDbSortCol]||0; if(typeof v1==='string')v1=v1.toLowerCase(); if(typeof v2==='string')v2=v2.toLowerCase(); return v1<v2 ? (fltDbSortAsc?-1:1) : (v1>v2 ? (fltDbSortAsc?1:-1) : 0); });
    const countEl = document.getElementById('flt-db-result-count'); if (countEl) countEl.innerText = f.length;
    const tbody = document.getElementById('flt-db-table-body'); if (!tbody) return;
    tbody.innerHTML = f.map(f => `
        <tr class="hover:bg-accent/50 transition-colors">
            <td class="p-3">${f.system_name || 'Unknown'}</td><td class="p-3 font-medium text-foreground">#${f.planet_index}</td><td class="p-3 border-l border-border">${f.owner_name || 'Unknown'}</td><td class="p-3 text-aw-warning">${f.alliance_tag ? `[${f.alliance_tag}]` : '-'}</td><td class="p-3 border-l border-border text-gray-400">${f.transports || 0}</td><td class="p-3 text-gray-400">${f.colony_ships || 0}</td><td class="p-3 text-red-400 border-l border-border">${f.destroyers || 0}</td><td class="p-3 text-red-400">${f.cruisers || 0}</td><td class="p-3 text-red-400">${f.battleships || 0}</td><td class="p-3 text-aw-warning border-l border-border font-bold">${(f.cv || 0).toLocaleString()}</td><td class="p-3 border-l border-border ${f.arrival_time && f.arrival_time !== '-' ? 'text-red-400 font-bold' : 'text-muted-foreground'}">${f.arrival_time || 'Stationed'}</td>
        </tr>`).join('');
}

function renderAllyStatsTable() {
    let filtered = [...rawDbAllyStats];
    filtered.sort((a, b) => {
        let v1 = a[allyStatsSortCol] ?? 0, v2 = b[allyStatsSortCol] ?? 0;
        if (['science_rate', 'culture_rate', 'production_rate', 'astro_dollars', 'production_points'].includes(allyStatsSortCol)) {
            v1 = parseInt(v1.toString().replace(/[^\d-]/g, ''), 10) || 0;
            v2 = parseInt(v2.toString().replace(/[^\d-]/g, ''), 10) || 0;
        } else if (typeof v1 === 'string') { v1 = v1.toLowerCase(); v2 = v2.toLowerCase(); }
        return v1 < v2 ? (allyStatsSortAsc ? -1 : 1) : (v1 > v2 ? (allyStatsSortAsc ? 1 : -1) : 0);
    });

    const formatCultureCountdown = (isoStr) => {
        if (!isoStr) return '-';
        const msLeft = new Date(isoStr) - Date.now();
        if (msLeft <= 0) return 'Ready';
        const totalSecs = Math.floor(msLeft / 1000);
        return `${Math.floor(totalSecs / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m ${totalSecs % 60}s`;
    };

    const stLabel = document.getElementById('alliance-stats-last-updated');
    if (stLabel && filtered.length > 0) {
        const tms = filtered.map(s => s.updated_at ? new Date(s.updated_at.replace(' ', 'T') + 'Z').getTime() : 0).filter(t => !isNaN(t) && t > 0);
        if (tms.length > 0) {
            const diffMins = Math.floor((Date.now() - Math.max(...tms)) / 60000);
            stLabel.innerText = `Updated: ${diffMins < 1 ? 'Just now' : diffMins < 60 ? `${diffMins}m ago` : `${Math.floor(diffMins/60)}h ${diffMins%60}m ago`}`;
        }
    }

    const tbody = document.getElementById('ally-stats-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = filtered.map(s => `
        <tr class="hover:bg-accent/50 transition-colors border-b border-border/60">
            <td class="sticky left-0 z-10 bg-black px-2 py-1 font-medium text-foreground break-words leading-tight w-[110px] border-r border-zinc-800">${s.player_name || 'Unknown'}</td><td class="px-2 py-1 text-right text-muted-foreground">${s.player_id}</td><td class="px-2 py-1 text-aw-ally font-semibold">${s.planets_text || '-'}</td><td class="px-2 py-1 font-semibold text-yellow-500 whitespace-nowrap">${formatCultureCountdown(s.next_culture_at)}</td><td class="px-2 py-1 text-right text-blue-400 font-semibold">${s.science_rate || '-'}</td><td class="px-2 py-1 text-right text-purple-400 font-semibold">${s.culture_rate || '-'}</td><td class="px-2 py-1 text-right text-orange-400 font-semibold">${s.production_rate || '-'}</td><td class="px-2 py-1 text-right text-emerald-400">${s.astro_dollars || '-'}</td><td class="px-2 py-1 text-right text-slate-300">${s.production_points || '-'}</td><td class="px-2 py-1 text-pink-400 font-semibold">${s.artefact || 'None'}</td><td class="px-2 py-1 text-sky-400">${s.level_text || '-'}</td><td class="px-2 py-1 text-red-400">${s.cv_limit_text || '-'}</td><td class="px-2 py-1 text-right text-amber-500 font-bold">${s.economy}</td><td class="px-2 py-1 text-right text-cyan-400 font-bold">${s.energy}</td><td class="px-2 py-1 text-right text-indigo-400 font-bold">${s.mathematics}</td><td class="px-2 py-1 text-right text-violet-400 font-bold">${s.physics}</td><td class="px-2 py-1 text-right text-foreground font-bold bg-white/5">${s.population}</td>
        </tr>`).join('');
}

// ============================================================
// TRADE AGREEMENTS — collaborative board (propose / confirm / done)
// ============================================================

let taState = null;       // last fetched { me, isAdmin, maxTas, traders, members, agreements }
let taPlayerEcon = null;  // last fetched economics for the Schedule tab

const taShort = (name) => {
    const o = { shitmonkey: 'SM', mnhebi: 'Hebi', thedoctor797: 'Doc', theknife: 'Knif' };
    return o[name.toLowerCase()] || name.substring(0, 4);
};
// Compact A$ formatter: 1 234 567 -> "1.2M", 12 345 -> "12k", 0 -> "–".
const fmtAU = (n) => {
    n = Number(n) || 0;
    if (n <= 0) return '–';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(Math.round(n));
};
// A trade needs 20k A$ on hand. fmtReady(needed, rate) → compact time to accrue
// `needed` A$ at `rate` A$/h: "now" if already there, "–" if no income.
const TA_TRADE_COST = 20000;
const fmtReady = (needed, ratePerH) => {
    if (!ratePerH || ratePerH <= 0) return '–';
    if (needed <= 0) return 'now';
    const h = needed / ratePerH;
    if (h < 1) return Math.round(h * 60) + 'm';
    if (h < 24) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
    return (h / 24).toFixed(1) + 'd';
};
const taPairKey = (a, b) => [a.toLowerCase(), b.toLowerCase()].sort().join('|');
const taCount = (nameLower, agreements) =>
    agreements.filter(t => t.status !== 'cancelled' && t.pair_key.split('|').includes(nameLower)).length;

export async function openTradeAgreementsPanel() {
    let panel = document.getElementById('trade-agreements-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/trade-agreements.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('trade-agreements-panel');

        panel.querySelector('#btn-close-trade-agreements')?.addEventListener('click', () => panel.classList.replace('translate-x-0', 'translate-x-full'));
        panel.querySelector('#btn-refresh-ta')?.addEventListener('click', refreshTradeAgreements);
        panel.querySelector('#ta-tab-board')?.addEventListener('click', () => switchTaTab('board'));
        panel.querySelector('#ta-tab-schedule')?.addEventListener('click', () => switchTaTab('schedule'));
        panel.querySelector('#ta-admin-set')?.addEventListener('click', adminSetPair);
    }

    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('trade-agreements-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    switchTaTab('board');
    await loadTradeAgreements();
}

function switchTaTab(tab) {
    const boardBtn = document.getElementById('ta-tab-board');
    const schedBtn = document.getElementById('ta-tab-schedule');
    const boardView = document.getElementById('ta-view-board');
    const schedView = document.getElementById('ta-view-schedule');
    if (!boardBtn) return;
    const active = 'bg-white text-black', idle = 'bg-transparent text-muted-foreground hover:text-foreground';
    if (tab === 'schedule') {
        schedView.classList.remove('hidden'); boardView.classList.add('hidden');
        schedBtn.className = `h-9 px-4 text-sm font-medium ${active}`;
        boardBtn.className = `h-9 px-4 text-sm font-medium ${idle}`;
        runTradeSchedule();
    } else {
        boardView.classList.remove('hidden'); schedView.classList.add('hidden');
        boardBtn.className = `h-9 px-4 text-sm font-medium ${active}`;
        schedBtn.className = `h-9 px-4 text-sm font-medium ${idle}`;
    }
}

async function loadTradeAgreements() {
    try {
        const data = await (await fetch('/hub-api/trade-agreements')).json();
        if (!data.success) throw new Error(data.error || 'Failed');
        taState = data;
        const idLabel = document.getElementById('ta-identity');
        if (idLabel) idLabel.textContent = `You: ${data.me || '—'}${data.isAdmin ? ' (admin)' : ''}`;
        renderTaBoard();
    } catch (e) {
        const m = document.getElementById('ta-matrix');
        if (m) m.innerHTML = `<tr><td class="text-red-500 p-4">Failed to load trade agreements.</td></tr>`;
    }
}

// Refresh = re-scan the alliance page (like Alliance Stats): walk each member's
// page, read their Trade Partners table, sync the completed agreements, then reload.
async function refreshTradeAgreements() {
    const btn = document.getElementById('btn-refresh-ta');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Scanning alliance...'; }
    try {
        const doc = new DOMParser().parseFromString(await (await fetch('/Game/Alliance')).text(), 'text/html');
        const memberLinks = Array.from(doc.querySelectorAll('a[href*="/Game/Alliance/Member/"]'));
        const tradePairs = [];
        for (const link of memberLinks) {
            try {
                if (!/\/Member\/(\d+)/.test(link.href)) continue;
                const mDoc = new DOMParser().parseFromString(await (await fetch(link.href)).text(), 'text/html');
                const name = mDoc.querySelector('a[href*="/Game/Players/Profile/"]')?.innerText.trim();
                if (!name) continue;
                parseTradePartners(mDoc).forEach(partner => tradePairs.push([name, partner]));
            } catch (e) {}
        }
        if (tradePairs.length) {
            await fetch('/hub-api/sync/trade-partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs: tradePairs }) });
        }
    } catch (e) {
        if (typeof window.showToast === 'function') window.showToast('Alliance scan failed');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
    await loadTradeAgreements();
}

function taStatusFor(a, b) {
    if (!taState) return null;
    return taState.agreements.find(t => t.pair_key === taPairKey(a, b)) || null;
}

function renderTaBoard() {
    if (!taState) return;
    const { me, isAdmin, maxTas, traders, members, agreements } = taState;
    const meLower = (me || '').toLowerCase();
    const traderSet = new Set((traders || []).map(t => t.toLowerCase()));

    // --- Admin box ---
    const adminBox = document.getElementById('ta-admin-box');
    if (adminBox) {
        adminBox.classList.toggle('hidden', !isAdmin);
        if (isAdmin) {
            const opts = members.map(m => `<option value="${m.name}">${m.name}${m.isTrader ? ' (T)' : ''}</option>`).join('');
            const selA = document.getElementById('ta-admin-a'), selB = document.getElementById('ta-admin-b');
            if (selA && !selA.dataset.filled) { selA.innerHTML = opts; selB.innerHTML = opts; selA.dataset.filled = '1'; selB.dataset.filled = '1'; }
        }
    }

    // --- Confirmations awaiting me ---
    const confirmBox = document.getElementById('ta-confirm-box');
    const confirmList = document.getElementById('ta-confirm-list');
    const pendingForMe = agreements.filter(t =>
        t.status === 'proposed' &&
        t.pair_key.split('|').includes(meLower) &&
        (t.initiator || '').toLowerCase() !== meLower
    );
    if (confirmBox && confirmList) {
        confirmBox.classList.toggle('hidden', pendingForMe.length === 0);
        confirmList.innerHTML = pendingForMe.map(t => {
            const other = t.player_a.toLowerCase() === meLower ? t.player_b : t.player_a;
            return `<div class="flex items-center justify-between bg-zinc-950 border border-yellow-700/50 rounded-md px-3 py-2">
                <span class="text-sm text-foreground"><b>${other}</b> proposed a trade agreement with you</span>
                <span class="flex gap-2">
                    <button data-ta-confirm="${t.id}" class="h-8 px-3 rounded-md bg-green-700 hover:bg-green-600 text-white text-xs font-medium">Confirm</button>
                    <button data-ta-cancel="${t.id}" class="h-8 px-3 rounded-md border border-border hover:bg-secondary text-xs">Decline</button>
                </span>
            </div>`;
        }).join('');
        confirmList.querySelectorAll('[data-ta-confirm]').forEach(b => b.addEventListener('click', () => taAction(`/hub-api/trade-agreements/${b.dataset.taConfirm}/confirm`)));
        confirmList.querySelectorAll('[data-ta-cancel]').forEach(b => b.addEventListener('click', () => taAction(`/hub-api/trade-agreements/${b.dataset.taCancel}/cancel`)));
    }

    // --- Matrix ---
    const table = document.getElementById('ta-matrix');
    if (!table) return;
    let html = `<thead><tr>
        <th class="sticky left-0 bg-zinc-900 text-left px-2 py-1 text-muted-foreground border border-border/40">Member</th>
        <th class="bg-zinc-900 px-2 py-1 text-muted-foreground border border-border/40">TAs</th>`;
    members.forEach(p => {
        const t = p.isTrader ? 'text-yellow-400' : 'text-muted-foreground';
        html += `<th class="bg-zinc-900 px-1 py-1 border border-border/40 ${t}" title="${p.name}">${taShort(p.name)}</th>`;
    });
    // Trailing wealth columns: a spacer, then hoarded A$ and visible A$ (+PP).
    html += `<th class="bg-black border-0" style="min-width:14px"></th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-amber-400 border border-border/40" title="A$ value of artifacts + supply units this member is holding">Hoard A$</th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-emerald-400 border border-border/40" title="Visible liquidity: Astro Dollars + Production Points valued in A$">A$+PP</th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-sky-400 border border-border/40" title="Time to reach ${TA_TRADE_COST.toLocaleString()} A$ at current income (Production/h × PP price). Second value: time if the hoard is sold now.">Ready in</th>`;
    html += `</tr></thead><tbody>`;

    members.forEach(p1 => {
        const c1 = taCount(p1.name.toLowerCase(), agreements);
        const full1 = c1 >= maxTas;
        html += `<tr>
            <td class="sticky left-0 bg-black px-2 py-1 font-semibold text-foreground border border-border/40 whitespace-nowrap">${p1.name}${p1.isTrader ? ' <span class="text-yellow-400">T</span>' : ''}</td>
            <td class="px-2 py-1 text-center border border-border/40 ${full1 ? 'text-green-400 font-bold' : 'text-muted-foreground'}">${c1}/${maxTas}</td>`;
        members.forEach(p2 => {
            html += taCell(p1, p2, { me: meLower, isAdmin, maxTas, traderSet, agreements, full1 });
        });
        html += `<td class="bg-black border-0"></td>`;
        html += `<td class="px-2 py-1 text-right border border-border/40 text-amber-400 font-semibold" title="${(p1.hoarded_au || 0).toLocaleString()} A$">${fmtAU(p1.hoarded_au)}</td>`;
        html += `<td class="px-2 py-1 text-right border border-border/40 text-emerald-400" title="${(p1.visible_au || 0).toLocaleString()} A$">${fmtAU(p1.visible_au)}</td>`;
        // Ready in: time to reach 20k from visible liquidity, then (muted) the same if the hoard is sold now.
        const t1 = fmtReady(TA_TRADE_COST - (p1.visible_au || 0), p1.au_per_h);
        const t2 = fmtReady(TA_TRADE_COST - (p1.visible_au || 0) - (p1.hoarded_au || 0), p1.au_per_h);
        const readyTitle = `${(p1.au_per_h || 0).toLocaleString()} A$/h · need ${Math.max(0, TA_TRADE_COST - (p1.visible_au || 0)).toLocaleString()} A$ (${Math.max(0, TA_TRADE_COST - (p1.visible_au || 0) - (p1.hoarded_au || 0)).toLocaleString()} A$ if hoard sold)`;
        html += `<td class="px-2 py-1 text-right border border-border/40 text-sky-400 whitespace-nowrap" title="${readyTitle}">${t1}<span class="text-muted-foreground"> / ${t2}</span></td>`;
        html += `</tr>`;
    });
    html += `</tbody>`;
    table.innerHTML = html;

    table.querySelectorAll('[data-ta-pair]').forEach(btn => {
        btn.addEventListener('click', () => onTaCellClick(btn.dataset.taA, btn.dataset.taB));
    });
}

function taCell(p1, p2, ctx) {
    const cls = 'border border-border/40 text-center';
    if (p1.name.toLowerCase() === p2.name.toLowerCase()) return `<td class="${cls}" style="background:#0a0a0a"></td>`;
    if (p1.isTrader && p2.isTrader) return `<td class="${cls}" style="background:#3f0a0a" title="Traders can't trade with traders"><i class="fa-solid fa-ban text-red-500/70"></i></td>`;

    const ta = ctx.agreements.find(t => t.pair_key === taPairKey(p1.name, p2.name));
    const meInPair = [p1.name.toLowerCase(), p2.name.toLowerCase()].includes(ctx.me);
    const canAct = ctx.isAdmin || meInPair;

    if (ta) {
        let bg = '#a16207', label = 'P', title = `Proposed by ${ta.initiator}`;
        if (ta.status === 'confirmed') { bg = '#15803d'; label = '✓'; title = 'Confirmed' + (ta.is_admin_set ? ' (admin)' : ''); }
        else if (ta.status === 'done') { bg = '#1d4ed8'; label = '★'; title = 'Done'; }
        const clickable = canAct && ta.status !== 'done';
        return `<td class="${cls}"><button ${clickable ? `data-ta-pair="1" data-ta-a="${p1.name}" data-ta-b="${p2.name}"` : 'disabled'} title="${title}${clickable ? ' — click to remove' : ''}" style="width:100%;min-height:28px;border:none;background:${bg};color:#fff;font-weight:bold;cursor:${clickable ? 'pointer' : 'default'}">${label}</button></td>`;
    }

    // empty cell
    const p2Full = taCount(p2.name.toLowerCase(), ctx.agreements) >= ctx.maxTas;
    const blocked = ctx.full1 || p2Full;
    if (canAct && !blocked) {
        return `<td class="${cls}"><button data-ta-pair="1" data-ta-a="${p1.name}" data-ta-b="${p2.name}" title="${ctx.isAdmin && !( [p1.name.toLowerCase(),p2.name.toLowerCase()].includes(ctx.me)) ? 'Set pairing (admin)' : 'Propose'}" style="width:100%;min-height:28px;border:none;background:transparent;color:#555;font-weight:bold;cursor:pointer">+</button></td>`;
    }
    return `<td class="${cls}" style="background:#0d0d0d"></td>`;
}

async function onTaCellClick(aName, bName) {
    if (!taState) return;
    const ta = taStatusFor(aName, bName);
    const meLower = (taState.me || '').toLowerCase();

    if (ta) {
        if (!confirm(`Remove the agreement between ${aName} and ${bName}?`)) return;
        return taAction(`/hub-api/trade-agreements/${ta.id}/cancel`);
    }

    // No existing pairing → create.
    const involvesMe = [aName.toLowerCase(), bName.toLowerCase()].includes(meLower);
    if (taState.isAdmin && !involvesMe) {
        return taAction('/hub-api/admin/trade-agreements', { player_a: aName, player_b: bName });
    }
    // Propose: partner is whichever side isn't me.
    const partner = aName.toLowerCase() === meLower ? bName : aName;
    return taAction('/hub-api/trade-agreements/propose', { partner });
}

async function taAction(url, body) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        const data = await res.json();
        if (!data.success) {
            if (typeof window.showToast === 'function') window.showToast(data.error || 'Action failed');
            return;
        }
        await loadTradeAgreements();
    } catch (e) {
        if (typeof window.showToast === 'function') window.showToast('Network error');
    }
}

async function adminSetPair() {
    const a = document.getElementById('ta-admin-a')?.value;
    const b = document.getElementById('ta-admin-b')?.value;
    const status = document.getElementById('ta-admin-status');
    if (!a || !b) return;
    try {
        const res = await fetch('/hub-api/admin/trade-agreements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_a: a, player_b: b })
        });
        const data = await res.json();
        if (status) {
            status.textContent = data.success ? '✅ Set.' : '❌ ' + (data.error || 'Failed');
            status.className = data.success ? 'text-xs text-green-400' : 'text-xs text-red-400';
        }
        if (data.success) await loadTradeAgreements();
    } catch (e) {}
}

// ---------- Schedule tab (execution order for confirmed agreements) ----------
async function runTradeSchedule() {
    const body = document.getElementById('ta-results-body');
    if (body) body.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Calculating…</td></tr>';

    try {
        const [econRes, taRes] = await Promise.all([
            fetch('/hub-api/intel/trade-analysis'),
            fetch('/hub-api/trade-agreements')
        ]);
        const econ = await econRes.json();
        const ta = await taRes.json();
        if (!econ.success || !ta.success) throw new Error('load failed');
        taPlayerEcon = econ;

        const ppLabel = document.getElementById('ta-pp-price');
        if (ppLabel) ppLabel.textContent = `PP price: ${econ.pp_price ? '$' + econ.pp_price : 'not scanned'}`;

        // Plan = confirmed agreements not yet done.
        const pairs = ta.agreements
            .filter(t => t.status === 'confirmed')
            .map(t => [t.player_a, t.player_b]);
        const traders = (ta.traders || []);

        computeAndRenderTradeSchedule(econ.players || [], econ.pp_price || 0, { cost: 20000, traders, pairs });
    } catch (e) {
        if (body) body.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-red-500">Failed to load schedule data.</td></tr>`;
    }
}

function formatTaHours(totalHours) {
    if (totalHours <= 0.001) return 'Instant';
    const d = Math.floor(totalHours / 24);
    const h = Math.floor(totalHours % 24);
    return d > 0 ? `+${d}d ${h}h` : `+${h}h`;
}

function computeAndRenderTradeSchedule(globalPlayers, ppPrice, config) {
    const COST_NORMAL = config.cost || 20000;
    const TRADERS = (config.traders || []).map(t => t.toLowerCase());
    const TRADER_RANKS = {};
    (config.traders || []).forEach((t, i) => { TRADER_RANKS[t.toLowerCase()] = i + 1; });
    const MASTER_PAIRS = config.pairs || [];

    const getTraderRank = (a, b) => Math.min(TRADER_RANKS[a.toLowerCase()] || 99, TRADER_RANKS[b.toLowerCase()] || 99);
    const isPlayerPending = (name, pending) => { const n = name.toLowerCase(); return pending.some(p => p[0].toLowerCase() === n || p[1].toLowerCase() === n); };
    const hasPendingTrader = (name, pending) => { const n = name.toLowerCase(); return pending.some(p => (p[0].toLowerCase() === n && TRADERS.includes(p[1].toLowerCase())) || (p[1].toLowerCase() === n && TRADERS.includes(p[0].toLowerCase()))); };

    const playersMap = {}, foundPlayers = new Set();
    globalPlayers.forEach(p => {
        const isTrader = TRADERS.includes(p.name.toLowerCase());
        playersMap[p.name.toLowerCase()] = {
            name: p.name, base_prod: p.production_rate || 0,
            ta_cost: isTrader ? 0 : COST_NORMAL,
            saved: (p.astro_dollars || 0) + (p.production_points || 0) * ppPrice
        };
        foundPlayers.add(p.name.toLowerCase());
    });

    let pending = MASTER_PAIRS.slice();
    const missingPlayers = new Set();
    pending.forEach(pair => {
        if (!foundPlayers.has(pair[0].toLowerCase())) missingPlayers.add(pair[0]);
        if (!foundPlayers.has(pair[1].toLowerCase())) missingPlayers.add(pair[1]);
    });

    const schedule = [];
    let currentTime = 0, guard = 0;
    while (pending.length > 0 && guard < 1000) {
        guard++;
        const candidates = pending.filter(pair => {
            const isTraderTrade = TRADERS.includes(pair[0].toLowerCase()) || TRADERS.includes(pair[1].toLowerCase());
            if (isTraderTrade) return true;
            return !hasPendingTrader(pair[0], pending) && !hasPendingTrader(pair[1], pending);
        });
        let bestPair = null, minTime = Infinity, bestRank = 99, bestIsTrader = false;
        for (const pair of candidates) {
            const p1 = playersMap[pair[0].toLowerCase()], p2 = playersMap[pair[1].toLowerCase()];
            if (!p1 || !p2) continue;
            const t1 = p1.saved < p1.ta_cost ? (p1.ta_cost - p1.saved) / (p1.base_prod || 1e-9) : 0;
            const t2 = p2.saved < p2.ta_cost ? (p2.ta_cost - p2.saved) / (p2.base_prod || 1e-9) : 0;
            const time = Math.max(t1, t2);
            const rank = getTraderRank(p1.name, p2.name);
            const itp = TRADERS.includes(p1.name.toLowerCase()) || TRADERS.includes(p2.name.toLowerCase());
            if (time < minTime - 1e-4) { minTime = time; bestPair = pair; bestRank = rank; bestIsTrader = itp; }
            else if (Math.abs(time - minTime) <= 1e-4 && rank < bestRank) { minTime = time; bestPair = pair; bestRank = rank; bestIsTrader = itp; }
        }
        if (!bestPair) break;
        const dt = minTime; currentTime += dt;
        for (const pn in playersMap) if (isPlayerPending(pn, pending)) playersMap[pn].saved += playersMap[pn].base_prod * dt;
        const e1 = playersMap[bestPair[0].toLowerCase()], e2 = playersMap[bestPair[1].toLowerCase()];
        e1.saved -= e1.ta_cost; e2.saved -= e2.ta_cost;
        const idx = pending.findIndex(p => p[0] === bestPair[0] && p[1] === bestPair[1]);
        if (idx > -1) pending.splice(idx, 1);
        schedule.push({ time: currentTime, p1: e1.name, p2: e2.name, is_trader: bestIsTrader });
    }

    const sumTime = document.getElementById('ta-sum-time'), sumTrades = document.getElementById('ta-sum-trades');
    if (sumTime) sumTime.innerText = formatTaHours(currentTime);
    if (sumTrades) sumTrades.innerText = schedule.length;

    const tbody = document.getElementById('ta-results-body');
    if (!tbody) return;
    if (schedule.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-green-400">No confirmed agreements pending execution.</td></tr>`;
        return;
    }
    const cell = (item, index) => {
        if (!item) return '<td></td><td></td>';
        let pair = `<span>${item.p1}</span> <i class="fa-solid fa-right-left text-muted-foreground mx-2"></i> <span>${item.p2}</span>`;
        if (item.is_trader) pair = `<span class="text-yellow-400 font-bold">${pair}</span>`;
        return `<td class="p-3 text-muted-foreground font-mono">${index + 1}</td><td class="p-3 font-medium text-foreground">${pair} <span class="text-xs text-muted-foreground ml-1">(${formatTaHours(item.time)})</span></td>`;
    };
    let rows = '';
    for (let i = 0; i < schedule.length; i += 2) rows += `<tr class="hover:bg-accent/40">${cell(schedule[i], i)}${cell(schedule[i + 1], i + 1)}</tr>`;
    let footer = '';
    if (missingPlayers.size > 0) footer = `<tr><td colspan="4" class="text-center py-2 text-aw-warning bg-yellow-950/30 text-xs">⚠️ No alliance-stats data for: ${Array.from(missingPlayers).join(', ')}</td></tr>`;
    tbody.innerHTML = rows + footer;
}
