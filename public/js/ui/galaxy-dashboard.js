// Galaxy Dashboard — galaxy-wide standings, war tempo and leaderboards on one panel.
//
// Every number is computed server-side (GET /hub-api/intel/galaxy-stats,
// src/utils/galaxy-stats.js) from what is already on disk, so opening this costs no game
// request. The one thing done here is bucketing the battle chart into the viewer's own
// days: the server answers in UTC hours because it cannot know where the member sits.
import { esc, escAttr } from '../utils/escape.js';

const PANEL_ID = 'galaxy-dashboard-panel';
const HOUR = 3600 * 1000;

let data = null;
let sort = { key: 'ranking', dir: 'asc' };

const fmt = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

function ago(ms) {
    if (!ms) return 'never';
    const h = (Date.now() - ms) / HOUR;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
    if (h < 48) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function tagHtml(tag) {
    if (!tag) return '<span class="text-muted-foreground/50">—</span>';
    const upper = String(tag).toUpperCase();
    const cls = data.ownTags.includes(upper) ? 'text-primary font-semibold'
        : data.friendlyTags.includes(upper) ? 'text-green-400' : 'text-muted-foreground';
    return `<span class="${cls}">[${esc(tag)}]</span>`;
}

function tile(label, value, sub, warn) {
    return `<div class="rounded-lg border ${warn ? 'border-amber-700/60' : 'border-border'} bg-zinc-950 px-3 md:px-4 py-3 min-w-0">
        <div class="text-[11px] uppercase tracking-wider text-muted-foreground">${esc(label)}</div>
        <div class="text-xl md:text-2xl font-bold text-foreground font-mono mt-1 whitespace-nowrap">${value}</div>
        <div class="text-[11px] ${warn ? 'text-amber-400' : 'text-muted-foreground'} mt-0.5 md:truncate" title="${escAttr(sub.replace(/<[^>]+>/g, ''))}">${sub}</div>
    </div>`;
}

function renderTiles() {
    const h = data.headline;
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    // Battle reports come from their own sync; if it has stalled, "3 battles today" is a
    // sync problem, not a quiet galaxy, and the tile says so.
    const battlesStale = h.latestBattleAt && Date.now() - h.latestBattleAt > 6 * HOUR;
    document.getElementById('galaxy-dash-tiles').innerHTML = [
        tile('Planets owned', `${fmt(h.ownedPlanets)}<span class="text-sm text-muted-foreground"> / ${fmt(h.planets)}</span>`, `${pct(h.ownedPlanets, h.planets)}% colonised · ${fmt(h.freePlanets)} free`),
        tile('Systems spawned', `${fmt(h.occupiedSystems)}<span class="text-sm text-muted-foreground"> / ${fmt(h.systems)}</span>`, `${fmt(h.systems - h.occupiedSystems)} still closed`),
        tile('Planets under siege', fmt(h.siegedPlanets), `${pct(h.siegedPlanets, h.ownedPlanets)}% of owned planets`),
        tile('Players active', `${fmt(h.active1h)}<span class="text-sm text-muted-foreground"> now</span>`, `${fmt(h.active24h)} in 24h · ${fmt(h.players)} players · ${fmt(h.alliances)} alliances`),
        tile('Battles, 24h', fmt(h.battles24h), battlesStale ? `latest report ${ago(h.latestBattleAt)} — battle sync behind` : `${fmt(h.conquests24h)} conquests`, battlesStale),
        tile('Planets changed hands, 24h', fmt(h.ownerChanges24h), `${fmt(h.changes24h.colonised)} colonised · ${fmt(h.changes24h.taken)} taken · ${fmt(h.changes24h.lost)} lost`),
    ].join('');
}

function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function renderChart() {
    const days = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    for (let i = data.chartDays - 1; i >= 0; i--) {
        const d = new Date(start);
        d.setDate(d.getDate() - i);
        days.push({ key: localDayKey(d.getTime()), date: d, battles: 0, conquests: 0 });
    }
    const byKey = new Map(days.map(d => [d.key, d]));
    for (const b of data.battlesHourly) {
        const day = byKey.get(localDayKey(b.t));
        if (day) { day.battles += b.battles; day.conquests += b.conquests; }
    }
    const max = Math.max(1, ...days.map(d => d.battles));
    const today = days[days.length - 1].key;

    const bars = days.map(d => {
        const other = d.battles - d.conquests;
        const label = d.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        const tip = `${label}: ${d.battles} battles, ${d.conquests} conquests${d.key === today ? ' (today so far)' : ''}`;
        // Hit target is the full column, not the bar, so short days are still hoverable.
        return `<div class="flex-1 min-w-0 h-full flex flex-col justify-end items-stretch group cursor-default" title="${escAttr(tip)}">
            <div class="text-[10px] text-center text-muted-foreground opacity-0 group-hover:opacity-100 font-mono">${d.battles}</div>
            <div class="flex flex-col-reverse gap-[2px] mx-[2px]" style="height:${(d.battles / max) * 85}%">
                ${d.conquests ? `<div class="rounded-b-[2px] ${other ? '' : 'rounded-t-[4px]'}" style="background:#38bdf8;flex:${d.conquests} 1 0"></div>` : ''}
                ${other ? `<div class="rounded-t-[4px] ${d.conquests ? '' : 'rounded-b-[2px]'} group-hover:brightness-125" style="background:#52525b;flex:${other} 1 0"></div>` : ''}
            </div>
            <div class="text-[10px] text-center mt-1 ${d.key === today ? 'text-foreground' : 'text-muted-foreground/70'}">${d.date.getDate()}</div>
        </div>`;
    }).join('');
    document.getElementById('galaxy-dash-chart').innerHTML = `<div class="relative h-full flex items-stretch border-b border-border/60">
        <span class="absolute -top-1 left-0 text-[10px] text-muted-foreground/60 font-mono">${max}</span>
        ${bars}
    </div>`;

    const total = days.reduce((n, d) => n + d.battles, 0);
    const conquests = days.reduce((n, d) => n + d.conquests, 0);
    document.getElementById('galaxy-dash-chart-note').textContent =
        `${total} battles and ${conquests} conquests over ${data.chartDays} days, by your local day. Latest report ${ago(data.headline.latestBattleAt)}.`;
}

function board(listId, rows, valueOf) {
    const el = document.getElementById(listId);
    if (!rows.length) { el.innerHTML = '<li class="text-muted-foreground">No data yet.</li>'; return; }
    el.innerHTML = rows.map((r, i) => `<li class="flex items-baseline gap-2 min-w-0">
        <span class="w-5 text-right text-muted-foreground/60 shrink-0">${i + 1}</span>
        <span class="truncate text-foreground">${esc(r.name || `#${r.id}`)}</span>
        <span class="shrink-0">${tagHtml(r.tag)}</span>
        <span class="ml-auto shrink-0 text-foreground">${valueOf(r)}</span>
    </li>`).join('');
}

function renderBoards() {
    const t = data.top;
    board('galaxy-dash-top-fleet', t.fleet, r => `<span title="${escAttr(`${fmt(r.destroyers)} DS · ${fmt(r.cruisers)} CR · ${fmt(r.battleships)} BS`)}">${fmt(r.cv)} cv</span>`);
    board('galaxy-dash-top-level', t.level, r => `PL ${r.level} <span class="text-muted-foreground">${fmt(r.xp)}xp</span>`);
    board('galaxy-dash-top-pop', t.population, r => `${fmt(r.population)} <span class="text-muted-foreground">${r.planets}p</span>`);
    document.getElementById('galaxy-dash-fleet-asof').textContent = t.fleetAsOf ? `Ranking snapshot ${ago(Date.parse(t.fleetAsOf))}` : '';
}

// key, label, value for sorting, cell html, default direction
const COLUMNS = [
    ['ranking', '#', r => r.ranking ?? Infinity, r => r.ranking ?? '—', 'asc'],
    ['tag', 'Alliance', r => (r.tag || '~').toLowerCase(), r => `${tagHtml(r.tag)} <span class="text-muted-foreground font-sans">${esc(r.name || '')}</span>`, 'asc'],
    ['points', 'Pts', r => r.points ?? -1, r => fmt(r.points), 'desc'],
    ['members', 'Members', r => r.members, r => `${r.members} <span class="text-muted-foreground" title="active in the last 24h">(${r.active24h})</span>`, 'desc'],
    ['avgLevel', 'Avg PL', r => r.avgLevel ?? -1, r => r.avgLevel ?? '—', 'desc'],
    ['planets', 'Planets', r => r.planets, r => fmt(r.planets), 'desc'],
    ['share', 'Share', r => r.share, r => `<div class="flex items-center gap-2"><div class="w-16 h-1.5 bg-zinc-800 rounded"><div class="h-1.5 rounded" style="width:${Math.min(100, r.share * 4)}%;background:#a1a1aa"></div></div>${r.share}%</div>`, 'desc'],
    ['population', 'Pop', r => r.population, r => fmt(r.population), 'desc'],
    ['net24h', '± 24h', r => r.gained24h - r.lost24h, r => delta(r.gained24h, r.lost24h), 'desc'],
    ['net7d', '± 7d', r => r.gained7d - r.lost7d, r => delta(r.gained7d, r.lost7d), 'desc'],
    ['battles7d', 'Battles 7d', r => r.battles7d, r => r.battles7d ? `${r.battles7d} <span class="text-muted-foreground">(<span class="text-green-400">${r.won7d}W</span> <span class="text-red-400">${r.lostBattles7d}L</span>)</span>` : '<span class="text-muted-foreground/50">—</span>', 'desc'],
    ['conquests7d', 'Conquests 7d', r => r.conquests7d, r => r.conquests7d || '<span class="text-muted-foreground/50">—</span>', 'desc'],
];

function delta(gained, lost) {
    if (!gained && !lost) return '<span class="text-muted-foreground/50">—</span>';
    const net = gained - lost;
    const cls = net > 0 ? 'text-green-400' : net < 0 ? 'text-red-400' : 'text-muted-foreground';
    return `<span class="${cls}">${net > 0 ? '+' : ''}${net}</span> <span class="text-muted-foreground/70">+${gained}/−${lost}</span>`;
}

function renderStandings() {
    document.getElementById('galaxy-dash-head').innerHTML = COLUMNS.map(([key, label]) => {
        const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th class="px-3 py-2 cursor-pointer select-none whitespace-nowrap hover:text-foreground" data-key="${key}">${label}${arrow}</th>`;
    }).join('');
    const col = COLUMNS.find(c => c[0] === sort.key) || COLUMNS[0];
    const mult = sort.dir === 'asc' ? 1 : -1;
    const rows = [...data.alliances].sort((a, b) => {
        const x = col[2](a), y = col[2](b);
        return (x < y ? -1 : x > y ? 1 : 0) * mult || b.planets - a.planets;
    });
    document.getElementById('galaxy-dash-body').innerHTML = rows.map(r => {
        const own = r.tag && data.ownTags.includes(String(r.tag).toUpperCase());
        return `<tr class="${own ? 'bg-white/[0.06]' : ''} hover:bg-white/5">${COLUMNS.map(c => `<td class="px-3 py-1.5 whitespace-nowrap">${c[3](r)}</td>`).join('')}</tr>`;
    }).join('');
}

async function load() {
    const status = document.getElementById('galaxy-dash-status');
    if (status) status.textContent = 'loading...';
    try {
        const res = await fetch('/hub-api/intel/galaxy-stats');
        const body = await res.json();
        if (!res.ok || !body.success) throw new Error(body.error || 'failed');
        data = body;
        renderTiles();
        renderChart();
        renderBoards();
        renderStandings();
        if (status) status.textContent = `updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
    } catch (err) {
        document.getElementById('galaxy-dash-tiles').innerHTML = '<div class="col-span-full text-center py-8 text-red-500">Failed to load the galaxy dashboard.</div>';
        if (status) status.textContent = 'error';
    }
}

// Panels share one container and slide over each other. archives.js closes only the
// panels on its own list, so this one closes itself when any other sidebar tool opens.
function closeSiblings(exceptId) {
    document.querySelectorAll('#dynamic-panels-container > div').forEach(el => {
        if (el.id !== exceptId) el.classList.replace('translate-x-0', 'translate-x-full');
    });
}

function close() {
    document.getElementById(PANEL_ID)?.classList.replace('translate-x-0', 'translate-x-full');
}

export async function openGalaxyDashboardPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        const res = await fetch('/hub-assets/components/galaxy-dashboard.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById(PANEL_ID);
        panel.querySelector('#galaxy-dash-close-btn')?.addEventListener('click', close);
        panel.querySelector('#galaxy-dash-reload')?.addEventListener('click', load);
        panel.querySelector('#galaxy-dash-head')?.addEventListener('click', e => {
            const key = e.target.closest('th')?.dataset.key;
            if (!key || !data) return;
            const col = COLUMNS.find(c => c[0] === key);
            sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: col[4] };
            renderStandings();
        });
        document.getElementById('sidebar')?.addEventListener('click', e => {
            const btn = e.target.closest('button[id^="open-"]');
            if (btn && btn.id !== 'open-galaxy-dashboard-btn') close();
        });
    }
    if (panel.classList.contains('translate-x-0')) return close();
    closeSiblings(PANEL_ID);
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    await load();
}
