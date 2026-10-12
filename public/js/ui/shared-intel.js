// Shared Intel panel — what partner hubs have shared with us (GET /hub-api/peers/*).
//
// Kept in its own panel on purpose rather than blended into Players/Systems/Fleets: those
// tables are what OUR members saw and what our own feed passes on to partners, and this is
// what someone else's members saw. Each row says which partner it came from and when they
// observed it, so nobody launches on a stranger's three-day-old sighting thinking it is ours.
//
// Everything here came from another alliance's server — every value is escaped.
import { esc } from '../utils/escape.js';
import { playerLink, allianceLink, systemLink } from '../utils/game-links.js';

const { formatSqliteUtc } = globalThis.AWSqliteTime || {};

let searchTimer = null;

const n = v => (v === null || v === undefined || v === '' ? '<span class="text-zinc-600">—</span>' : esc(Number(v).toLocaleString()));
const seen = ts => esc(formatSqliteUtc ? formatSqliteUtc(ts) : ts);
const ships = d => [d.destroyers && `${d.destroyers} DD`, d.cruisers && `${d.cruisers} CR`, d.battleships && `${d.battleships} BS`,
    d.transports && `${d.transports} TR`, d.colony_ships && `${d.colony_ships} CS`].filter(Boolean)
    .map(t => `<span class="whitespace-nowrap">${esc(t)}</span>`).join(' · ') || '—';

// "5m", "3h", "2d" — how old a partner's observation is matters more on a phone than the
// exact time, which stays in the tooltip.
const utcMs = ts => Date.parse(String(ts).replace(' ', 'T') + 'Z');
function span(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return `${m}m`;
    if (m < 48 * 60) return `${Math.floor(m / 60)}h${m % 60 && m < 600 ? ` ${m % 60}m` : ''}`;
    return `${Math.round(m / 1440)}d`;
}
const age = ts => (Number.isFinite(utcMs(ts)) ? `${span(Date.now() - utcMs(ts))} ago` : '?');
const arrives = unix => {
    if (!(unix > 0)) return '—';
    const ms = unix * 1000 - Date.now();
    const exact = seen(new Date(unix * 1000).toISOString().slice(0, 19).replace('T', ' '));
    return `<span class="whitespace-nowrap" title="${exact}">${ms > 0 ? `in ${span(ms)}` : `landed ${span(ms)} ago`}</span>`;
};

// Columns per kind: [header, cell(row)]. row = { key, sourceName, changedAt, data }.
const COLUMNS = {
    players: [
        ['Player', r => playerLink(Number(r.key), r.data.name)],
        ['Alliance', r => allianceLink(r.data.alliance_id, r.data.alliance_tag)],
        ['Lvl', r => n(r.data.level)], ['Sci', r => n(r.data.science_level)], ['Pts', r => n(r.data.points)],
        ['Att/Def', r => `${n(r.data.race_attack)} / ${n(r.data.race_defense)}`],
        ['Phys/Math', r => (r.data.has_intel ? `${n(r.data.physics)} / ${n(r.data.mathematics)}` : '<span class="text-zinc-600">no intel</span>')],
        ['Planets', r => n(r.data.total_planets)], ['CV', r => `${n(r.data.cv_used)} / ${n(r.data.cv_limit)}`],
    ],
    systems: [
        ['System', r => systemLink(Number(r.key), r.data.name || `#${r.key}`)],
        ['Pos', r => esc(`${r.data.x ?? '?'}, ${r.data.y ?? '?'}`)],
        ['Planets', r => (r.data.planets || []).map(p =>
            `<span class="inline-block mr-2">#${esc(p.planet_index)} ${p.owner_name ? playerLink(p.owner_id, p.owner_name) : '<span class="text-zinc-500">free</span>'}`
            + `${p.owner_tag ? ' ' + allianceLink(null, p.owner_tag) : ''} <span class="text-zinc-500">pop ${esc(p.population ?? '?')}${p.starbase ? ` · SB ${esc(p.starbase)}` : ''}${p.is_sieged ? ' · sieged' : ''}</span></span>`).join('') || '—'],
    ],
    alliances: [
        ['Alliance', r => allianceLink(Number(r.key), r.data.tag)], ['Name', r => esc(r.data.full_name || r.data.name)],
        ['Members', r => n(r.data.member_count)], ['Rank', r => n(r.data.ranking)], ['Points', r => n(r.data.points_current)],
    ],
    fleets: [
        ['Owner', r => `${playerLink(r.data.owner_id, r.data.owner_name)} ${allianceLink(null, r.data.owner_tag)}`],
        ['At', r => (r.data.system_id ? systemLink(r.data.system_id, `#${r.data.system_id}${r.data.planet_index ? '/' + r.data.planet_index : ''}`) : '—')],
        ['To', r => (r.data.destination_system_id ? systemLink(r.data.destination_system_id, `#${r.data.destination_system_id}`) : '—')],
        ['Ships', r => ships(r.data)], ['CV', r => n(r.data.combat_value)], ['Arrives', r => esc(r.data.arrival_at || '—')],
    ],
    fleet_locations: [
        ['Owner', r => `${playerLink(Number(r.key), r.data.owner_name)} ${allianceLink(null, r.data.owner_tag)}`],
        ['Fleets', r => (r.data.fleets || []).map(f =>
            `<span class="block">#${esc(f.rank)} ${ships(f)} · CV ${n(f.cv)} @ `
            + `${f.system_id ? systemLink(f.system_id, `${f.system_name || '#' + f.system_id}${f.planet_index ? '/' + f.planet_index : ''}`) : esc(f.planet_label || '?')}</span>`).join('') || '—'],
    ],
    incomings: [
        ['Attacker', r => `${playerLink(r.data.attacker_id, r.data.attacker_name)} ${allianceLink(null, r.data.attacker_tag)}`],
        ['Arrives', r => arrives(r.data.arrival_unix)],
        ['Target', r => (r.data.target_system_id ? systemLink(r.data.target_system_id,
            r.data.target_planet_name || `#${r.data.target_system_id}/${r.data.target_planet_index ?? '?'}`) : '—')],
        ['Ships', r => ships(r.data)], ['CV', r => n(r.data.cv)],
    ],
    battle_reports: [
        ['When', r => esc(r.data.started_at || '—')],
        ['Attacker', r => `${playerLink(r.data.att_player_id, r.data.att_player_name)} ${allianceLink(r.data.att_alliance_id, r.data.att_alliance_tag)}`],
        ['Defender', r => `${playerLink(r.data.def_player_id, r.data.def_player_name)} ${allianceLink(r.data.def_alliance_id, r.data.def_alliance_tag)}`],
        ['Where', r => (r.data.system_id ? systemLink(r.data.system_id, `#${r.data.system_id}${r.data.planet_index ? '/' + r.data.planet_index : ''}`) : '—')],
        ['CV att/def', r => `${n(r.data.att_combat_value)} / ${n(r.data.def_combat_value)}`],
        ['Winner', r => esc(r.data.winner || '—')],
    ],
};
// Which partner and how fresh, right after the first column so it stays on screen on a phone.
const FROM = ['From', r => `<span class="whitespace-nowrap">${esc(r.sourceName)}</span><br>`
    + `<span class="text-xs text-muted-foreground whitespace-nowrap" title="${seen(r.changedAt)}">${age(r.changedAt)}</span>`];

async function loadSummary() {
    const res = await fetch('/hub-api/peers/summary');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    const kindSel = document.getElementById('shared-intel-kind');
    const srcSel = document.getElementById('shared-intel-source');
    const total = k => data.sources.reduce((s, x) => s + (x.counts[k] || 0), 0);
    const prevKind = kindSel.value;
    kindSel.innerHTML = data.kinds.map(k => `<option value="${esc(k.key)}">${esc(k.label)} (${total(k.key)})</option>`).join('');
    if (prevKind) kindSel.value = prevKind;
    const prevSrc = srcSel.value;
    srcSel.innerHTML = '<option value="">All partners</option>'
        + data.sources.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.enabled ? '' : ' (paused)'}</option>`).join('');
    srcSel.value = prevSrc;
    return data;
}

async function loadRows() {
    const kind = document.getElementById('shared-intel-kind').value;
    const source = document.getElementById('shared-intel-source').value;
    const q = document.getElementById('shared-intel-search').value.trim();
    const head = document.getElementById('shared-intel-head');
    const body = document.getElementById('shared-intel-body');
    const status = document.getElementById('shared-intel-status');
    if (!kind) return;
    const cols = [COLUMNS[kind][0], FROM, ...COLUMNS[kind].slice(1)];
    head.innerHTML = `<tr>${cols.map(([h]) => `<th class="text-left px-3 py-2">${esc(h)}</th>`).join('')}</tr>`;
    status.textContent = 'loading…';
    try {
        const params = new URLSearchParams({ kind, q, limit: '300' });
        if (source) params.set('source', source);
        const res = await fetch(`/hub-api/peers/intel?${params}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'failed');
        body.innerHTML = data.rows.length
            ? data.rows.map(r => `<tr class="border-b border-border/50 hover:bg-white/5">${cols.map(([, cell]) => `<td class="px-3 py-1.5 align-top">${cell(r)}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${cols.length}" class="text-center py-8 text-muted-foreground">Nothing shared with us here${q ? ' matches that search' : ' yet'}.</td></tr>`;
        status.textContent = `${data.rows.length}${data.rows.length >= 300 ? '+' : ''} shown`;
    } catch (err) {
        body.innerHTML = `<tr><td colspan="${cols.length}" class="text-center py-8 text-red-500">Failed to load shared intel.</td></tr>`;
        status.textContent = 'error';
    }
}

async function load() {
    const status = document.getElementById('shared-intel-status');
    try {
        const summary = await loadSummary();
        if (!summary.sources.length) {
            document.getElementById('shared-intel-head').innerHTML = '';
            document.getElementById('shared-intel-body').innerHTML =
                '<tr><td class="text-center py-12 text-muted-foreground">No partner hubs yet. An admin can connect one under Admin → Peer Sharing.</td></tr>';
            status.textContent = '';
            return;
        }
        await loadRows();
    } catch (err) {
        status.textContent = 'error';
    }
}

// Same sibling handling as the Sleep Map: slide the other panels away.
function closeSiblings(exceptId) {
    document.querySelectorAll('#dynamic-panels-container > div').forEach(el => {
        if (el.id !== exceptId) el.classList.replace('translate-x-0', 'translate-x-full');
    });
}

export async function openSharedIntelPanel() {
    let panel = document.getElementById('shared-intel-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/shared-intel.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('shared-intel-panel');
        panel.querySelector('#shared-intel-close-btn')?.addEventListener('click', () => {
            panel.classList.replace('translate-x-0', 'translate-x-full');
        });
        panel.querySelector('#shared-intel-kind')?.addEventListener('change', loadRows);
        panel.querySelector('#shared-intel-source')?.addEventListener('change', loadRows);
        panel.querySelector('#shared-intel-search')?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(loadRows, 250);
        });
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeSiblings('shared-intel-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    await load();
}
