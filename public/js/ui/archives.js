// public/js/ui/archives.js
let rawDbPlayers = [], dbSortCol = 'points', dbSortAsc = false;
let rawDbSystems = [], sysDbSortCol = 'id', sysDbSortAsc = true;
let rawDbPlanets = [], plnDbSortCol = 'system_id', plnDbSortAsc = true;
let rawDbFleets = [], fltDbSortCol = 'cv', fltDbSortAsc = false;
let rawDbAllyStats = [], allyStatsSortCol = 'player_id', allyStatsSortAsc = true;

function closeOtherPanels(exceptId) {
    ['database-panel', 'system-database-panel', 'planet-database-panel', 'fleet-database-panel', 'alliance-stats-panel', 'enemy-intel-panel'].forEach(id => {
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
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('database-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
    
    document.getElementById('db-table-body').innerHTML = '<tr><td colspan="16" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Intelligence...</td></tr>';
    try {
        const res = await fetch('/hub-api/intel/players');
        const data = await res.json();
        if (data.success) { rawDbPlayers = data.players; renderPlayerTable(); }
    } catch (err) { document.getElementById('db-table-body').innerHTML = '<tr><td colspan="16" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
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
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
    
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
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
    
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
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
    
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

        // Saugus mygtukų pririšimas
        panel.querySelector('#close-war-room-btn')?.addEventListener('click', () => {
            panel.classList.replace('translate-x-0', 'translate-x-full');
        });

        panel.querySelector('#btn-refresh-enemy-intel')?.addEventListener('click', refreshActiveWarAlliance);

        // Rikivimo antraščių pririšimas
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
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
    
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
    loadWarRoomAlliancesList(); // Refresh pill selections state highlights
}

async function loadWarRoomMatrixData() {
    if (!selectedAllianceId) return;
    const tbody = document.getElementById('enemy-intel-table-body');
    tbody.innerHTML = `<tr><td colspan="13" class="text-center py-6 font-mono text-zinc-400"><i class="fa-solid fa-spinner fa-spin me-2 text-red-500"></i> Decrypting intelligence matrices from DB indexes...</td></tr>`;

    try {
        const res = await fetch(`/hub-api/intel/war-room/players?alliance_id=${selectedAllianceId}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        warRoomData = data.players.map(p => {
            const factories = p.total_factories || 0;
            const pop = p.total_population || 0;
            const eco = p.economy || 0;
            const social = p.social || 0;

            const estimatedProd = (factories + pop) * 2.5;
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
        tbody.innerHTML = `<tr><td colspan="13" class="text-center py-6 text-red-500 font-bold">API Sync Failure Exception Event: ${err.message}</td></tr>`;
    }
}

function renderWarRoomTable(data) {
    const tbody = document.getElementById('enemy-intel-table-body');
    tbody.innerHTML = '';

    if(data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" class="text-center py-6 text-zinc-500">No scanned player rows mapped to this target index loop</td></tr>`;
        return;
    }

    data.forEach(p => {
        const isUnknown = !p.economy || p.economy === 0;
        let idleStyle = "color: #a1a1aa;"; 
        if (p.idle_seconds >= 0) {
            const idleMins = p.idle_seconds / 60;
            const cappedMins = Math.min(idleMins, 360); 
            const hue = 120 - (cappedMins / 360) * 120;
            idleStyle = `background-color: hsla(${hue}, 75%, 12%, 0.45); color: hsl(${hue}, 90%, 65%); border: 1px solid hsla(${hue}, 75%, 25%, 0.3);`;
        }

        const tr = document.createElement('tr');
        tr.className = "hover:bg-zinc-900/40 transition-colors border-b border-zinc-900/60";
        tr.innerHTML = `
            <td class="p-3 font-bold text-foreground"><span class="text-red-500 font-extrabold mr-1">[${p.alliance_tag}]</span> <a href="/Game/Players/Profile/${p.id}" target="_blank" class="hover:underline hover:text-red-400">${p.name}</a></td>
            <td class="p-3 text-zinc-300">${isUnknown ? '<span class="text-zinc-600 font-bold">?</span>' : p.economy}</td>
            <td class="p-3 text-emerald-400 font-bold">${Math.round(p.calculated_prod).toLocaleString()}</td>
            <td class="p-3 text-amber-400 font-bold">${isUnknown ? '<span class="text-zinc-600 font-bold">?</span>' : p.cv_day.toLocaleString()}</td>
            <td class="p-3 text-cyan-400">${isUnknown ? '<span class="text-zinc-600 font-bold">?</span>' : p.max_cv.toLocaleString()}</td>
            <td class="p-3">${formatRaceModifier(p.race_attack, isUnknown)}</td><td class="p-3">${formatWarRoomModifier(p.race_defense, isUnknown)}</td><td class="p-3">${formatRaceModifier(p.race_speed, isUnknown)}</td>
            <td class="p-3 text-zinc-300">${isUnknown ? '<span class="text-zinc-600 font-bold">?</span>' : (p.physics || 0)}</td>
            <td class="p-3 text-zinc-300">${isUnknown ? '<span class="text-zinc-600 font-bold">?</span>' : (p.mathematics || 0)}</td>
            <td class="p-3 text-zinc-300">${isUnknown ? '<span class="text-zinc-600 font-bold">?</span>' : (p.energy || 0)}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-mono tracking-wide" style="${idleStyle}">${p.idle_time || 'Unknown'}</span></td>
            <td class="p-3 text-zinc-400 font-bold">${p.total_planets || 0} assets</td>
        `;
        tbody.appendChild(tr);
    });
}

// Fixed function name to match the caller inside render loop
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

async function refreshActiveWarAlliance() {
    if (!selectedAllianceId) return;
    const btn = document.getElementById('btn-refresh-enemy-intel');
    const icon = document.getElementById('icon-refresh-enemy-intel');
    btn.setAttribute('disabled', 'true');
    icon.classList.add('fa-spin');

    // Jeigu iškviesime mass scanner API, kai turėsime šią logiką.
    await loadWarRoomMatrixData();
    
    btn.removeAttribute('disabled');
    icon.classList.remove('fa-spin');
}

export async function openAllianceStatsPanel() {
    let panel = document.getElementById('alliance-stats-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/alliance-stats.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('alliance-stats-panel');
        convertLegacyClickAttributes(panel, 'ally');
        
        // Paimame "Update all" mygtuką ir priskiriame švarų Listenerį
        const updateBtn = document.getElementById('btn-update-alliance-stats');
        if (updateBtn) {
            updateBtn.removeAttribute('onclick');
            updateBtn.addEventListener('click', triggerAllianceStatsUpdate);
        }
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('alliance-stats-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebarInternal === 'function') window.toggleSidebarInternal();
    
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

export async function triggerAllianceStatsUpdate() {
    const btn = document.getElementById('btn-update-alliance-stats');
    const icon = document.getElementById('icon-update-alliance-stats');
    if (btn) btn.disabled = true;
    if (icon) icon.className = 'fa-solid fa-circle-notch fa-spin';
    
    if (typeof window.showToast === 'function') window.showToast('Siunčiamas alianso narių sąrašas...');
    try {
        const res = await fetch('/Game/Alliance');
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const memberLinks = Array.from(doc.querySelectorAll('a[href*="/Game/Alliance/Member/"]'));
        if (memberLinks.length === 0) {
            if (typeof window.showToast === 'function') window.showToast('Narių nerasta');
            return;
        }

        if (typeof window.showToast === 'function') window.showToast(`Atnaujinami ${memberLinks.length} narių duomenys...`);
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

// --- RENDER (TABLE DRAWING) FUNCTIONS ---
function renderPlayerTable() {
    const input = document.getElementById('db-search-input');
    const q = (input ? input.value : '').toLowerCase();
    let f = rawDbPlayers.filter(p => (p.name && p.name.toLowerCase().includes(q)) || (p.id && p.id.toString().includes(q)) || (p.alliance_tag && p.alliance_tag.toLowerCase().includes(q)));
    f.sort((a, b) => { let v1 = a[dbSortCol]||0, v2 = b[dbSortCol]||0; if(typeof v1==='string')v1=v1.toLowerCase(); if(typeof v2==='string')v2=v2.toLowerCase(); return v1<v2 ? (dbSortAsc?-1:1) : (v1>v2 ? (dbSortAsc?1:-1) : 0); });
    const countEl = document.getElementById('db-result-count'); if (countEl) countEl.innerText = f.length;
    const tbody = document.getElementById('db-table-body'); if (!tbody) return;
    tbody.innerHTML = f.map(p => `
        <tr class="hover:bg-accent/50 transition-colors">
            <td class="p-3 font-mono">${p.id}</td><td class="p-3 font-medium text-foreground">${p.name || 'Unknown'}</td><td class="p-3 text-aw-warning">${p.alliance_tag ? `[${p.alliance_tag}]` : '-'}</td><td>${p.level}</td><td class="p-3 text-primary font-medium">${(p.points || 0).toLocaleString()}</td><td class="p-3 border-l border-border">${p.planet_count || 0}</td><td class="p-3 ${p.idle_time && p.idle_time.includes('Online') ? 'text-green-400' : ''}">${p.idle_time || '-'}</td><td class="p-3 border-l border-border">${p.artefact || '-'}</td><td class="p-3 text-primary">${(p.trade_revenue || 0).toLocaleString()}</td><td class="p-3 text-blue-400 border-l border-border">${p.physics}</td><td class="p-3 text-green-400">${p.biology}</td><td class="p-3 text-yellow-400">${p.economy}</td><td class="p-3 text-purple-400">${p.energy}</td><td class="p-3 text-orange-400">${p.mathematics}</td><td class="p-3 text-pink-400 border-r border-border">${p.social}</td><td class="p-3 text-muted-foreground">${new Date(p.updated_at).toLocaleString()}</td>
        </tr>`).join('');
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
            <td class="p-3 text-muted-foreground font-mono">${s.player_id}</td><td class="p-3 font-medium text-foreground">${s.player_name || 'Unknown'}</td><td class="p-3 text-aw-ally font-semibold">${s.planets_text || '-'}</td><td class="p-3 font-semibold text-yellow-500">${formatCultureCountdown(s.next_culture_at)}</td><td class="p-3 text-blue-400 font-semibold">${s.science_rate || '-'}</td><td class="p-3 text-purple-400 font-semibold">${s.culture_rate || '-'}</td><td class="p-3 text-orange-400 font-semibold">${s.production_rate || '-'}</td><td class="p-3 text-emerald-400">${s.astro_dollars || '-'}</td><td class="p-3 text-slate-300">${s.production_points || '-'}</td><td class="p-3 text-pink-400 font-semibold">${s.artefact || 'None'}</td><td class="p-3 text-sky-400">${s.level_text || '-'}</td><td class="p-3 text-red-400">${s.cv_limit_text || '-'}</td><td class="p-3 text-amber-500 font-bold">${s.economy}</td><td class="p-3 text-cyan-400 font-bold">${s.energy}</td><td class="p-3 text-indigo-400 font-bold">${s.mathematics}</td><td class="p-3 text-violet-400 font-bold">${s.physics}</td><td class="p-3 text-foreground font-bold bg-white/5">${s.population}</td>
        </tr>`).join('');
}