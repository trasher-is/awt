// The "Columns" button on a stats table: a checkbox per column, remembered per member.
//
// The rules (defaults, what is stored, the CSS that hides a column) live in
// public/js/utils/column-prefs.js so they can be tested in Node; this file only does the
// document work. Hiding is one <style> rule per hidden column keyed on data-col, so a table
// that re-renders its rows (every sort, every filter keystroke) needs no per-cell work.

import '../utils/column-prefs.js';   // side-effect import: AWColumnPrefs
const Prefs = globalThis.AWColumnPrefs;

// Preferences are per member. One /hub-api/me for the whole dashboard lifetime, shared by
// every picker; 'anon' if it fails (same fallback the galaxy map uses).
let viewerIdPromise = null;
export function getViewerId() {
    if (!viewerIdPromise) {
        viewerIdPromise = fetch('/hub-api/me')
            .then(r => r.json())
            .then(d => (d && d.id != null ? d.id : null))
            .catch(() => null);
    }
    return viewerIdPromise;
}

function readStored(key) {
    try { return Prefs.parseStored(localStorage.getItem(key)); } catch (err) { return null; }
}
function writeStored(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode or full: losing a checkbox is not worth an error */ }
}

/**
 * @param {object} o
 * @param {HTMLElement} o.mountEl   where the button goes (empty container in the toolbar)
 * @param {string} o.tableId        id of the <table> whose cells carry data-col
 * @param {string} o.tableKey       storage key part, e.g. 'warRoom'
 * @param {Array} o.columns         column definitions (stat-columns.js)
 * @param {(visible: Set<string>) => void} [o.onChange]
 */
export async function mountColumnPicker({ mountEl, tableId, tableKey, columns, onChange }) {
    if (!mountEl || mountEl.dataset.awtPicker) return null;
    mountEl.dataset.awtPicker = tableKey;

    // The default visibility is applied BEFORE the member lookup below resolves, so the
    // first paint never flashes all forty-odd columns for one round-trip; the member's own
    // preference then replaces it.
    const style = document.createElement('style');
    style.dataset.awtColumns = tableKey;
    style.textContent = Prefs.hiddenCss(tableId, Prefs.hiddenKeys(columns, Prefs.defaultVisible(columns)));
    document.head.appendChild(style);

    const userId = await getViewerId();
    const storageKey = Prefs.storageKey(tableKey, userId);
    let visible = Prefs.resolveVisible(columns, readStored(storageKey));

    mountEl.innerHTML = `
        <div class="relative">
            <button type="button" class="awt-col-btn inline-flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-zinc-950 text-sm text-foreground hover:bg-accent transition-colors" title="Choose which columns to show">
                <i class="fa-solid fa-table-columns"></i><span class="hidden sm:inline">Columns</span>
                <span class="awt-col-count text-xs text-muted-foreground font-mono"></span>
            </button>
            <div class="awt-col-menu hidden absolute right-0 top-full mt-1 z-50 w-72 max-h-[70vh] overflow-y-auto bg-zinc-900 border border-border rounded-md shadow-2xl p-2 text-sm">
                <div class="awt-col-list flex flex-col gap-1"></div>
                <div class="flex items-center gap-3 pt-2 mt-2 border-t border-border text-xs">
                    <button type="button" data-act="all" class="text-sky-400 hover:underline">Show all</button>
                    <button type="button" data-act="reset" class="text-muted-foreground hover:underline">Defaults</button>
                    <button type="button" data-act="close" class="ml-auto h-7 px-3 rounded border border-input hover:bg-accent text-foreground">Done</button>
                </div>
            </div>
        </div>`;
    const btn = mountEl.querySelector('.awt-col-btn');
    const menu = mountEl.querySelector('.awt-col-menu');
    const list = mountEl.querySelector('.awt-col-list');
    const count = mountEl.querySelector('.awt-col-count');

    function apply() {
        style.textContent = Prefs.hiddenCss(tableId, Prefs.hiddenKeys(columns, visible));
        count.textContent = `${visible.size}/${columns.length}`;
    }

    function paintList() {
        const groups = [];
        for (const c of columns) {
            let g = groups.find(x => x.name === (c.group || 'Other'));
            if (!g) { g = { name: c.group || 'Other', items: [] }; groups.push(g); }
            g.items.push(c);
        }
        list.innerHTML = groups.map(g => `
            <div class="px-1 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">${g.name}</div>
            ${g.items.map(c => `
            <label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-800 cursor-pointer ${c.locked ? 'opacity-60 cursor-default' : ''}" title="${c.title ? c.title.replace(/"/g, '&quot;') : ''}">
                <input type="checkbox" data-key="${c.key}" ${visible.has(c.key) ? 'checked' : ''} ${c.locked ? 'disabled' : ''} class="w-4 h-4 rounded border-border bg-transparent">
                <span class="text-foreground">${c.label}</span>
                ${c.default === false && !c.locked ? '<span class="ml-auto text-[10px] text-zinc-500">extra</span>' : ''}
            </label>`).join('')}`).join('');
    }

    function commit() {
        writeStored(storageKey, Prefs.toStored(columns, visible));
        apply();
        if (typeof onChange === 'function') onChange(new Set(visible));
    }

    list.addEventListener('change', e => {
        const input = e.target.closest('input[data-key]');
        if (!input) return;
        const c = columns.find(x => x.key === input.dataset.key);
        if (!c || c.locked) return;
        if (input.checked) visible.add(c.key); else visible.delete(c.key);
        commit();
    });
    menu.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'all') { visible = new Set(columns.map(c => c.key)); paintList(); commit(); }
        if (act === 'reset') { visible = Prefs.defaultVisible(columns); paintList(); commit(); }
        if (act === 'close') menu.classList.add('hidden');
    });
    btn.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', e => {
        if (!menu.classList.contains('hidden') && !mountEl.contains(e.target)) menu.classList.add('hidden');
    });

    paintList();
    apply();
    return { isVisible: k => visible.has(k), getVisible: () => new Set(visible) };
}
