// public/js/ui/archives.js
import { esc } from '../utils/escape.js';
import { navToIframe } from './search.js';
// The three player-stats tables (players archive, war room, alliance stats) are column-
// driven: header, rows, sort and the column picker all come from one definition per column.
import { STAT_TABLES, renderHeaderCells, renderRowCells, sortRows, enrichWarRoomRow, parseSqliteUtc } from './stat-columns.js';
import { mountColumnPicker } from './column-picker.js';
import '../utils/battle-model.js';   // side-effect import: cvOf, so CV is defined once
import '../utils/parse-number.js';   // side-effect import: locale-aware sorting
import '../utils/sqlite-time.js';    // side-effect import: puts the model on globalThis
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const { cvOf } = globalThis.AWBattleModel;
const { formatSqliteUtc } = globalThis.AWSqliteTime;

let rawDbPlayers = [];
const playerSort = { col: 'points', asc: false };
let rawDbSystems = [], sysDbSortCol = 'id', sysDbSortAsc = true;
let rawDbPlanets = [], plnDbSortCol = 'system_id', plnDbSortAsc = true;
let rawDbFleets = [], fltDbSortCol = 'cv', fltDbSortAsc = false;
let rawDbAllyStats = [];
const allySort = { col: 'player_id', asc: true };

function toggleSort(state, key, defaultAsc) {
    if (state.col === key) state.asc = !state.asc;
    else { state.col = key; state.asc = defaultAsc; }
}

// Wire a column-driven table: paint the header from the definitions, sort on header click,
// mount the column picker. `render` repaints the body from the current sort state.
function wireStatTable({ panel, table, headRowId, pickerMountId, tableId, tableKey, sortState, defaultAsc, render }) {
    const headRow = panel.querySelector(`#${headRowId}`);
    const paintHead = () => {
        if (headRow) headRow.innerHTML = renderHeaderCells(table.columns, { sortCol: sortState.col, sortAsc: sortState.asc, headBase: table.headBase });
    };
    headRow?.addEventListener('click', e => {
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        const column = table.columns.find(c => c.key === th.dataset.col);
        if (!column) return;
        toggleSort(sortState, column.key, defaultAsc(column));
        paintHead();
        render();
    });
    paintHead();
    mountColumnPicker({ mountEl: panel.querySelector(`#${pickerMountId}`), tableId, tableKey, columns: table.columns });
    return paintHead;
}

const rowsHtml = (table, rows, rowCls) =>
    rows.map(r => `<tr class="${rowCls}">${renderRowCells(table.columns, r, table.cellBase)}</tr>`).join('');

function closeOtherPanels(exceptId) {
    ['database-panel', 'system-database-panel', 'planet-database-panel', 'fleet-database-panel', 'alliance-stats-panel', 'enemy-intel-panel', 'trade-agreements-panel', 'battle-calc-panel', 'travel-calc-panel', 'route-planner-panel', 'galaxy-map-panel', 'build-order-panel', 'empire-sim-panel', 'battle-reports-panel'].forEach(id => {
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
                if (panelContextType === 'player') { toggleSort(playerSort, columnField, false); renderPlayerTable(); }
                if (panelContextType === 'system') { if (sysDbSortCol === columnField) sysDbSortAsc = !sysDbSortAsc; else { sysDbSortCol = columnField; sysDbSortAsc = true; } renderSystemTable(); }
                if (panelContextType === 'planet') { if (plnDbSortCol === columnField) plnDbSortAsc = !plnDbSortAsc; else { plnDbSortCol = columnField; plnDbSortAsc = true; } renderPlanetTable(); }
                if (panelContextType === 'fleet') { if (fltDbSortCol === columnField) fltDbSortAsc = !fltDbSortAsc; else { fltDbSortCol = columnField; fltDbSortAsc = false; } renderFleetTable(); }
                if (panelContextType === 'ally') { toggleSort(allySort, columnField, true); renderAllyStatsTable(); }
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
        // A new column always sorts descending first, as this table has always done.
        wireStatTable({ panel, table: STAT_TABLES.players, headRowId: 'players-db-head-row', pickerMountId: 'players-db-columns', tableId: 'playersDbTable', tableKey: 'players', sortState: playerSort, defaultAsc: () => false, render: renderPlayerTable });
        panel.querySelector('#db-search-input')?.addEventListener('input', renderPlayerTable);
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('database-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    document.getElementById('db-table-body').innerHTML = '<tr><td colspan="99" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Intelligence...</td></tr>';
    try {
        const res = await fetch('/hub-api/intel/players');
        const data = await res.json();
        if (data.success) { rawDbPlayers = data.players; renderPlayerTable(); }
    } catch (err) { document.getElementById('db-table-body').innerHTML = '<tr><td colspan="99" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
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
            rawDbFleets = data.fleets.map(f => ({ ...f, cv: cvOf(f) }));
            renderFleetTable(); 
        }
    } catch (err) { document.getElementById('flt-db-table-body').innerHTML = '<tr><td colspan="11" class="text-center py-8 text-red-500">Failed to load data.</td></tr>'; }
}

// --- WAR ROOM (ENEMY INTEL) LOGIKA ---
let warRoomData = [];
const warRoomSort = { col: null, asc: false };   // null = the order the server returned
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

        // Text columns sort A-Z first, numbers largest-first — as this table always has.
        wireStatTable({ panel, table: STAT_TABLES.warRoom, headRowId: 'war-room-head-row', pickerMountId: 'war-room-columns', tableId: 'warIntelTable', tableKey: 'warRoom', sortState: warRoomSort, defaultAsc: c => c.sort === 'string', render: renderWarRoomTable });
    }

    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('enemy-intel-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    
    loadWarRoomAlliancesList();
}

// parseSqliteUtc, the idle helpers and formatRaceModifier moved to stat-columns.js, where
// the column definitions that use them live.

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
            btn.innerHTML = `<span>[${esc(a.tag)}]</span><span class="px-1 py-0.25 bg-black/40 rounded text-[10px] md:text-xs text-muted-foreground border border-white/5">${a.active_members_count}</span>`;
            pillsBox.appendChild(btn);
        });
    } catch (err) {}
}

function selectWarRoomAlliance(allianceId, tag, lastScanTime) {
    selectedAllianceId = allianceId;
    document.getElementById('btn-refresh-enemy-intel').removeAttribute('disabled');
    
    const d = parseSqliteUtc(lastScanTime);
    if (d) {
        document.getElementById('enemy-intel-last-scanned').innerText = `Last Scanned: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
    } else {
        document.getElementById('enemy-intel-last-scanned').innerText = 'Last Scanned: N/A';
    }

    loadWarRoomMatrixData();
    loadWarRoomAlliancesList();
}

async function loadWarRoomMatrixData() {
    if (!selectedAllianceId) return;
    const tbody = document.getElementById('enemy-intel-table-body');
    tbody.innerHTML = `<tr><td colspan="99" class="text-center py-6 font-mono text-zinc-400"><i class="fa-solid fa-spinner fa-spin me-2 text-red-500"></i> Decrypting intelligence matrices from DB indexes...</td></tr>`;

    try {
        const res = await fetch(`/hub-api/intel/war-room/players?alliance_id=${selectedAllianceId}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        // ~Prod/h, ~CV/Day, Max CV, ~Sci/h and the idle reading are derived in
        // stat-columns.js (enrichWarRoomRow), next to the columns that display them.
        warRoomData = data.players.map(p => enrichWarRoomRow(p));
        renderWarRoomTable();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="99" class="text-center py-6 text-red-500 font-bold">API Sync Failure Exception Event: ${esc(err.message)}</td></tr>`;
    }
}

function renderWarRoomTable() {
    const tbody = document.getElementById('enemy-intel-table-body');
    if (!tbody) return;
    if (warRoomData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="99" class="text-center py-6 text-zinc-500">No scanned player rows mapped to this target index loop</td></tr>`;
        return;
    }
    const table = STAT_TABLES.warRoom;
    const rows = warRoomSort.col ? sortRows(warRoomData, table.columns, warRoomSort.col, warRoomSort.asc) : warRoomData;
    tbody.innerHTML = rowsHtml(table, rows, 'hover:bg-zinc-900/40 transition-colors border-b border-zinc-900/60');
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
        const res = await gameFetch(`/Game/Alliance/Profile/${selectedAllianceId}`);
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
        // A new column always sorts ascending first, as this table has always done.
        wireStatTable({ panel, table: STAT_TABLES.allyStats, headRowId: 'ally-stats-head-row', pickerMountId: 'ally-stats-columns', tableId: 'allyStatsTable', tableKey: 'allyStats', sortState: allySort, defaultAsc: () => true, render: renderAllyStatsTable });

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

    document.getElementById('ally-stats-table-body').innerHTML = '<tr><td colspan="99" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Reading Alliance Records...</td></tr>';
    await refreshAllianceStatsData();
}

export async function refreshAllianceStatsData() {
    try {
        const res = await fetch('/hub-api/intel/alliance-stats');
        const data = await res.json();
        if (data.success) { rawDbAllyStats = data.stats; renderAllyStatsTable(); }
    } catch (err) {}
}

// Search/sort state for the panel — module-level since only one instance of this panel
// ever exists at a time (see the singleton `panel` lookup in openBattleReportsPanel).
const battleReportsState = { q: '', sort: 'occurred_at', dir: 'desc' };
let battleReportsSearchTimer = null;

export async function openBattleReportsPanel() {
    let panel = document.getElementById('battle-reports-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/battle-reports.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('battle-reports-panel');
        document.getElementById('battle-reports-close-btn')?.addEventListener('click', () => {
            panel.classList.replace('translate-x-0', 'translate-x-full');
        });
        // Debounced — this hits the server (it searches the whole history, not just what's
        // currently on screen), unlike the other panels' instant client-side filters.
        panel.querySelector('#battle-reports-search-input')?.addEventListener('input', (e) => {
            battleReportsState.q = e.target.value;
            clearTimeout(battleReportsSearchTimer);
            battleReportsSearchTimer = setTimeout(loadBattleReportsTable, 300);
        });
        panel.querySelectorAll('[data-sort-key]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.getAttribute('data-sort-key');
                if (battleReportsState.sort === key) {
                    battleReportsState.dir = battleReportsState.dir === 'desc' ? 'asc' : 'desc';
                } else {
                    battleReportsState.sort = key;
                    battleReportsState.dir = 'desc';
                }
                loadBattleReportsTable();
            });
        });
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('battle-reports-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    await loadBattleReportsTable();
}

async function loadBattleReportsTable() {
    updateSortArrows();
    document.getElementById('battle-reports-table-body').innerHTML = '<tr><td colspan="7" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading battle reports...</td></tr>';
    try {
        const params = new URLSearchParams({ q: battleReportsState.q, sort: battleReportsState.sort, dir: battleReportsState.dir, limit: '150' });
        const res = await fetch(`/hub-api/intel/battle-reports-search?${params}`);
        const data = await res.json();
        if (data.success) renderBattleReportsTable(data.feed, data.total);
        else throw new Error(data.error || 'unknown error');
    } catch (err) {
        document.getElementById('battle-reports-table-body').innerHTML = '<tr><td colspan="7" class="text-center py-8 text-red-500">Failed to load data.</td></tr>';
    }
}

function updateSortArrows() {
    document.querySelectorAll('#battle-reports-panel [data-sort-key]').forEach(th => {
        const arrow = th.querySelector('.sort-arrow');
        if (!arrow) return;
        arrow.textContent = th.getAttribute('data-sort-key') === battleReportsState.sort
            ? (battleReportsState.dir === 'desc' ? '▼' : '▲')
            : '';
    });
}

// One side's cell: name (bold + green if this side won the battle) plus its own committed
// CV, shown as "committed → left" whenever survivedCv is known — for BOTH sides, not just
// the winner. Originally only the winner's survived CV was shown (the loser's cell just
// said "N CV"), which made the CV Lost column's total impossible to verify by eye: the
// loser's own lost amount (committed − survived) was never displayed anywhere, so the two
// numbers never visibly "added up". Both sides carry survived_cv in the source data (see
// battleReports.js), so there's no reason to withhold it from the loser's cell too. A bare
// population-drop row has no side data at all (combatValue is null), so the CV line is
// omitted entirely rather than showing a misleading "— CV".
function battleSideCell(name, tag, combatValue, survivedCv, isWinner) {
    if (!name) return '<span class="text-muted-foreground">—</span>';
    const label = `${tag ? `[${esc(tag)}] ` : ''}${esc(name)}`;
    const nameHtml = isWinner ? `<strong class="text-emerald-400">${label}</strong>` : label;
    if (combatValue == null) return nameHtml;
    const cvLine = survivedCv != null
        ? `${combatValue.toLocaleString()} → ${survivedCv.toLocaleString()} left`
        : `${combatValue.toLocaleString()} CV`;
    return `${nameHtml}<div class="text-xs text-muted-foreground font-mono">${cvLine}</div>`;
}

function renderBattleReportsTable(feed, total) {
    const body = document.getElementById('battle-reports-table-body');
    const countEl = document.getElementById('battle-reports-result-count');
    const totalEl = document.getElementById('battle-reports-total-count');
    if (countEl) countEl.textContent = feed.length;
    if (totalEl) totalEl.textContent = total != null ? total : feed.length;
    if (!body) return;

    if (!feed.length) {
        body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-muted-foreground">${battleReportsState.q ? 'No battles or population drops match that search.' : 'No battles or population drops recorded yet.'}</td></tr>`;
        return;
    }

    body.innerHTML = feed.map(row => {
        const when = formatSqliteUtc(row.occurred_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const systemLabel = row.system_name ? `${esc(row.system_name)} [${row.system_id}] #${row.planet_index}` : `#${row.system_id}/${row.planet_index}`;
        const attacker = battleSideCell(row.attacker_name, row.attacker_alliance_tag,
            row.attacker_combat_value, row.attacker_survived_cv, row.winner_side === 'att');
        const defender = battleSideCell(row.defender_name, row.defender_alliance_tag,
            row.defender_combat_value, row.defender_survived_cv, row.winner_side === 'def');
        // 0 is a real value (a battle where nothing was actually lost, or a bare pop-drop
        // row with no CV at all) — shown as-is rather than masked as "no data".
        const cv = row.total_cv_lost != null ? row.total_cv_lost.toLocaleString() : '<span class="text-muted-foreground">—</span>';
        // killed_population === 0 is a real value (a battle that killed nobody) — shown
        // as plain "0", not "-0" (a bare unary minus in front of 0 is still "-0" in a
        // template string, which reads as a display bug, not a number).
        const population = (row.old_population != null && row.new_population != null)
            ? `${row.old_population} → ${row.new_population}`
            : (row.killed_population ? `-${row.killed_population}` : (row.killed_population === 0 ? '0' : '—'));
        // Battles link to the game's own report; a population drop with no matching
        // report has nothing to link to, so it's plain text instead.
        const report = row.battle_report_id
            ? `<button class="btn-open-battle-report text-primary hover:underline" data-report-id="${row.battle_report_id}">#${row.battle_report_id}</button>`
            : '<span class="text-muted-foreground italic">no report</span>';

        return `<tr class="hover:bg-accent/50">
            <td class="p-3 text-muted-foreground">${esc(when)}</td>
            <td class="p-3">${systemLabel}</td>
            <td class="p-3">${attacker}</td>
            <td class="p-3">${defender}</td>
            <td class="p-3 font-mono">${cv}</td>
            <td class="p-3 text-red-400">${esc(population)}</td>
            <td class="p-3">${report}</td>
        </tr>`;
    }).join('');

    body.querySelectorAll('.btn-open-battle-report').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.getAttribute('data-report-id');
            navToIframe(`/About/BattleReport/${id}`);
        });
    });
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
        const res = await gameFetch('/Game/Alliance');
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

                const mRes = await gameFetch(targetUrl);
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

// Column definitions, gating ("?" until intel is captured) and the stale-science greying
// live in stat-columns.js (PLAYER_COLUMNS); this only filters, sorts and paints.
function renderPlayerTable() {
    const input = document.getElementById('db-search-input');
    const q = (input ? input.value : '').toLowerCase();
    const f = rawDbPlayers.filter(p => (p.name && p.name.toLowerCase().includes(q)) || (p.id && p.id.toString().includes(q)) || (p.alliance_tag && p.alliance_tag.toLowerCase().includes(q)));
    const table = STAT_TABLES.players;
    const sorted = sortRows(f, table.columns, playerSort.col, playerSort.asc);
    const countEl = document.getElementById('db-result-count'); if (countEl) countEl.innerText = sorted.length;
    const tbody = document.getElementById('db-table-body'); if (!tbody) return;
    tbody.innerHTML = rowsHtml(table, sorted, 'hover:bg-accent/50 transition-colors');
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
            <td class="p-3 font-mono">${s.id}</td><td class="p-3 font-medium text-foreground">${esc(s.name || 'Unknown')}</td><td>${s.x}</td><td>${s.y}</td><td class="p-3 border-l border-border text-aw-ally">${s.planet_count || 0}</td><td class="p-3 text-aw-enemy">${s.fleet_count || 0}</td><td class="p-3 border-l border-border text-muted-foreground">${new Date(s.updated_at).toLocaleString()}</td>
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
            <td class="p-3 font-mono">${p.system_id}</td><td>${esc(p.system_name || 'Unknown')}</td><td class="p-3 font-medium text-foreground">#${p.planet_index}</td><td class="p-3 border-l border-border">${esc(p.owner_name || 'Empty')}</td><td class="p-3 text-aw-warning">${p.alliance_tag ? `[${esc(p.alliance_tag)}]` : '-'}</td><td class="p-3 border-l border-border text-primary">${(p.population || 0).toLocaleString()}</td><td class="p-3 text-aw-warning">${p.starbase || 0}</td><td class="p-3 border-l border-border text-muted-foreground">${new Date(p.updated_at).toLocaleString()}</td>
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
            <td class="p-3">${esc(f.system_name || 'Unknown')}</td><td class="p-3 font-medium text-foreground">#${f.planet_index}</td><td class="p-3 border-l border-border">${esc(f.owner_name || 'Unknown')}</td><td class="p-3 text-aw-warning">${f.alliance_tag ? `[${esc(f.alliance_tag)}]` : '-'}</td><td class="p-3 border-l border-border text-gray-400">${f.transports || 0}</td><td class="p-3 text-gray-400">${f.colony_ships || 0}</td><td class="p-3 text-red-400 border-l border-border">${f.destroyers || 0}</td><td class="p-3 text-red-400">${f.cruisers || 0}</td><td class="p-3 text-red-400">${f.battleships || 0}</td><td class="p-3 text-aw-warning border-l border-border font-bold">${(f.cv || 0).toLocaleString()}</td><td class="p-3 border-l border-border ${f.arrival_time && f.arrival_time !== '-' ? 'text-red-400 font-bold' : 'text-muted-foreground'}">${esc(f.arrival_time || 'Stationed')}</td>
        </tr>`).join('');
}

// The sheet columns that hold localised number TEXT ("999.9", "1,000") are marked
// sort: 'numtext' in ALLY_STATS_COLUMNS, so sortRows hands them to the shared locale-aware
// parser instead of comparing them as strings.
function renderAllyStatsTable() {
    const table = STAT_TABLES.allyStats;
    const filtered = sortRows(rawDbAllyStats, table.columns, allySort.col, allySort.asc);

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

    tbody.innerHTML = rowsHtml(table, filtered, 'hover:bg-accent/50 transition-colors border-b border-border/60');
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
    if (needed <= 0) return 'now';            // already at the threshold, regardless of income
    if (!ratePerH || ratePerH <= 0) return '–';
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
        const doc = new DOMParser().parseFromString(await (await gameFetch('/Game/Alliance')).text(), 'text/html');
        const memberLinks = Array.from(doc.querySelectorAll('a[href*="/Game/Alliance/Member/"]'));
        const tradePairs = [];
        for (const link of memberLinks) {
            try {
                if (!/\/Member\/(\d+)/.test(link.href)) continue;
                const mDoc = new DOMParser().parseFromString(await (await gameFetch(link.href)).text(), 'text/html');
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
            const opts = members.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.isTrader ? ' (T)' : ''}</option>`).join('');
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
                <span class="text-sm text-foreground"><b>${esc(other)}</b> proposed a trade agreement with you</span>
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
        html += `<th class="bg-zinc-900 px-1 py-1 border border-border/40 ${t}" title="${esc(p.name)}">${esc(taShort(p.name))}</th>`;
    });
    // Trailing wealth columns: a spacer, then hoarded A$ and visible A$ (+PP).
    html += `<th class="bg-black border-0" style="min-width:14px"></th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-amber-400 border border-border/40" title="A$ value of artifacts + supply units this member is holding">Hoard A$</th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-emerald-400 border border-border/40" title="Visible liquidity: Astro Dollars + Production Points valued in A$">A$+PP</th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-sky-400 border border-border/40" title="Time to reach ${TA_TRADE_COST.toLocaleString()} A$ from visible liquidity at current income (Production/h × PP price)">Ready in</th>`;
    html += `<th class="bg-zinc-900 px-2 py-1 text-sky-300 border border-border/40" title="Time to reach ${TA_TRADE_COST.toLocaleString()} A$ if the hoard is sold now (visible + hoard, then income)">Ready (sold)</th>`;
    html += `</tr></thead><tbody>`;

    members.forEach(p1 => {
        const c1 = taCount(p1.name.toLowerCase(), agreements);
        const full1 = c1 >= maxTas;
        html += `<tr>
            <td class="sticky left-0 bg-black px-2 py-1 md:px-3 md:py-1.5 font-semibold text-foreground border border-border/40 whitespace-nowrap">${esc(p1.name)}${p1.isTrader ? ' <span class="text-yellow-400">T</span>' : ''}</td>
            <td class="px-2 py-1 md:px-3 md:py-1.5 text-center border border-border/40 ${full1 ? 'text-green-400 font-bold' : 'text-muted-foreground'}">${c1}/${maxTas}</td>`;
        members.forEach(p2 => {
            html += taCell(p1, p2, { me: meLower, isAdmin, maxTas, traderSet, agreements, full1 });
        });
        html += `<td class="bg-black border-0"></td>`;
        html += `<td class="px-2 py-1 md:px-3 md:py-1.5 text-right border border-border/40 text-amber-400 font-semibold" title="${(p1.hoarded_au || 0).toLocaleString()} A$">${fmtAU(p1.hoarded_au)}</td>`;
        html += `<td class="px-2 py-1 md:px-3 md:py-1.5 text-right border border-border/40 text-emerald-400" title="${(p1.visible_au || 0).toLocaleString()} A$">${fmtAU(p1.visible_au)}</td>`;
        // Ready in: time to reach 20k from visible liquidity. Ready (sold): same once the hoard is sold now.
        const need1 = Math.max(0, TA_TRADE_COST - (p1.visible_au || 0));
        const need2 = Math.max(0, TA_TRADE_COST - (p1.visible_au || 0) - (p1.hoarded_au || 0));
        const t1 = fmtReady(TA_TRADE_COST - (p1.visible_au || 0), p1.au_per_h);
        const t2 = fmtReady(TA_TRADE_COST - (p1.visible_au || 0) - (p1.hoarded_au || 0), p1.au_per_h);
        html += `<td class="px-2 py-1 md:px-3 md:py-1.5 text-right border border-border/40 text-sky-400 whitespace-nowrap" title="${(p1.au_per_h || 0).toLocaleString()} A$/h · need ${need1.toLocaleString()} A$">${t1}</td>`;
        html += `<td class="px-2 py-1 md:px-3 md:py-1.5 text-right border border-border/40 text-sky-300 whitespace-nowrap" title="${(p1.au_per_h || 0).toLocaleString()} A$/h · need ${need2.toLocaleString()} A$ after selling ${(p1.hoarded_au || 0).toLocaleString()} A$ hoard">${t2}</td>`;
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
        let bg = '#a16207', label = 'P', title = `Proposed by ${esc(ta.initiator)}`;
        if (ta.status === 'confirmed') { bg = '#15803d'; label = '✓'; title = 'Confirmed' + (ta.is_admin_set ? ' (admin)' : ''); }
        else if (ta.status === 'done') { bg = '#1d4ed8'; label = '★'; title = 'Done'; }
        const clickable = canAct && ta.status !== 'done';
        return `<td class="${cls}"><button ${clickable ? `data-ta-pair="1" data-ta-a="${esc(p1.name)}" data-ta-b="${esc(p2.name)}"` : 'disabled'} title="${title}${clickable ? ' — click to remove' : ''}" style="width:100%;min-height:28px;border:none;background:${bg};color:#fff;font-weight:bold;cursor:${clickable ? 'pointer' : 'default'}">${label}</button></td>`;
    }

    // empty cell
    const p2Full = taCount(p2.name.toLowerCase(), ctx.agreements) >= ctx.maxTas;
    const blocked = ctx.full1 || p2Full;
    if (canAct && !blocked) {
        return `<td class="${cls}"><button data-ta-pair="1" data-ta-a="${esc(p1.name)}" data-ta-b="${esc(p2.name)}" title="${ctx.isAdmin && !( [p1.name.toLowerCase(),p2.name.toLowerCase()].includes(ctx.me)) ? 'Set pairing (admin)' : 'Propose'}" style="width:100%;min-height:28px;border:none;background:transparent;color:#555;font-weight:bold;cursor:pointer">+</button></td>`;
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
        let pair = `<span>${esc(item.p1)}</span> <i class="fa-solid fa-right-left text-muted-foreground mx-2"></i> <span>${esc(item.p2)}</span>`;
        if (item.is_trader) pair = `<span class="text-yellow-400 font-bold">${pair}</span>`;
        return `<td class="p-3 text-muted-foreground font-mono">${index + 1}</td><td class="p-3 font-medium text-foreground">${pair} <span class="text-xs text-muted-foreground ml-1">(${formatTaHours(item.time)})</span></td>`;
    };
    let rows = '';
    for (let i = 0; i < schedule.length; i += 2) rows += `<tr class="hover:bg-accent/40">${cell(schedule[i], i)}${cell(schedule[i + 1], i + 1)}</tr>`;
    let footer = '';
    if (missingPlayers.size > 0) footer = `<tr><td colspan="4" class="text-center py-2 text-aw-warning bg-yellow-950/30 text-xs">⚠️ No alliance-stats data for: ${esc(Array.from(missingPlayers).join(', '))}</td></tr>`;
    tbody.innerHTML = rows + footer;
}

export async function openBattleCalcPanel() {
    let panel = document.getElementById('battle-calc-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/battle-calc.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('battle-calc-panel');
        const { initBattleCalc } = await import('./battle-calc.js');
        initBattleCalc();
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('battle-calc-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
}

export async function openTravelCalcPanel() {
    let panel = document.getElementById('travel-calc-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/travel-calc.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('travel-calc-panel');
        const { initTravelCalc } = await import('./travel-calc-ui.js');
        initTravelCalc();
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('travel-calc-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
}

export async function openBuildOrderPanel() {
    let panel = document.getElementById('build-order-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/build-order.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('build-order-panel');
        const { initBuildOrder } = await import('./build-order.js');
        initBuildOrder();
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('build-order-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
}

export async function openEmpireSimPanel() {
    let panel = document.getElementById('empire-sim-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/empire-sim.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('empire-sim-panel');
        const { initEmpireSim } = await import('./empire-sim.js');
        initEmpireSim();
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeOtherPanels('empire-sim-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
}

let routePlannerLoading = null;

export async function openRoutePlannerPanel(options = {}) {
    const { draft, showSaved = false } = options;
    let panel = document.getElementById('route-planner-panel');
    if (!panel || routePlannerLoading) {
        // Both calculator links and the sidebar may open the panel while its first
        // load is still pending. Initialize it once before handing a flight over.
        if (!routePlannerLoading) routePlannerLoading = (async () => {
            const res = await fetch('/hub-assets/components/route-planner.html');
            if (!res.ok) throw new Error('Could not load the Route Planner. Try again.');
            document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
            try {
                const { initRoutePlanner } = await import('./route-planner.js');
                await initRoutePlanner();
            } catch (error) {
                document.getElementById('route-planner-panel')?.remove();
                throw error;
            }
        })().finally(() => { routePlannerLoading = null; });
        await routePlannerLoading;
        panel = document.getElementById('route-planner-panel');
    }
    if (panel.classList.contains('translate-x-0') && !draft && !showSaved) {
        return panel.classList.replace('translate-x-0', 'translate-x-full');
    }
    closeOtherPanels('route-planner-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    if (draft) {
        const { loadRouteDraft } = await import('./route-planner.js');
        await loadRouteDraft(draft);
    }
    if (showSaved) {
        const { showSavedRoutes } = await import('./route-planner.js');
        await showSavedRoutes();
    }
}
