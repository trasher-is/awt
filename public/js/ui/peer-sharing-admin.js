// Admin -> Peer Sharing: whom we share with, and whom we read from.
// Server side: src/routes/peers.js. Design: docs/peer-sharing.md.
//
// Partner names, addresses and errors are typed by admins or returned by other hubs, so
// everything that reaches innerHTML goes through esc()/escAttr().
import { esc, escAttr } from '../utils/escape.js';

const $ = id => document.getElementById(id);
let kinds = [];

function status(text, bad = false) {
    const el = $('peer-status');
    if (!el) return;
    el.textContent = text;
    el.className = `text-xs ${bad ? 'text-red-400' : 'text-muted-foreground'}`;
}

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

const when = ts => (ts ? `${esc(ts)} UTC` : 'never');

function scopeBoxes(selected, attrs) {
    return kinds.map(k => `
        <label class="flex items-center gap-1.5">
            <input type="checkbox" ${attrs} value="${escAttr(k.key)}" ${selected.includes(k.key) ? 'checked' : ''}>
            <span>${esc(k.label)}</span>
        </label>`).join('');
}

function renderLinks(links) {
    const el = $('peer-links');
    if (!links.length) { el.innerHTML = '<p class="text-xs">Not sharing with anyone yet.</p>'; return; }
    el.innerHTML = links.map(l => `
        <div class="border border-border rounded-md p-3 mb-2 flex flex-col gap-2 ${l.enabled ? '' : 'opacity-60'}" data-link="${escAttr(l.id)}">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-foreground font-semibold">${esc(l.name)} <span class="text-xs text-muted-foreground font-mono">…${esc(l.tokenHint)}</span></div>
                <div class="text-xs">Last read: ${when(l.lastReadAt)} · ${esc(l.readCount)} reads</div>
            </div>
            <div class="flex flex-wrap gap-3 text-sm">${scopeBoxes(l.scopes, 'data-scope')}</div>
            <div class="flex flex-wrap items-center gap-3 text-xs">
                <label class="flex items-center gap-1.5"><input type="checkbox" data-friendly ${l.excludeFriendly ? 'checked' : ''}> Hide our alliance and allies</label>
                <input type="text" data-tags value="${escAttr(l.excludeTags.join(', '))}" placeholder="Also hide tags" class="h-8 w-48 rounded-md border border-input bg-transparent px-2 font-mono">
                <button data-save-tags class="h-8 px-3 rounded-md border border-border hover:bg-secondary">Save tags</button>
                <button data-toggle class="h-8 px-3 rounded-md border border-border hover:bg-secondary">${l.enabled ? 'Pause' : 'Resume'}</button>
                <button data-revoke class="h-8 px-3 rounded-md border border-destructive/50 text-red-400 hover:bg-destructive/20">Revoke</button>
            </div>
        </div>`).join('');
}

function renderSources(sources) {
    const el = $('peer-sources');
    if (!sources.length) { el.innerHTML = '<p class="text-xs">Not reading from anyone yet.</p>'; return; }
    el.innerHTML = sources.map(s => {
        const health = s.lastError
            ? `<span class="text-red-400">Last pull failed: ${esc(s.lastError)}</span>`
            : (s.lastOkAt ? `<span class="text-green-400">OK</span> · last success ${when(s.lastOkAt)}` : 'Not pulled yet');
        const offered = Array.isArray(s.offeredKinds) && s.offeredKinds.length
            ? s.offeredKinds.map(k => esc((kinds.find(x => x.key === k) || {}).label || k)).join(', ')
            : '—';
        return `
        <div class="border border-border rounded-md p-3 mb-2 flex flex-col gap-1 ${s.enabled ? '' : 'opacity-60'}" data-source="${escAttr(s.id)}">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-foreground font-semibold">${esc(s.name)} <span class="text-xs text-muted-foreground font-mono">${esc(s.baseUrl)}</span></div>
                <div class="flex gap-2 text-xs">
                    <button data-pull class="h-8 px-3 rounded-md border border-border hover:bg-secondary">Pull now</button>
                    <button data-toggle class="h-8 px-3 rounded-md border border-border hover:bg-secondary">${s.enabled ? 'Pause' : 'Resume'}</button>
                    <button data-remove class="h-8 px-3 rounded-md border border-destructive/50 text-red-400 hover:bg-destructive/20">Remove</button>
                </div>
            </div>
            <div class="text-xs">${health}</div>
            <div class="text-xs">They share: ${offered} · ${esc(s.itemCount)} items held</div>
        </div>`;
    }).join('');
}

async function load() {
    try {
        const data = await api('GET', '/hub-api/admin/peers');
        kinds = data.kinds;
        $('peer-link-scopes').innerHTML = scopeBoxes([], 'data-new-scope');
        renderLinks(data.links);
        renderSources(data.sources);
    } catch (err) {
        // Not an admin (the page redirects them anyway) or the server is older than this file.
        if ($('peer-links')) $('peer-links').textContent = `Could not load: ${err.message}`;
    }
}

async function createLink() {
    const scopes = [...document.querySelectorAll('[data-new-scope]:checked')].map(b => b.value);
    try {
        const data = await api('POST', '/hub-api/admin/peers/links', {
            name: $('peer-link-name').value,
            scopes,
            excludeFriendly: $('peer-link-friendly').checked,
            excludeTags: $('peer-link-tags').value,
        });
        const box = $('peer-link-token');
        box.classList.remove('hidden');
        box.innerHTML = `
            <div class="font-bold text-amber-300 mb-1">Send these two things to ${esc(data.link.name)} privately. The token is shown only now.</div>
            <div>Hub address: <code class="select-all">${esc(location.origin)}</code></div>
            <div class="mt-1">Token: <code class="select-all break-all">${esc(data.token)}</code></div>
            <button id="peer-token-copy" class="mt-2 h-8 px-3 rounded-md border border-border hover:bg-secondary">Copy both</button>`;
        $('peer-token-copy').addEventListener('click', () => {
            navigator.clipboard?.writeText(`${location.origin}\n${data.token}`);
        });
        $('peer-link-name').value = '';
        $('peer-link-tags').value = '';
        await load();
    } catch (err) {
        status(err.message, true);
    }
}

async function addSource() {
    try {
        const data = await api('POST', '/hub-api/admin/peers/sources', {
            name: $('peer-source-name').value,
            baseUrl: $('peer-source-url').value,
            token: $('peer-source-token').value,
        });
        $('peer-source-name').value = '';
        $('peer-source-url').value = '';
        $('peer-source-token').value = '';
        status('Added. Pulling now…');
        await load();
        await pull(data.source.id);
    } catch (err) {
        status(err.message, true);
    }
}

async function pull(id) {
    try {
        const data = await api('POST', `/hub-api/admin/peers/sources/${id}/pull`);
        status(`Pulled: ${data.result.received} new or updated items.`);
    } catch (err) {
        status(`Pull failed: ${err.message}`, true);
    }
    await load();
}

async function onLinksClick(e) {
    const card = e.target.closest('[data-link]');
    if (!card) return;
    const id = card.dataset.link;
    try {
        if (e.target.matches('[data-revoke]')) {
            if (!confirm('Revoke this link? The partner loses access immediately. What they already received stays with them.')) return;
            await api('DELETE', `/hub-api/admin/peers/links/${id}`);
        } else if (e.target.matches('[data-toggle]')) {
            await api('PUT', `/hub-api/admin/peers/links/${id}`, { enabled: card.classList.contains('opacity-60') });
        } else if (e.target.matches('[data-save-tags]')) {
            await api('PUT', `/hub-api/admin/peers/links/${id}`, { excludeTags: card.querySelector('[data-tags]').value });
            status('Saved.');
        } else return;
        await load();
    } catch (err) { status(err.message, true); }
}

async function onLinksChange(e) {
    const card = e.target.closest('[data-link]');
    if (!card) return;
    const id = card.dataset.link;
    try {
        if (e.target.matches('[data-scope]')) {
            const scopes = [...card.querySelectorAll('[data-scope]:checked')].map(b => b.value);
            await api('PUT', `/hub-api/admin/peers/links/${id}`, { scopes });
            status('Saved.');
        } else if (e.target.matches('[data-friendly]')) {
            await api('PUT', `/hub-api/admin/peers/links/${id}`, { excludeFriendly: e.target.checked });
            status('Saved.');
        }
    } catch (err) { status(err.message, true); await load(); }
}

async function onSourcesClick(e) {
    const card = e.target.closest('[data-source]');
    if (!card) return;
    const id = card.dataset.source;
    try {
        if (e.target.matches('[data-pull]')) {
            status('Pulling…');
            return await pull(id);
        }
        if (e.target.matches('[data-toggle]')) {
            await api('PUT', `/hub-api/admin/peers/sources/${id}`, { enabled: card.classList.contains('opacity-60') });
        } else if (e.target.matches('[data-remove]')) {
            if (!confirm('Remove this partner? Everything they have shared with us is deleted too.')) return;
            await api('DELETE', `/hub-api/admin/peers/sources/${id}`);
        } else return;
        await load();
    } catch (err) { status(err.message, true); }
}

function init() {
    if (!$('peer-sharing-section')) return;
    $('peer-link-create').addEventListener('click', createLink);
    $('peer-source-add').addEventListener('click', addSource);
    $('peer-links').addEventListener('click', onLinksClick);
    $('peer-links').addEventListener('change', onLinksChange);
    $('peer-sources').addEventListener('click', onSourcesClick);
    load();
}

init();
