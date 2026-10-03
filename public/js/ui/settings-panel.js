// The Settings panel: which sidebar tools and which game-page extras this member wants.
//
// Everything is drawn from the catalogue in utils/hub-settings.js, so adding a switch there
// adds a row here with no change to this file. The choices live in hub-settings-store.js
// (server per account, cached in the browser); this file only paints them and forwards taps.
//
// Sidebar tools take effect at once — their buttons are in this document. Game-page extras
// are drawn inside the game frame, so a switched-off one is gone the next time a game page
// loads; the panel offers a reload for that rather than leaving the member wondering.
import { esc } from '../utils/escape.js';
import '../utils/hub-settings.js';
import { isEnabled, snapshot, onChange, change, reset, whenReady } from './hub-settings-store.js';

const S = globalThis.AWHubSettings;

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────

/** Show or hide each sidebar tool button to match the settings. */
export function applySidebarTools(doc = document) {
    for (const tool of S.TOOLS) {
        const button = doc.getElementById(tool.button);
        // An inline display, not a class: the buttons carry Tailwind's `flex`, which a
        // `hidden` class does not reliably beat.
        if (button) button.style.display = isEnabled(tool.key) ? '' : 'none';
    }
}

/** Apply now (the cached copy, so nothing flashes) and again whenever a setting changes. */
export function initSidebarTools() {
    applySidebarTools();
    onChange(() => applySidebarTools());
}

// ─── MARKUP ───────────────────────────────────────────────────────────────────

// "a", "a and b", "a, b and c" — for the line naming what starts switched off.
const sentenceList = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const TAG = 'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-700/60 text-amber-400';

// One labelled switch. A real checkbox underneath, so it works with keyboard and screen
// readers; the visible track and thumb are siblings that react to it through `peer`.
function toggleRow(item, on, bodyHtml) {
    return `
        <label class="flex items-start gap-3 py-3 border-b border-border/40 cursor-pointer">
            <span class="relative inline-flex shrink-0 mt-0.5">
                <input type="checkbox" class="peer sr-only" data-setting="${esc(item.key)}"${on ? ' checked' : ''}>
                <span class="block w-9 h-5 rounded-full bg-zinc-700 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-ring"></span>
                <span class="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white transition-transform peer-checked:translate-x-4"></span>
            </span>
            <span class="min-w-0">${bodyHtml}</span>
        </label>`;
}

function toolRow(tool, on) {
    const tag = tool.note ? `<span class="${TAG}">${esc(tool.note)}</span>` : '';
    return toggleRow(tool, on, `
        <span class="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <i class="fa-solid ${esc(tool.icon)} w-5 text-center text-muted-foreground"></i>${esc(tool.label)}${tag}
        </span>`);
}

function injectionRow(item, on) {
    return toggleRow(item, on, `
        <span class="block text-sm text-foreground">${esc(item.label)}</span>
        <span class="block text-xs text-muted-foreground mt-0.5">${esc(item.description)}</span>`);
}

/** The whole panel body for a resolved {key: boolean} map. Pure: no DOM, no storage. */
export function settingsHtml(resolved) {
    const offByDefault = S.TOOLS.filter(t => !t.defaultOn).map(t => t.label);
    const groups = S.GROUPS.map(group => {
        const items = S.INJECTIONS.filter(i => i.group === group.id);
        if (!items.length) return '';
        return `
            <h4 class="mt-5 mb-1 text-sm font-semibold text-foreground">${esc(group.label)}</h4>
            <div>${items.map(i => injectionRow(i, resolved[i.key])).join('')}</div>`;
    }).join('');

    return `
        <section>
            <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sidebar tools</h3>
            <p class="mt-1 text-sm text-muted-foreground">Your choices are saved to your account, so they follow you to other devices. Switching a tool off only hides its button; nothing is deleted.</p>
            ${offByDefault.length ? `<p class="mt-1 text-sm text-muted-foreground">Off until you turn them on: ${esc(sentenceList(offByDefault))}.</p>` : ''}
            <div class="mt-2 grid md:grid-cols-2 md:gap-x-10">${S.TOOLS.map(t => toolRow(t, resolved[t.key])).join('')}</div>
        </section>

        <section class="mt-10">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Game page extras</h3>
            <p class="mt-1 text-sm text-muted-foreground">Things the hub adds to the game’s own pages. Turn off what you don’t use; the game itself is not touched.</p>
            ${groups}
            <p class="mt-6 text-xs text-muted-foreground">Not listed: the map and system sidebar, the incoming-fleet tools on the News page, and the background scans. The whole alliance relies on what those collect.</p>
        </section>`;
}

// ─── PANEL ────────────────────────────────────────────────────────────────────

// Close every other panel in the container: the older panels keep their own hard-coded
// lists (archives.js), so this one finds its siblings instead — same as sleep-map.js.
function closeSiblings(exceptId) {
    document.querySelectorAll('#dynamic-panels-container > div').forEach(el => {
        if (el.id !== exceptId) el.classList.replace('translate-x-0', 'translate-x-full');
    });
}

let statusTimer = null;
function setStatus(panel, text, isError) {
    const el = panel.querySelector('#settings-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('text-red-400', !!isError);
    el.classList.toggle('text-muted-foreground', !isError);
    clearTimeout(statusTimer);
    if (text && !isError) statusTimer = setTimeout(() => { el.textContent = ''; }, 1800);
}

function showReloadNote(panel, show) {
    const note = panel.querySelector('#settings-reload-note');
    if (!note) return;
    note.classList.toggle('hidden', !show);
    note.classList.toggle('flex', show);
}

// Bring each switch back in line with the store without redrawing (keeps the scroll place).
function syncChecks(panel) {
    const now = snapshot();
    panel.querySelectorAll('input[data-setting]').forEach(box => {
        const want = now[box.dataset.setting];
        if (typeof want === 'boolean' && box.checked !== want) box.checked = want;
    });
}

// A GET of the page the frame is already showing — never a resubmit of a form.
function reloadGameFrame() {
    const frame = document.getElementById('game-frame');
    if (!frame) return;
    try { frame.contentWindow.location.replace(frame.contentWindow.location.href); }
    catch (err) { frame.src = frame.src; }
}

function wirePanel(panel) {
    const close = () => {
        panel.classList.replace('translate-x-0', 'translate-x-full');
        showReloadNote(panel, false);
    };
    panel.querySelector('#settings-close-btn')?.addEventListener('click', close);

    panel.querySelector('#settings-body')?.addEventListener('change', async e => {
        const box = e.target.closest('input[data-setting]');
        if (!box) return;
        const item = S.ALL.find(i => i.key === box.dataset.setting);
        if (item && item.kind === 'inject') showReloadNote(panel, true);
        setStatus(panel, 'Saving…');
        try {
            await change({ [box.dataset.setting]: box.checked });
            setStatus(panel, 'Saved');
        } catch (err) {
            setStatus(panel, `Not saved: ${err.message}`, true);
        }
        syncChecks(panel);
    });

    panel.querySelector('#settings-reset-btn')?.addEventListener('click', async () => {
        setStatus(panel, 'Saving…');
        try {
            await reset();
            setStatus(panel, 'Defaults restored');
            showReloadNote(panel, true);
        } catch (err) {
            setStatus(panel, `Not saved: ${err.message}`, true);
        }
        syncChecks(panel);
    });

    panel.querySelector('#settings-reload-btn')?.addEventListener('click', () => {
        reloadGameFrame();
        close();
        if (typeof window.showToast === 'function') window.showToast('Game page reloaded');
    });

    // A change made in the game frame's realm, another tab or on another device.
    onChange(() => syncChecks(panel));
}

export async function openSettingsPanel() {
    let panel = document.getElementById('settings-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/settings.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('settings-panel');
        wirePanel(panel);
    }
    if (panel.classList.contains('translate-x-0')) {
        panel.classList.replace('translate-x-0', 'translate-x-full');
        showReloadNote(panel, false);
        return;
    }
    closeSiblings('settings-panel');
    panel.classList.replace('translate-x-full', 'translate-x-0');
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();

    // Drawn from what is known now (the cached copy, else the defaults) so the panel is
    // never empty while the server answers; if the server disagrees, the store's change
    // notification re-syncs the switches.
    panel.querySelector('#settings-body').innerHTML = settingsHtml(snapshot());
    setStatus(panel, '');
    whenReady().then(() => syncChecks(panel));
}
