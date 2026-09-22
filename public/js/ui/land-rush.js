// Land Rush panel — how much of the galaxy is still unclaimed and how long that lasts.
//
// All of the analysis is server-side (src/utils/land-rush.js via /hub-api/intel/land-rush).
// This file renders it, and its one real job is to keep the two exhaustion projections next
// to each other. The optimistic one counts every planet the hub believes is free; the
// honest one counts only the planets it has actually looked at inside the freshness
// horizon. The gap between them is the uncertainty, and showing a single number would
// present the hub's memory as the state of the galaxy.
import { esc } from '../utils/escape.js';

let data = null;

function fmtDays(days) {
    if (days === null || days === undefined) return '—';
    if (days < 1) return `${Math.round(days * 24)}h`;
    return `${days.toFixed(1)}d`;
}

function fmtDate(ms) {
    const d = new Date(ms);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtAge(hours) {
    if (hours === null || hours === undefined) return '—';
    if (hours < 1) return '<1h';
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
}

function card(label, value, note, tone) {
    const colour = tone === 'warn' ? 'text-aw-warning' : tone === 'bad' ? 'text-aw-enemy' : 'text-foreground';
    return `<div class="border border-border rounded-lg bg-card p-3">
        <div class="text-[11px] uppercase tracking-wider text-muted-foreground">${esc(label)}</div>
        <div class="text-2xl font-bold ${colour} font-mono">${esc(value)}</div>
        <div class="text-[11px] text-muted-foreground mt-1">${note}</div>
    </div>`;
}

function renderHeadline() {
    const host = document.getElementById('land-rush-headline');
    if (!host || !data) return;

    const optimistic = data.projection.onEverythingKnownFree;
    const honest = data.projection.onRecentlyConfirmed;
    const freshLabel = data.freshHours >= 24 ? `${Math.round(data.freshHours / 24)}d` : `${data.freshHours}h`;

    host.innerHTML = [
        card('Free planets on file', String(data.free.total),
            `${data.free.withinHorizon} confirmed free within ${esc(freshLabel)}, ${data.free.older} last seen longer ago`),
        card('Claimed per day', data.rate.claimsPerDay.toFixed(1),
            `${data.rate.claims} colonisations over ${data.rate.ratedOnDays} whole day${data.rate.ratedOnDays === 1 ? '' : 's'}`),
        card('Runs out (everything on file)', fmtDays(optimistic && optimistic.days),
            optimistic ? `around ${esc(fmtDate(optimistic.at))}, straight-line` : 'nothing is being claimed', 'warn'),
        card('Runs out (recently confirmed only)', fmtDays(honest && honest.days),
            honest ? `around ${esc(fmtDate(honest.at))} — the number to plan on` : 'nothing confirmed free recently', 'bad'),
    ].join('');
}

function renderFrontier() {
    const body = document.getElementById('land-rush-frontier');
    if (!body || !data) return;
    const needle = (document.getElementById('land-rush-search')?.value || '').trim().toLowerCase();

    const rows = data.frontier.filter(s => {
        if (!needle) return true;
        return String(s.system_id).includes(needle)
            || (s.name || '').toLowerCase().includes(needle)
            || s.claimingTags.some(t => t.tag.toLowerCase().includes(needle));
    });

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-muted-foreground">No system matches.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(s => {
        const named = s.claimingTags.map(t => `<span class="text-foreground">${esc(t.tag)}</span>&nbsp;${t.claims}`).join(' · ');
        const unallied = s.unalliedClaims ? `${named ? ' · ' : ''}<span class="text-muted-foreground">${s.unalliedClaims} unallied</span>` : '';
        const who = named || unallied ? '' : '<span class="text-muted-foreground/50">—</span>';
        // An old "last looked" is the whole point of the column: it says how much this row
        // is worth, and a system nobody has scanned in a week may already be full.
        const ageClass = s.oldestObservationHours > 72 ? 'text-aw-warning' : 'text-muted-foreground';
        return `<tr class="hover:bg-white/5">
            <td class="p-2 text-foreground">[${s.system_id}] ${esc(s.name || '—')}</td>
            <td class="p-2 text-right text-foreground">${s.freePlanets || ''}</td>
            <td class="p-2 text-right ${ageClass}">${esc(fmtAge(s.oldestObservationHours))}</td>
            <td class="p-2 text-right text-muted-foreground">${s.distance === null ? '—' : s.distance.toFixed(1)}</td>
            <td class="p-2 text-right text-muted-foreground">${s.recentClaims || ''}</td>
            <td class="p-2 text-muted-foreground">${named}${unallied}${who}</td>
        </tr>`;
    }).join('');
}

function renderSpark() {
    const host = document.getElementById('land-rush-spark');
    if (!host || !data) return;
    const days = data.rate.ratedDays && data.rate.ratedDays.length ? data.rate.ratedDays : data.rate.days;
    if (!days.length) { host.innerHTML = '<div class="text-xs text-muted-foreground">No claims recorded in this window.</div>'; return; }
    const peak = Math.max(...days.map(d => d.claims), 1);
    host.innerHTML = `<div class="flex items-end gap-1 h-24">` + days.map(d => `
        <div class="flex-1 flex flex-col items-center justify-end h-full" title="${esc(d.date)}: ${d.claims} claimed">
            <div class="w-full rounded-sm bg-aw-warning/70" style="height:${Math.max(2, (d.claims / peak) * 100)}%"></div>
            <div class="text-[9px] text-muted-foreground mt-1">${esc(d.date.slice(8))}</div>
        </div>`).join('') + '</div>';
}

function renderContested() {
    const host = document.getElementById('land-rush-contested');
    if (!host || !data) return;
    if (!data.contested.length) { host.innerHTML = '<span class="text-muted-foreground">Nobody is settling the same system as anyone else.</span>'; return; }
    host.innerHTML = data.contested.slice(0, 10).map(s => `
        <div><span class="text-foreground">[${s.system_id}] ${esc(s.name || '—')}</span>
        <span class="text-muted-foreground"> — ${s.claimingTags.map(t => `${esc(t.tag)} ${t.claims}`).join(' vs ')}</span></div>`).join('');
}

function renderConquests() {
    const host = document.getElementById('land-rush-conquests');
    if (!host || !data) return;
    const rows = data.conquests.filter(c => c.planets > 0).slice(0, 10);
    if (!rows.length) { host.innerHTML = '<span class="text-muted-foreground">No planet changed hands in this window.</span>'; return; }
    host.innerHTML = rows.map(c => `
        <div><span class="text-muted-foreground">${esc(c.from_tag || 'unallied')}</span>
        <span class="text-muted-foreground/60"> → </span>
        <span class="text-foreground">${esc(c.to_tag || 'unallied')}</span>
        <span class="text-muted-foreground"> ${c.planets}</span></div>`).join('');
}

async function load() {
    const status = document.getElementById('land-rush-status');
    const days = document.getElementById('land-rush-days')?.value || '7';
    const freshHours = document.getElementById('land-rush-fresh')?.value || '72';
    if (status) status.textContent = 'reading the owner-change log...';
    try {
        const res = await fetch(`/hub-api/intel/land-rush?days=${encodeURIComponent(days)}&freshHours=${encodeURIComponent(freshHours)}`);
        const body = await res.json();
        if (!body.success) throw new Error(body.error || 'failed');
        data = body;
        renderHeadline();
        renderFrontier();
        renderSpark();
        renderContested();
        renderConquests();
        if (status) {
            status.textContent = `${data.frontierSystems} systems`
                + (data.origin ? ` · distances from our ${data.origin.planets} planets` : ' · no home centre known, distances hidden');
        }
    } catch (err) {
        if (status) status.textContent = 'failed to load';
    }
}

function closeSiblings(exceptId) {
    document.querySelectorAll('#dynamic-panels-container > div').forEach(el => {
        if (el.id !== exceptId) el.classList.replace('translate-x-0', 'translate-x-full');
    });
}

export async function openLandRushPanel() {
    let panel = document.getElementById('land-rush-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/land-rush.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('land-rush-panel');
        panel.querySelector('#land-rush-close-btn')?.addEventListener('click', () => {
            panel.classList.replace('translate-x-0', 'translate-x-full');
        });
        panel.querySelector('#land-rush-search')?.addEventListener('input', renderFrontier);
        panel.querySelector('#land-rush-days')?.addEventListener('change', load);
        panel.querySelector('#land-rush-fresh')?.addEventListener('change', load);
    }
    closeSiblings('land-rush-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    await load();
}
