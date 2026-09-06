// Which columns of a stats table a member wants to see — remembered, per table, per member.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// "Add all stats for players in Alliance stats, in War room, in Players table" (issue #113)
// means thirty-plus columns per table. Nobody reads thirty columns; everybody reads a
// different eight. So every column has a default (on/off) and the member can flip any of
// them; what is stored is only the DIFFERENCE from the defaults, so a column added in a later
// release simply follows its own default instead of being forced on or off by a stale
// preference blob. Visibility is applied with one <style> rule per hidden column, so a
// re-rendered table needs no per-cell work.
//
// This file is the DOM-free half: keys, merge rules, CSS text. The button and the checkbox
// list live in public/js/ui/column-picker.js.
//
// LOADING: same dual Node/browser pattern as travel-model.js/fresh-cache.js.
//   • Node:    require('../../public/js/utils/column-prefs.js')
//   • Browser: import '../utils/column-prefs.js'; then read globalThis.AWColumnPrefs
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWColumnPrefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = 1;
    // Keys land in CSS attribute selectors and in localStorage keys; keep them boring.
    const KEY_RE = /^[A-Za-z0-9_-]+$/;

    function storageKey(tableKey, userId) {
        return `awt.columns.v${VERSION}.${tableKey}.${userId != null ? userId : 'anon'}`;
    }

    const isLocked = c => !!c.locked;
    const isDefaultOn = c => isLocked(c) || c.default !== false;
    const list = v => (Array.isArray(v) ? v.filter(k => typeof k === 'string') : []);

    /** The visible set with no preference stored at all. */
    function defaultVisible(columns) {
        return new Set(columns.filter(isDefaultOn).map(c => c.key));
    }

    /**
     * Apply a stored preference (see toStored) to the column definitions.
     * Unknown keys are ignored; a locked column can never be hidden.
     * @returns {Set<string>} visible keys
     */
    function resolveVisible(columns, stored) {
        const visible = defaultVisible(columns);
        const byKey = new Map(columns.map(c => [c.key, c]));
        if (stored && typeof stored === 'object') {
            for (const k of list(stored.off)) {
                const c = byKey.get(k);
                if (c && !isLocked(c)) visible.delete(k);
            }
            for (const k of list(stored.on)) {
                if (byKey.has(k)) visible.add(k);
            }
        }
        for (const c of columns) if (isLocked(c)) visible.add(c.key);
        return visible;
    }

    /** The difference from the defaults, which is all that gets remembered. */
    function toStored(columns, visible) {
        const on = [], off = [];
        for (const c of columns) {
            const shown = visible.has(c.key);
            if (shown && !isDefaultOn(c)) on.push(c.key);
            if (!shown && isDefaultOn(c) && !isLocked(c)) off.push(c.key);
        }
        return { v: VERSION, on, off };
    }

    /** JSON from storage -> preference object, or null for anything unusable. */
    function parseStored(raw) {
        if (typeof raw !== 'string' || !raw) return null;
        try {
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
            if (obj.v !== undefined && obj.v !== VERSION) return null;
            return { v: VERSION, on: list(obj.on), off: list(obj.off) };
        } catch (err) {
            return null;
        }
    }

    function hiddenKeys(columns, visible) {
        return columns.filter(c => !visible.has(c.key)).map(c => c.key);
    }

    /** One rule per hidden column. Header and body cells both carry data-col. */
    function hiddenCss(tableId, keys) {
        if (!KEY_RE.test(String(tableId))) return '';
        return keys.filter(k => KEY_RE.test(k))
            .map(k => `#${tableId} [data-col="${k}"]{display:none}`)
            .join('\n');
    }

    return { VERSION, KEY_RE, storageKey, defaultVisible, resolveVisible, toStored, parseStored, hiddenKeys, hiddenCss };
});
