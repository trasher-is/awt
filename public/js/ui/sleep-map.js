// Sleep Map panel — the roster's hour-of-day activity, drawn in the viewer's local time.
//
// The server (GET /hub-api/intel/sleep-map, src/utils/sleep-map.js) does every bit of the
// analysis and answers in UTC hours plus epoch timestamps. This file only rotates those 24
// buckets into the viewer's own clock and paints them, because the one thing the server
// genuinely cannot know is what time it is where the member is sitting.
//
// The rotation is by whole hours. A zone on a half-hour offset (India, parts of Australia)
// therefore reads up to 30 minutes off, and a DST change inside the window smears one
// column by an hour. Both are visible in the tooltip, which always states the UTC hour the
// number actually came from, so nobody plans a launch off a rounded label alone — the
// launch times under "best launch" are exact instants, not hour labels.
import { esc } from '../utils/escape.js';

let rows = [];
let meta = { days: 14, travelHours: null, generatedAt: 0 };

// Local hour -> the UTC hour whose bucket it is. getTimezoneOffset() is UTC-minus-local in
// minutes (CEST = -120), so UTC = local + offset/60.
function utcHourFor(localHour) {
    const shift = Math.round(new Date().getTimezoneOffset() / 60);
    return ((localHour + shift) % 24 + 24) % 24;
}

function localHourNow() {
    return new Date().getHours();
}

// Away-ness to colour. Deliberately not a continuous gradient: five steps read as five
// states at a glance, and the middle one is grey because "no idea" should not look like
// a decision.
function cellColour(score, observed) {
    if (!observed) return '#18181b';
    if (score >= 0.9) return '#22c55e';
    if (score >= 0.7) return '#166534';
    if (score >= 0.4) return '#3f3f46';
    if (score >= 0.2) return '#b45309';
    return '#7f1d1d';
}

function fmtClock(ms) {
    const d = new Date(ms);
    const day = d.toDateString() === new Date().toDateString() ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} `;
    return `${day}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A UTC hour range printed on the viewer's clock.
function fmtUtcRange(startHour, endHour) {
    const shift = Math.round(new Date().getTimezoneOffset() / 60);
    const toLocal = h => ((h - shift) % 24 + 24) % 24;
    return `${String(toLocal(startHour)).padStart(2, '0')}:00–${String(toLocal(endHour)).padStart(2, '0')}:00`;
}

function renderHead() {
    const head = document.getElementById('sleep-map-head');
    if (!head) return;
    const nowLocal = localHourNow();
    const hourCells = Array.from({ length: 24 }, (_, localHour) => {
        const isNow = localHour === nowLocal;
        return `<th class="px-0 py-2 text-center font-normal ${isNow ? 'text-foreground' : 'text-muted-foreground/60'}" style="width:18px">${String(localHour).padStart(2, '0')}</th>`;
    }).join('');
    head.innerHTML = `
        <th class="px-3 py-2">Player</th>
        <th class="px-2 py-2">Tag</th>
        <th class="px-2 py-2 text-right">Away now</th>
        <th class="px-2 py-2">Quiet for</th>
        ${hourCells}
        <th class="px-2 py-2">Usually away</th>
        <th class="px-3 py-2">Best launch</th>`;
}

function renderBody() {
    const body = document.getElementById('sleep-map-body');
    if (!body) return;

    const needle = (document.getElementById('sleep-map-search')?.value || '').trim().toLowerCase();
    const tag = document.getElementById('sleep-map-alliance')?.value || '';
    const shown = rows.filter(r => {
        if (tag && (r.tag || '') !== tag) return false;
        if (!needle) return true;
        return r.name.toLowerCase().includes(needle) || (r.tag || '').toLowerCase().includes(needle);
    });

    if (!shown.length) {
        body.innerHTML = '<tr><td colspan="30" class="text-center py-8 text-muted-foreground">No player matches.</td></tr>';
        return;
    }

    const nowLocal = localHourNow();
    body.innerHTML = shown.map(r => {
        const cells = Array.from({ length: 24 }, (_, localHour) => {
            const utcHour = utcHourFor(localHour);
            const score = r.scores[utcHour];
            const observed = r.observed[utcHour];
            const title = observed
                ? `${r.name} — ${String(localHour).padStart(2, '0')}:00 local (${String(utcHour).padStart(2, '0')}:00 UTC): away on ${observed - r.active[utcHour]} of ${observed} observed days`
                : `${r.name} — ${String(localHour).padStart(2, '0')}:00 local: never covered by a scan`;
            const border = localHour === nowLocal ? 'outline:1px solid #e4e4e7;outline-offset:-1px;' : '';
            return `<td class="p-0" title="${esc(title)}"><div style="height:16px;background:${cellColour(score, observed)};${border}"></div></td>`;
        }).join('');

        const trough = r.trough
            ? `<span title="mean away-score ${r.trough.meanScore.toFixed(2)} over ${r.trough.hours}h">${fmtUtcRange(r.trough.startHour, r.trough.endHour)}</span>`
            : '<span class="text-muted-foreground/50">no clear window</span>';

        const launch = (r.launchWindows || []).length
            ? r.launchWindows.map(w => `<span title="lands ${fmtClock(w.arriveAt)}, away on ${w.observedDays - 0} observed days at that hour">${fmtClock(w.launchAt)}</span>`).join(' · ')
            : '<span class="text-muted-foreground/40">—</span>';

        const quietFor = r.quietForHours === null ? '—' : `${r.quietForHours}h`;
        const nowScore = r.currentScore;
        const nowClass = nowScore >= 0.8 ? 'text-green-400' : nowScore <= 0.2 ? 'text-red-400' : 'text-muted-foreground';

        return `<tr class="hover:bg-white/5">
            <td class="px-3 py-1 whitespace-nowrap text-foreground">${esc(r.name)}${r.resigned ? ' <span class="text-muted-foreground/50">(resigned)</span>' : ''}</td>
            <td class="px-2 py-1 text-muted-foreground">${esc(r.tag || '')}</td>
            <td class="px-2 py-1 text-right ${nowClass}">${Math.round(nowScore * 100)}%</td>
            <td class="px-2 py-1 text-muted-foreground">${quietFor}</td>
            ${cells}
            <td class="px-2 py-1 whitespace-nowrap">${trough}</td>
            <td class="px-3 py-1 whitespace-nowrap text-muted-foreground">${launch}</td>
        </tr>`;
    }).join('');
}

function fillAllianceFilter() {
    const select = document.getElementById('sleep-map-alliance');
    if (!select) return;
    const chosen = select.value;
    const tags = [...new Set(rows.map(r => r.tag).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All alliances</option>' + tags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if (tags.includes(chosen)) select.value = chosen;
}

async function load() {
    const status = document.getElementById('sleep-map-status');
    const body = document.getElementById('sleep-map-body');
    const days = document.getElementById('sleep-map-days')?.value || '14';
    const travel = (document.getElementById('sleep-map-travel')?.value || '').trim();

    if (body) body.innerHTML = '<tr><td colspan="30" class="text-center py-8 text-muted-foreground"><i class="fa-solid fa-circle-notch fa-spin"></i> Reading the scan history...</td></tr>';
    if (status) status.textContent = 'loading...';

    try {
        const query = new URLSearchParams({ days });
        if (travel !== '') query.set('travel', travel);
        const res = await fetch(`/hub-api/intel/sleep-map?${query}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'failed');
        rows = data.players;
        meta = { days: data.days, travelHours: data.travelHours, generatedAt: data.generatedAt };
        fillAllianceFilter();
        renderHead();
        renderBody();
        if (status) {
            status.textContent = `${rows.length} players · ${meta.days}d`
                + (meta.travelHours === null ? '' : ` · travel ${meta.travelHours}h`);
        }
    } catch (err) {
        if (body) body.innerHTML = '<tr><td colspan="30" class="text-center py-8 text-red-500">Failed to load the sleep map.</td></tr>';
        if (status) status.textContent = 'error';
    }
}

// Panels live in one container and slide over each other; closing the others keeps that
// behaviour without reaching into archives.js's hardcoded list, which this panel is
// deliberately not part of.
function closeSiblings(exceptId) {
    document.querySelectorAll('#dynamic-panels-container > div').forEach(el => {
        if (el.id !== exceptId) el.classList.replace('translate-x-0', 'translate-x-full');
    });
}

export async function openSleepMapPanel() {
    let panel = document.getElementById('sleep-map-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/sleep-map.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('sleep-map-panel');
        panel.querySelector('#sleep-map-close-btn')?.addEventListener('click', () => {
            panel.classList.replace('translate-x-0', 'translate-x-full');
        });
        panel.querySelector('#sleep-map-search')?.addEventListener('input', renderBody);
        panel.querySelector('#sleep-map-alliance')?.addEventListener('change', renderBody);
        panel.querySelector('#sleep-map-reload')?.addEventListener('click', load);
        panel.querySelector('#sleep-map-travel')?.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');
    closeSiblings('sleep-map-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    await load();
}
