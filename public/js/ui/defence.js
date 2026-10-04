// Defence panel + the live-incoming warning (2026-10-04).
//
// The Discord alert is a snapshot: posted once, never edited, top 3 ways to keep the
// planet and top 3 to retake it. This panel is the live side of it — every option of every
// member, recomputed by the server each time it is opened or refreshed
// (GET /hub-api/defence/attack, src/routes/incoming.js), with the viewer's own options
// first.
//
// The warning: while an attack is live the sidebar's Defence button (and, on a phone, the
// menu button that opens the sidebar) blinks red, and a slim banner names the attack. The
// banner can be dismissed per attack. Nothing here ever opens the panel by itself: it
// opens from the sidebar, the banner, or a Discord link someone tapped (?defence=<key>).
//
// Live (src/utils/defence-live.js): while the panel shows an attack it holds one event
// stream on it. "viewers" says who else has it open; "plan" carries the before/after
// choices and the covering roster, pushed the moment anyone changes them — here, on the
// Discord button or on the News page.

const POLL_MS = 60 * 1000;
const PANEL_REFRESH_MS = 60 * 1000;
const SEEN_KEY = 'awt.defence.seen';
const SRC = { orbit: '🛰️', flight: '✈️', build: '🏗️' };

let liveAttacks = [];
let serverOffset = 0;       // server clock minus ours, from the last poll
let selectedKey = null;
let panelTimer = null;
let stream = null, streamKey = null;
let liveViewers = null;      // from the stream; null until the first event
let livePlan = null;         // { choices, covering } from the stream
let lastDetail = null;       // the last full analysis, re-painted when the plan changes

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowSec = () => Math.floor(Date.now() / 1000) + serverOffset;
const clock = (unix) => (unix ? new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const num = (n) => Math.round(n || 0).toLocaleString();

function untilText(unix) {
    const s = unix - nowSec();
    if (s <= 0) return 'landed';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `in ${h}h ${m}m` : `in ${m}m`;
}

function hms(sec) {
    if (sec == null) return '—';
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function shipsText(ships) {
    const s = ships || {};
    const parts = [];
    if (s.transports) parts.push(`${s.transports} TR`);
    if (s.colony) parts.push(`${s.colony} CO`);
    if (s.destroyers) parts.push(`${s.destroyers} DS`);
    if (s.cruisers) parts.push(`${s.cruisers} CR`);
    if (s.battleships) parts.push(`${s.battleships} BS`);
    return parts.join(', ') || 'no ships reported';
}
const fleetArr = (f) => (Array.isArray(f) ? ['DS', 'CR', 'BS'].map((n, i) => (f[i] ? `${f[i]} ${n}` : null)).filter(Boolean).join(', ') : '');
const planetLabel = (a) => `${esc(a.target.planetName || 'Planet')} <span class="text-muted-foreground">[${esc(a.target.systemId)}] #${esc(a.target.planetIndex)}</span>`;

// ─── Seen attacks (per viewer) ───────────────────────────────────────────────
// An attack is "seen" once the member opened the Defence panel while it was live (the
// panel lists every live attack) or closed its banner. Seen attacks stop the blinking and
// the banner; the red count pill stays while any attack is live. A NEW attack blinks again.
function readSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function markSeen(keys) {
    const set = readSeen();
    keys.forEach(k => set.add(k));
    // Only live keys are worth keeping; old ones would grow the list forever.
    const keep = [...set].filter(k => keys.includes(k) || liveAttacks.some(a => a.key === k));
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(keep)); } catch (e) { /* private window */ }
    updateAlarm();
}

// ─── The warning ─────────────────────────────────────────────────────────────
function ensureAlarmStyle() {
    if (document.getElementById('defence-alarm-style')) return;
    const st = document.createElement('style');
    st.id = 'defence-alarm-style';
    st.textContent = `
        @keyframes awtDefenceBlink { 0%, 100% { color: #f87171; background: rgba(127, 29, 29, .55); } 50% { color: #fecaca; background: transparent; } }
        .awt-defence-alarm { animation: awtDefenceBlink 1.2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .awt-defence-alarm { animation: none; color: #f87171; background: rgba(127, 29, 29, .55); } }`;
    document.head.appendChild(st);
}

// The red count pill: on the sidebar icon (visible even when the sidebar is collapsed) and
// on the phone's menu button. Created here so Wrapper.html stays a plain template.
function pill(host, id, place) {
    if (!host) return null;
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('span');
        el.id = id;
        el.className = `hidden absolute ${place} min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold leading-4 text-center pointer-events-none`;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(el);
    }
    return el;
}

function updateAlarm() {
    ensureAlarmStyle();
    const live = liveAttacks.filter(a => a.arrivalUnix > nowSec() - 240);
    const seen = readSeen();
    const unseen = live.filter(a => !seen.has(a.key));
    const blink = unseen.length > 0;
    document.getElementById('open-defence-btn')?.classList.toggle('awt-defence-alarm', blink);
    document.getElementById('mobile-trigger')?.classList.toggle('awt-defence-alarm', blink);
    const icon = document.querySelector('#open-defence-btn > i');
    for (const el of [pill(icon, 'defence-pill', '-top-2.5 -right-3'), pill(document.getElementById('mobile-trigger'), 'defence-pill-mobile', '-top-1.5 -right-1.5')]) {
        if (!el) continue;
        el.textContent = live.length ? String(live.length) : '';
        el.classList.toggle('hidden', !live.length);
    }

    const banner = document.getElementById('defence-banner');
    if (!banner) return;
    const next = unseen[0];
    if (!next) { banner.classList.add('hidden'); banner.classList.remove('flex'); return; }
    const more = unseen.length > 1 ? ` · +${unseen.length - 1} more` : '';
    banner.querySelector('#defence-banner-open').innerHTML =
        `🚨 <b>${esc(next.attacker.name)}</b> → ${esc(next.target.planetName || 'planet')} [${esc(next.target.systemId)}] #${esc(next.target.planetIndex)}`
        + `${next.ownerName ? ` (${esc(next.ownerName)})` : ''} · ${num(next.cv)} CV · lands ${untilText(next.arrivalUnix)}${more} · <u>open defence</u>`;
    banner.dataset.key = next.key;
    banner.classList.remove('hidden');
    banner.classList.add('flex');
}

async function poll() {
    try {
        const res = await fetch('/hub-api/defence/live');
        if (!res.ok) return;
        const d = await res.json();
        if (!d.success) return;
        serverOffset = d.nowUnix - Math.floor(Date.now() / 1000);
        liveAttacks = d.attacks || [];
        if (isOpen()) { renderList(); markSeen(liveAttacks.map(a => a.key)); } else updateAlarm();
    } catch (e) { /* offline for a moment — try again next tick */ }
}

export function initDefenceWatch() {
    document.getElementById('defence-banner-open')?.addEventListener('click', () => {
        openDefencePanel(document.getElementById('defence-banner')?.dataset.key || null);
    });
    document.getElementById('defence-banner-close')?.addEventListener('click', () => {
        const key = document.getElementById('defence-banner')?.dataset.key;
        if (key) markSeen([key]);
    });
    poll();
    setInterval(poll, POLL_MS);

    // A Discord link (…/dashboard?defence=<key>) — the member tapped it, so open on it.
    try {
        const key = new URLSearchParams(window.location.search).get('defence');
        if (key) {
            openDefencePanel(key);
            const url = new URL(window.location.href);
            url.searchParams.delete('defence');
            window.history.replaceState(null, '', url.toString());
        }
    } catch (e) { /* no URL API: the sidebar still works */ }
}

// ─── The panel ───────────────────────────────────────────────────────────────
const isOpen = () => document.getElementById('defence-panel')?.classList.contains('translate-x-0');

function closeSiblings(exceptId) {
    document.querySelectorAll('#dynamic-panels-container > div').forEach(el => {
        if (el.id !== exceptId) el.classList.replace('translate-x-0', 'translate-x-full');
    });
}

export async function openDefencePanel(key = null) {
    let panel = document.getElementById('defence-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/defence.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('defence-panel');
        panel.querySelector('#defence-close-btn')?.addEventListener('click', closePanel);
        panel.querySelector('#defence-refresh-btn')?.addEventListener('click', () => { poll(); loadDetail(); });
    }
    if (typeof key !== 'string') key = null;   // a click event, from the sidebar button
    if (isOpen() && !key) return closePanel();
    if (key) selectedKey = key;
    closeSiblings('defence-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    await poll();
    // The panel lists every live attack, so opening it means they have all been seen.
    markSeen(liveAttacks.map(a => a.key));
    if (!selectedKey || !liveAttacks.some(a => a.key === selectedKey)) {
        selectedKey = key || (liveAttacks[0] && liveAttacks[0].key) || null;
    }
    renderList();
    await loadDetail();
    clearInterval(panelTimer);
    panelTimer = setInterval(() => { if (isOpen()) loadDetail(); else clearInterval(panelTimer); }, PANEL_REFRESH_MS);
}

function closePanel() {
    document.getElementById('defence-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    clearInterval(panelTimer);
    closeStream();
}

// ─── Live stream ─────────────────────────────────────────────────────────────
function closeStream() {
    if (stream) stream.close();
    stream = null; streamKey = null; liveViewers = null; livePlan = null;
}

function connectStream(key) {
    if (streamKey === key && stream) return;
    closeStream();
    if (!key || typeof EventSource === 'undefined') return;
    streamKey = key;
    // EventSource reconnects by itself (the server asks for 5 s) if the line drops.
    stream = new EventSource(`/hub-api/defence/stream?key=${encodeURIComponent(key)}`);
    stream.addEventListener('viewers', (e) => {
        try { liveViewers = JSON.parse(e.data).viewers; } catch (err) { return; }
        paintLive();
    });
    stream.addEventListener('plan', (e) => {
        try { livePlan = JSON.parse(e.data); } catch (err) { return; }
        paint();
    });
}

// The plan as it stands: the stream's latest, else what the analysis came with.
const currentPlan = () => livePlan || (lastDetail ? { choices: lastDetail.choices || [], covering: lastDetail.covering || [] } : { choices: [], covering: [] });
const isMe = (name) => lastDetail && lastDetail.viewer && String(name).toLowerCase() === String(lastDetail.viewer).toLowerCase();

// Re-draw the whole detail from the last analysis (a plan change does not need the server
// to recompute anything), keeping open whichever member rows the viewer had opened.
function paint() {
    const box = document.getElementById('defence-detail');
    if (!box || !lastDetail || box.dataset.key !== lastDetail.key) return;
    const open = new Set([...box.querySelectorAll('details[data-member]')].filter(el => el.open).map(el => el.dataset.member));
    const first = !box.querySelector('details[data-member]');
    box.innerHTML = renderDetail(lastDetail);
    box.querySelectorAll('details[data-member]').forEach(el => {
        if (!first) el.open = open.has(el.dataset.member);
    });
    box.querySelectorAll('.defence-choose').forEach(b => b.addEventListener('click', () => choose(b.dataset.role, Number(b.dataset.idx))));
    box.querySelector('#defence-withdraw-btn')?.addEventListener('click', () => choose('none'));
    box.querySelector('#defence-cover-btn')?.addEventListener('click', () => cover(lastDetail));
    paintLive();
}

function paintLive() {
    const el = document.getElementById('defence-viewers');
    if (!el || !lastDetail) return;
    const names = liveViewers || lastDetail.viewers || [];
    const others = names.filter(n => !isMe(n));
    el.innerHTML = others.length
        ? `👀 Looking now: ${others.map(n => `<b>${esc(n)}</b>`).join(', ')}${names.some(isMe) ? ' and you' : ''}`
        : '👀 Only you are looking at this right now.';
}

async function choose(role, idx) {
    const d = lastDetail;
    if (!d) return;
    const mine = (d.members.find(m => m.me) || { options: [] }).options;
    const o = role === 'none' ? null : mine[idx];
    if (role !== 'none' && !o) return;
    const winText = o ? (role === 'before' ? (o.before && o.before.winText) : (o.after && o.after.winText)) : null;
    try {
        const res = await fetch('/hub-api/defence/choose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: d.key, role, option: o ? { source: o.source, cv: o.cv, eta: o.eta, note: o.note, winText } : null })
        });
        const r = await res.json();
        if (!r.success) throw new Error(r.error || 'failed');
        livePlan = { choices: r.choices, covering: r.covering };
        paint();
    } catch (e) {
        alert('Could not save your choice: ' + e.message);
    }
}

function renderList() {
    const el = document.getElementById('defence-list');
    if (!el) return;
    if (!liveAttacks.length) {
        el.innerHTML = '<div class="text-sm text-muted-foreground py-1">No live incomings. ✅</div>';
        return;
    }
    el.innerHTML = liveAttacks.map(a => `
        <button data-key="${esc(a.key)}" class="defence-pick shrink-0 text-left rounded-md border px-3 py-2 text-xs ${a.key === selectedKey ? 'border-red-500 bg-red-950/40' : 'border-border bg-zinc-900 hover:bg-zinc-800'}">
            <div class="font-semibold text-foreground">🚨 ${esc(a.attacker.name)} · ${num(a.cv)} CV</div>
            <div class="text-muted-foreground">${esc(a.target.planetName || 'Planet')} [${esc(a.target.systemId)}] #${esc(a.target.planetIndex)}${a.ownerName ? ` · ${esc(a.ownerName)}` : ''}</div>
            <div class="text-red-300">lands ${untilText(a.arrivalUnix)} · ${clock(a.arrivalUnix)}</div>
        </button>`).join('');
    el.querySelectorAll('.defence-pick').forEach(b => b.addEventListener('click', () => {
        selectedKey = b.dataset.key;
        renderList();
        loadDetail();
    }));
}

async function loadDetail() {
    const box = document.getElementById('defence-detail');
    if (!box) return;
    if (!selectedKey) { box.innerHTML = ''; return; }
    if (!box.dataset.key || box.dataset.key !== selectedKey) box.innerHTML = '<div class="text-muted-foreground">Computing every option…</div>';
    try {
        const res = await fetch(`/hub-api/defence/attack?key=${encodeURIComponent(selectedKey)}`);
        const d = await res.json();
        if (!d.success) { box.innerHTML = `<div class="text-red-400">${esc(d.error || 'Could not load this attack.')}</div>`; return; }
        box.dataset.key = selectedKey;
        lastDetail = d;
        connectStream(d.key);
        paint();
        const upd = document.getElementById('defence-updated');
        // Text only: the template keeps it hidden on a phone (hidden sm:inline), where the
        // header has no room for it.
        if (upd) upd.textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (e) {
        box.innerHTML = '<div class="text-red-400">Could not load this attack.</div>';
    }
}

function section(title, body) {
    return `<section class="mb-5"><h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">${title}</h3>${body}</section>`;
}

function rankedRows(list, role) {
    if (!list.length) return `<div class="text-muted-foreground">Nobody with a real chance (25%+).</div>`;
    return `<ol class="flex flex-col gap-1.5">${list.map((e, i) => {
        const when = role === 'keep'
            ? (e.launchBy ? `${e.eta === 0 ? 'build' : 'launch'} by <b>${clock(e.launchBy)}</b>` : '')
            : (e.launchBy ? `launch <b>${clock(e.launchFrom)}–${clock(e.launchBy)}</b>` : '');
        const how = role === 'keep' ? (e.mode === 'reinforce' ? 'own fleet + SB' : 'kills the SB first') : '';
        return `<li class="rounded-md bg-zinc-900 border border-border px-3 py-2">
            <div><span class="text-muted-foreground">${i + 1}.</span> ${SRC[e.source] || ''} <b>${esc(e.name)}</b> <span class="text-muted-foreground">[${num(e.cv)} CV]</span>
            · ${role === 'keep' ? 'holds' : 'retakes'} <b class="${e.win >= 0.75 ? 'text-green-400' : e.win >= 0.5 ? 'text-yellow-300' : 'text-orange-400'}">${esc(e.winText)}</b>, keeps ${num(e.keepCv)} CV</div>
            <div class="text-xs text-muted-foreground mt-0.5">${[when, how, esc(e.note)].filter(Boolean).join(' · ')}</div>
        </li>`;
    }).join('')}</ol>`;
}

// Does a saved choice point at this option? (same source, CV and ETA)
const sameOption = (c, o) => c && c.option && c.option.source === o.source && c.option.cv === Math.round(o.cv) && c.option.eta === Math.round(o.eta);

function optionRow(o, d, idx, mine) {
    const w = d.window;
    const T = d.arrivalUnix ? d.arrivalUnix - d.nowUnix : null;
    const canBefore = T == null || o.eta < T;
    const canAfter = !w || o.eta <= w.cycleEnd - d.nowUnix;
    const pctCls = (p) => (p >= 0.75 ? 'text-green-400' : p >= 0.5 ? 'text-yellow-300' : p >= 0.25 ? 'text-orange-400' : 'text-red-400');
    const before = o.before
        ? (canBefore ? `${o.before.own ? 'holds with own SB' : 'before'}: <b class="${pctCls(o.before.win)}">${o.before.win < 0.005 ? 'fails' : esc(o.before.winText)}</b>${o.before.win >= 0.005 ? `, keeps ${num(o.before.keepCv)}` : ''}` : '<span class="text-muted-foreground">before: too late</span>')
        : '';
    const after = o.after
        ? (canAfter ? `after: <b class="${pctCls(o.after.win)}">${esc(o.after.winText)}</b>${o.after.win > 0 ? `, keeps ${num(o.after.keepCv)}` : ''}` : '<span class="text-muted-foreground">after: too late</span>')
        : '';
    const ships = fleetArr(o.ships);
    // Your own options carry the buttons; a saved choice is marked on the option it names.
    const myChoice = mine ? currentPlan().choices.find(c => isMe(c.name)) : null;
    const chosen = sameOption(myChoice, o) ? myChoice.role : null;
    const btn = (role, label) => `<button class="defence-choose h-7 px-2.5 rounded-md text-xs ${chosen === role ? 'bg-sky-700 text-white' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}" data-role="${role}" data-idx="${idx}">${chosen === role ? '✓ ' : ''}${label}</button>`;
    const buttons = mine ? [
        o.before && canBefore && o.before.win >= 0.005 ? btn('before', o.before.own ? "🛡️ I'll land before (with my SB)" : "🛡️ I'll land before") : '',
        o.after && canAfter && o.after.win > 0 ? btn('after', "⚔️ I'll land after") : '',
    ].filter(Boolean).join('') : '';
    return `<div class="rounded-md bg-zinc-900/60 border ${chosen ? 'border-sky-600' : 'border-border'} px-3 py-2 ${!canBefore && !canAfter ? 'opacity-50' : ''}">
        <div>${SRC[o.source] || ''} <b>${num(o.cv)} CV</b> <span class="text-muted-foreground">${esc(ships)}</span> · ETA ${hms(o.eta)}</div>
        <div class="mt-0.5">${[before, after].filter(Boolean).join(' · ') || '<span class="text-muted-foreground">no battle numbers</span>'}</div>
        ${o.note ? `<div class="text-xs text-muted-foreground mt-0.5">${esc(o.note)}</div>` : ''}
        ${buttons ? `<div class="mt-1.5 flex flex-wrap gap-1.5">${buttons}</div>` : ''}
    </div>`;
}

function renderDetail(d) {
    const w = d.window;
    const head = `
        <div class="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 mb-5">
            <div class="text-base font-bold">🚨 ${esc(d.attacker.name)}${d.attacker.tag ? ` <span class="text-muted-foreground">[${esc(d.attacker.tag)}]</span>` : ''} → ${planetLabel(d)}</div>
            ${d.ownerName ? `<div class="mt-0.5">🎯 ${esc(d.ownerName)}</div>` : ''}
            <div class="mt-0.5">🛰️ <b>${num(d.cv)} CV</b> — ${esc(shipsText(d.ships))}</div>
            <div class="mt-0.5 text-muted-foreground">🧬 ${d.attacker.scanned
                ? `${esc(d.attacker.statLine || '')}${d.attacker.raceKnown ? '' : ' — race unknown, worst case assumed (+4/+4)'}`
                : 'never scanned — worst case assumed (+4 attack, +4 defence)'}</div>
            <div class="mt-1">🕐 lands <b>${clock(d.arrivalUnix)}</b> (${untilText(d.arrivalUnix)})${w ? ` · can leave from <b>${clock(w.cycleEnd + 1)}</b>` : ''}</div>
        </div>`;
    if (!d.mapped) return head + '<div class="text-yellow-300">⚠️ Target system not mapped — cannot compute defenders.</div>';

    let planet = '';
    if (d.planet) {
        const p = d.planet;
        const sb = p.sbLevel > 0 ? `SB ${p.sbLevel}` : 'no starbase';
        const garrison = p.garrisonCv > 0 ? ` + ${num(p.garrisonCv)} CV fleet` : '';
        planet = p.holdsAlone
            ? `<div class="text-green-400 font-semibold">🏰 Holds on its own — ${sb}${garrison}: ${esc(p.holdsText)}. No help needed.</div>`
            : `<div>🏰 <b>Planet alone</b> — ${sb}${garrison}: ${esc(p.outcomeText)}</div>`;
        if (d.sbOptions && d.sbOptions.length && !p.holdsAlone) {
            const from = d.sbBudget && d.sbBudget.fromHome ? "all the owner's planets' PP (home)" : 'the PP saved on this planet';
            planet += `<div class="mt-2 text-xs text-muted-foreground">Starbase levels ${from} reaches by arrival:</div>
                <div class="mt-1 flex flex-col gap-1">${d.sbOptions.map(o => `
                    <div class="rounded bg-zinc-900/60 border border-border px-3 py-1.5 text-xs">
                        <b>SB ${o.level}</b> · ${num(o.cost)} PP · ${o.holds >= 0.995 ? `<b class="text-green-400">holds ${esc(o.holdsText)}</b>` : `holds ${esc(o.holdsText)} · enemy keeps ${esc(o.enemyLeftText)}`}
                    </div>`).join('')}</div>`;
        }
    } else {
        planet = '<div class="text-muted-foreground">🏰 Planet not scanned — its starbase is unknown; options below fight the full fleet.</div>';
    }

    let html = head + planBlock(d) + section('The planet', planet);
    if (d.planet && d.planet.holdsAlone) return html;

    html += section(`🛡️ Keep it — land before ${clock(d.arrivalUnix)}`, rankedRows(d.keep, 'keep'));
    html += section(`⚔️ Retake it — land ${w ? `${clock(w.arrival)}–${clock(w.cycleEnd)}` : 'right after them'}, same cycle`, rankedRows(d.retake, 'retake'));

    // A member's best chances among options that make it in time, for the collapsed row —
    // with 15-20 members nobody should have to open every row to find the useful ones.
    const T = d.arrivalUnix ? d.arrivalUnix - d.nowUnix : null;
    const bestLine = (m) => {
        let keep = 0, retake = 0;
        for (const o of m.options) {
            if (o.before && (T == null || o.eta < T)) keep = Math.max(keep, o.before.win);
            if (o.after && (!w || o.eta <= w.cycleEnd - d.nowUnix)) retake = Math.max(retake, o.after.win);
        }
        // Same rounding as the server's pct(): "almost certain" never reads as 100%.
        const p = v => { const x = v * 100; return x > 99 && x < 100 ? `${Math.floor(x * 10) / 10}%` : `${Math.round(x)}%`; };
        if (!keep && !retake) return '<span class="text-muted-foreground"> · no real chance</span>';
        return ` · best: keep <b>${p(keep)}</b> · retake <b>${p(retake)}</b>`;
    };
    const members = d.members.map(m => `
        <details data-member="${esc(m.name)}" class="mb-2 rounded-md border ${m.me ? 'border-sky-700' : 'border-border'}" ${m.me ? 'open' : ''}>
            <summary class="cursor-pointer px-3 py-2 ${m.me ? 'bg-sky-950/40' : 'bg-zinc-900'} rounded-md"><b>${esc(m.name)}</b>${m.me ? ' (you)' : ''}${bestLine(m)} <span class="text-muted-foreground">· ${m.options.length} option${m.options.length === 1 ? '' : 's'}</span></summary>
            <div class="p-2 flex flex-col gap-1.5">${m.options.map((o, i) => optionRow(o, d, i, m.me)).join('')}</div>
        </details>`).join('');
    html += section('Every option, by member', members || '<div class="text-muted-foreground">No member fleets or saved PP found.</div>');
    return html;
}

// Who is doing what: the before/after choices, then anyone covering without picking an
// option (Discord button, News page). Live — re-painted on every "plan" event.
function planBlock(d) {
    const plan = currentPlan();
    const ago = (ts) => {
        const ms = ts ? Date.parse(String(ts).replace(' ', 'T') + 'Z') : NaN;
        if (!Number.isFinite(ms)) return '';
        const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
        return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
    };
    const rows = plan.choices.map(c => {
        const o = c.option || {};
        const bits = [o.cv != null ? `${num(o.cv)} CV` : '', o.winText ? `${c.role === 'before' ? 'holds' : 'retakes'} ${esc(o.winText)}` : '', esc(o.note || ''), ago(c.updatedAt)].filter(Boolean);
        return `<div class="${isMe(c.name) ? 'text-sky-300' : ''}">${c.role === 'before' ? '🛡️' : '⚔️'} <b>${esc(c.name)}</b> — lands <b>${esc(c.role)}</b> them${bits.length ? ` <span class="text-muted-foreground">· ${bits.join(' · ')}</span>` : ''}</div>`;
    });
    const picked = new Set(plan.choices.map(c => c.name.toLowerCase()));
    plan.covering.filter(n => !picked.has(n.toLowerCase())).forEach(n => rows.push(`<div>🛡️ <b>${esc(n)}</b> — covering <span class="text-muted-foreground">· no option picked</span></div>`));
    const meIn = plan.choices.some(c => isMe(c.name)) || plan.covering.some(isMe);
    const action = meIn
        ? '<button id="defence-withdraw-btn" class="h-8 px-3 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 text-sm">Withdraw</button>'
        : '<button id="defence-cover-btn" class="h-8 px-3 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 text-sm">I cover this</button><span class="text-xs text-muted-foreground">or pick one of your options below</span>';
    return `<section class="mb-5 rounded-lg border border-sky-900 bg-sky-950/20 px-4 py-3">
        <div id="defence-viewers" class="text-xs text-muted-foreground mb-2"></div>
        <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">🛡️ Defence plan</h3>
        <div class="flex flex-col gap-1">${rows.length ? rows.join('') : '<div class="text-muted-foreground">Nobody has said yet.</div>'}</div>
        <div class="mt-2 flex items-center gap-2 flex-wrap">${action}</div>
    </section>`;
}

async function cover(d) {
    try {
        const res = await fetch('/hub-api/incoming/cover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attacker: d.attacker, target: d.target, ships: d.ships, arrivalUnix: d.arrivalUnix || 0 })
        });
        const r = await res.json();
        if (!r.success) throw new Error(r.error || 'failed');
        livePlan = { choices: (livePlan || currentPlan()).choices, covering: r.covering };
        paint();
    } catch (e) {
        alert('Cover failed: ' + e.message);
    }
}
