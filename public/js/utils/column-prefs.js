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

    /**
     * The difference from the defaults, which is all that gets remembered. `orderKeys`
     * (optional) is every non-locked column's key in the member's current left-to-right
     * order; it is only written when it actually differs from the definition order, so a
     * member who never touches reordering stores nothing extra and picks up new columns at
     * their natural position instead of a stale end-of-list slot.
     */
    function toStored(columns, visible, orderKeys) {
        const on = [], off = [];
        for (const c of columns) {
            const shown = visible.has(c.key);
            if (shown && !isDefaultOn(c)) on.push(c.key);
            if (!shown && isDefaultOn(c) && !isLocked(c)) off.push(c.key);
        }
        const result = { v: VERSION, on, off };
        if (Array.isArray(orderKeys)) {
            const natural = columns.filter(c => !isLocked(c)).map(c => c.key);
            const changed = orderKeys.length !== natural.length || orderKeys.some((k, i) => k !== natural[i]);
            if (changed) result.order = orderKeys;
        }
        return result;
    }

    /** JSON from storage -> preference object, or null for anything unusable. */
    function parseStored(raw) {
        if (typeof raw !== 'string' || !raw) return null;
        try {
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
            if (obj.v !== undefined && obj.v !== VERSION) return null;
            return { v: VERSION, on: list(obj.on), off: list(obj.off), order: list(obj.order) };
        } catch (err) {
            return null;
        }
    }

    /**
     * Apply a stored column order to the definitions. Unknown/duplicate keys are dropped; any
     * column missing from the stored order (new since the member last customised it, or
     * never touched) is appended in its original definition position. Locked columns (the
     * member-name column every table pins first) always stay first regardless of what is
     * stored — moving it would break the `sticky left-0` CSS the header/body cells rely on.
     * @returns {Array} a new column array; the same objects, reordered
     */
    function resolveOrder(columns, stored) {
        const locked = columns.filter(isLocked);
        const rest = columns.filter(c => !isLocked(c));
        const orderKeys = stored && Array.isArray(stored.order) ? list(stored.order) : [];
        if (!orderKeys.length) return [...locked, ...rest];

        const byKey = new Map(rest.map(c => [c.key, c]));
        const seen = new Set();
        const ordered = [];
        for (const k of orderKeys) {
            const c = byKey.get(k);
            if (c && !seen.has(k)) { ordered.push(c); seen.add(k); }
        }
        for (const c of rest) if (!seen.has(c.key)) ordered.push(c);
        return [...locked, ...ordered];
    }

    /**
     * Move the column `key` up (dir -1) or down (dir +1) among the currently visible,
     * non-locked columns, leaving hidden columns' relative order alone. Returns a NEW array,
     * or the same `columns` reference (by identity) for a no-op — key not found, locked, not
     * visible, or already at that end — so callers can skip a re-render with `result === columns`.
     */
    function moveVisible(columns, visible, key, dir) {
        const idxs = [];
        columns.forEach((c, i) => { if (!isLocked(c) && visible.has(c.key)) idxs.push(i); });
        const pos = idxs.findIndex(i => columns[i].key === key);
        if (pos === -1) return columns;
        const swapPos = pos + dir;
        if (swapPos < 0 || swapPos >= idxs.length) return columns;
        const next = columns.slice();
        const a = idxs[pos], b = idxs[swapPos];
        [next[a], next[b]] = [next[b], next[a]];
        return next;
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

    return { VERSION, KEY_RE, storageKey, defaultVisible, resolveVisible, toStored, parseStored, hiddenKeys, hiddenCss, resolveOrder, moveVisible };
});
