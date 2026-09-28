// Shared clock/state and keyboard detector. The wrapper owns the same-tab state; storage
// broadcasts it to other tabs. Reopening a page never starts a new sixty-minute window.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWUnicornMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'awt.unicorn.expiresAt.v1';
    const CHANGE_EVENT = 'awt-unicorn-change';
    const DURATION_MS = 60 * 60 * 1000;
    const KEY_GAP_MS = 3000;

    function isTypingTarget(element) {
        if (!element) return false;
        return /^(INPUT|TEXTAREA|SELECT)$/.test(String(element.tagName || '').toUpperCase())
            || element.isContentEditable === true
            || element.getAttribute?.('role') === 'textbox';
    }

    function createWordDetector() {
        let buffer = '';
        let lastAt = 0;
        const reset = () => { buffer = ''; lastAt = 0; };
        return {
            reset,
            feed(event, now = Date.now()) {
                if (isTypingTarget(event.target) || event.defaultPrevented || event.isComposing
                    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
                    reset();
                    return false;
                }
                if (event.repeat) return false;
                if (now - lastAt > KEY_GAP_MS) buffer = '';
                lastAt = now;
                const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
                buffer = /^[a-z]$/.test(key) ? (buffer + key).slice(-7) : '';
                if (buffer !== 'unicorn') return false;
                reset();
                return true;
            }
        };
    }

    function stateAt(expiresAt, now) {
        const active = Number.isFinite(expiresAt) && expiresAt > now;
        return { active, expiresAt: active ? expiresAt : 0, minutesLeft: active ? Math.ceil((expiresAt - now) / 60000) : 0 };
    }

    function createStore(host, now = () => Date.now()) {
        let expiresAt = 0;
        let timer = null;
        let disposed = false;
        const subscribers = new Set();
        const read = () => {
            try {
                const value = Number(host.localStorage.getItem(STORAGE_KEY));
                expiresAt = Number.isFinite(value) && value > 0 ? value : 0;
            } catch (err) { /* In-memory state still drives this wrapper and its frame. */ }
        };
        const refresh = () => {
            if (disposed) return;
            host.clearTimeout(timer);
            const state = stateAt(expiresAt, now());
            for (const callback of subscribers) callback(state);
            timer = state.active ? host.setTimeout(refresh, Math.min(60000, expiresAt - now())) : null;
        };
        const set = value => {
            expiresAt = value;
            try {
                if (value) host.localStorage.setItem(STORAGE_KEY, String(value));
                else host.localStorage.removeItem(STORAGE_KEY);
            } catch (err) { /* Same-tab mode remains usable when storage is blocked. */ }
            refresh();
            host.dispatchEvent(new host.CustomEvent(CHANGE_EVENT, { detail: { expiresAt: value } }));
        };
        const onStorage = event => {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            read();
            refresh();
        };
        const onChange = event => {
            const value = event.detail?.expiresAt;
            if (!Number.isFinite(value) || value < 0) return;
            expiresAt = value;
            refresh();
        };
        const onVisibility = () => { read(); refresh(); };
        read();
        host.addEventListener('storage', onStorage);
        host.addEventListener(CHANGE_EVENT, onChange);
        host.document.addEventListener('visibilitychange', onVisibility);
        refresh();
        return {
            getState: () => stateAt(expiresAt, now()),
            activate: () => set(now() + DURATION_MS),
            deactivate: () => set(0),
            refresh,
            subscribe(callback) {
                subscribers.add(callback);
                callback(stateAt(expiresAt, now()));
                return () => subscribers.delete(callback);
            },
            dispose() {
                disposed = true;
                host.clearTimeout(timer);
                host.removeEventListener('storage', onStorage);
                host.removeEventListener(CHANGE_EVENT, onChange);
                host.document.removeEventListener('visibilitychange', onVisibility);
                subscribers.clear();
            }
        };
    }

    return { STORAGE_KEY, CHANGE_EVENT, DURATION_MS, KEY_GAP_MS, isTypingTarget, createWordDetector, stateAt, createStore };
});
