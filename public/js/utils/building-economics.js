// Advisory market-value comparison only. No game requests, purchases, or player data.
// Dual runtime: side-effect import in the browser; require() in the test runner.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWBuildingEconomics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const BUILDINGS = Object.freeze(['Hydroponic Farm', 'Robotic Factory', 'Galactic Cybernet', 'Research Lab']);
    const STORAGE_KEY = 'awt.buildingEconomics.quote.v1';
    const QUOTE_EVENT = 'awt:building-economics-quote';
    const MAX_AGE_MS = 15 * 60 * 1000;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const money = value => finite(value) && value >= 0 && value <= 1e9;
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    let storageFailed = false;

    function fullUpgradeCost(level) {
        if (!Number.isSafeInteger(level) || level < 0) return null;
        const tables = typeof module === 'object' && module.exports ? require('./game-tables.js') : root.AWTables;
        const cost = tables?.BUILDING[level + 1];
        return Number.isSafeInteger(cost) && cost > 0 ? cost : null;
    }

    // Displayed prices have at most two decimal places. Keep the game's existing
    // comma/dot/space grouping conventions, but reject prose, partial values and signs.
    // Unlike inventory valuation, advice must never recover a number from malformed text.
    function parsePrice(text) {
        if (typeof text !== 'string') return null;
        const value = text.trim().replace(/^(?:A\$|\$)\s*/, '').replace(/[\u00a0\u202f]/g, ' ');
        if (/^\d+(?:[.,]\d{1,2})?$/.test(value)) return Number(value.replace(',', '.'));
        for (const [group, decimal] of [[',', '.'], ['.', ','], [' ', '.'], [' ', ',']]) {
            const escapedGroup = group === '.' ? '\\.' : group;
            const escapedDecimal = decimal === '.' ? '\\.' : decimal;
            if (new RegExp(`^[1-9]\\d{0,2}(?:${escapedGroup}\\d{3})+(?:${escapedDecimal}\\d{1,2})?$`).test(value)) {
                return Number(value.split(group).join('').replace(decimal, '.'));
            }
        }
        return null;
    }

    function parseRemainingPP(text) {
        if (typeof text !== 'string') return null;
        const value = text.trim().replace(/[\u00a0\u202f]/g, ' ');
        const valid = /^\d+$/.test(value) || /^[1-9]\d{0,2}(?:,\d{3})+$/.test(value)
            || /^[1-9]\d{0,2}(?:\.\d{3})+$/.test(value) || /^[1-9]\d{0,2}(?: \d{3})+$/.test(value);
        if (!valid) return null;
        const amount = Number(value.replace(/[,. ]/g, ''));
        return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
    }

    // Omit a missing building refund; reject a present but unreadable one. A missing
    // refund can support a conservative, explicitly labelled "before refund" comparison.
    function quoteFromPrices(priceTexts, now = Date.now()) {
        if (!priceTexts || typeof priceTexts !== 'object') return null;
        const ppPrice = parsePrice(priceTexts['Production Point']);
        const suPrice = parsePrice(priceTexts['Supply Unit']);
        const refunds = {};
        for (const building of BUILDINGS) {
            if (own(priceTexts, building)) refunds[building] = parsePrice(priceTexts[building]);
        }
        return validateQuote({ version: 1, capturedAt: now, ppPrice, suPrice, refunds }, now);
    }

    function validateQuote(value, now = Date.now()) {
        if (!value || value.version !== 1 || !finite(now) || !finite(value.capturedAt)
            || value.capturedAt <= 0 || value.capturedAt > now || now - value.capturedAt >= MAX_AGE_MS
            || !money(value.ppPrice) || value.ppPrice <= 0 || !money(value.suPrice) || value.suPrice <= 0
            || !value.refunds || typeof value.refunds !== 'object' || Array.isArray(value.refunds)) return null;
        const refunds = {};
        for (const building of BUILDINGS) {
            if (!own(value.refunds, building)) continue;
            const refund = value.refunds[building];
            if (!money(refund) || refund > value.suPrice) return null;
            refunds[building] = refund;
        }
        // Whitelist on both write and read: the cache never holds inventory or identities.
        return { version: 1, capturedAt: value.capturedAt, ppPrice: value.ppPrice, suPrice: value.suPrice, refunds };
    }

    function readQuote(now = Date.now()) {
        if (storageFailed) return null;
        try {
            const raw = root.localStorage.getItem(STORAGE_KEY);
            return raw ? validateQuote(JSON.parse(raw), now) : null;
        } catch (_) { return null; }
    }

    function recordQuote(priceTexts, now = Date.now()) {
        const quote = quoteFromPrices(priceTexts, now);
        try {
            if (quote) root.localStorage.setItem(STORAGE_KEY, JSON.stringify(quote));
            else root.localStorage.removeItem(STORAGE_KEY);
            storageFailed = false;
        } catch (_) {
            storageFailed = true;
            try { root.localStorage.removeItem(STORAGE_KEY); } catch (_) { /* storage unavailable */ }
        }
        // storage events reach other documents, but not the writer itself.
        if (typeof root.dispatchEvent === 'function' && typeof root.Event === 'function') {
            root.dispatchEvent(new root.Event(QUOTE_EVENT));
        }
        return storageFailed ? null : quote;
    }

    function evaluateUpgrade(remainingPP, building, value, now = Date.now()) {
        const quote = validateQuote(value, now);
        if (!quote || !BUILDINGS.includes(building) || !Number.isSafeInteger(remainingPP) || remainingPP < 0) return null;
        const hasRefund = own(quote.refunds, building);
        const refund = hasRefund ? quote.refunds[building] : 0;
        const cents = amount => Math.round((amount + Number.EPSILON) * 100);
        const ppCents = cents(remainingPP * quote.ppPrice);
        const suCents = cents(quote.suPrice - refund);
        if (!Number.isSafeInteger(ppCents) || !Number.isSafeInteger(suCents)) return null;
        const savingCents = ppCents - suCents;
        return {
            remainingPP, ppPrice: quote.ppPrice, ppValue: ppCents / 100,
            suPrice: quote.suPrice, refund: hasRefund ? refund : null, suValue: suCents / 100,
            saving: savingCents / 100, savingPercent: ppCents > 0 ? savingCents / ppCents * 100 : 0,
            capturedAt: quote.capturedAt,
        };
    }

    function compareUpgrade(remainingPP, building, value, now = Date.now()) {
        const result = evaluateUpgrade(remainingPP, building, value, now);
        return result && result.saving > 0 ? result : null;
    }

    return { BUILDINGS, STORAGE_KEY, QUOTE_EVENT, MAX_AGE_MS, parsePrice, parseRemainingPP,
        quoteFromPrices, validateQuote, readQuote, recordQuote, compareUpgrade, evaluateUpgrade, fullUpgradeCost };
});
