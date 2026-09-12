(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AWTradeSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const AGREEMENT_FEE = 20000;
    const MAX_AGREEMENTS = 5;
    const MAX_HOURS = 365 * 24;
    const MAX_ROWS = 1000;
    const EPSILON = 1e-8;
    const nameKey = value => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
    const observed = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const finite = value => Number.isFinite(value) ? value : null;

    // This deliberately estimates funding only. Road to TA separately simulates
    // local construction, sale eligibility, population and future trade revenue.
    function plan(players, ppPrice, config = {}) {
        const schedule = [], unresolved = [];
        const assumptions = [
            'Funding estimate only: production and the A$/PP sale price remain constant. Buildings, population goals, sale restrictions, siege losses and future TA bonuses are excluded.',
            'PP is valued at the entered A$/PP price; the estimate does not execute a sale or predict offer acceptance or bonus activation.',
            'For an ordinary player paired with a Trader, the ordinary player is assumed to initiate and the Trader to accept for free. Board direction does not prove in-game offer direction.',
            'Pending Trader agreements take priority over an ordinary agreement involving the same player. Other fundable pairs can proceed independently.',
        ];
        let currentTime = 0;
        const result = () => ({ schedule, unresolved, assumptions, totalHours: unresolved.length ? null : currentTime,
            lastScheduledHours: currentTime, maxBounded: true, horizonHours: MAX_HOURS,
            balances: [...states.values()].map(state => ({
                name: state.name, initialCash: state.cash, initialPP: state.pp,
                incomePerHour: state.income, earnedCash: state.earned,
                spentCash: state.spent, remainingValue: balance(state),
            })) });
        const states = new Map();
        const reject = (pair, reason) => unresolved.push({ pair, reason });
        if (!Array.isArray(players) || players.length > MAX_ROWS || !config || typeof config !== 'object' ||
            !Array.isArray(config.pairs) || config.pairs.length > MAX_ROWS ||
            (config.traders !== undefined && (!Array.isArray(config.traders) || config.traders.length > MAX_ROWS)) ||
            (config.cost !== undefined && config.cost !== AGREEMENT_FEE)) {
            reject([], 'Invalid schedule input: provide player rows, confirmed pairs and the standard 20,000 A$ fee (at most 1,000 rows).');
            return result();
        }
        const price = observed(ppPrice) > 0 ? ppPrice : null;
        const traders = new Map((config.traders || []).map((name, index) => [nameKey(name), index]));
        const duplicateNames = new Set(), ids = new Map();
        for (const row of players) {
            const key = nameKey(row?.name);
            if (!key) continue;
            if (states.has(key)) duplicateNames.add(key);
            const production = observed(row.production_rate), pp = observed(row.production_points);
            const income = production === 0 ? 0 : production !== null && price !== null ? finite(production * price) : null;
            const state = { key, name: row.name.trim(), cash: observed(row.astro_dollars), pp, income,
                ppValue: pp === 0 ? 0 : pp !== null && price !== null ? finite(pp * price) : null,
                spent: 0, earned: 0, partners: new Set(), unknownPartners: true,
                rawPartners: row.trade_partners, knownPartners: row.known_partners, trader: traders.has(key) };
            states.set(key, state);
            if (Number.isSafeInteger(row.id) && row.id > 0) {
                const id = String(row.id);
                ids.set(id, ids.has(id) ? null : key);
            }
        }
        const partnerKey = value => {
            if (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value.trim())) {
                const id = Number(value);
                if (!Number.isSafeInteger(id) || id <= 0) return null;
                const knownName = ids.get(String(id));
                return knownName ? `name:${knownName}` : `id:${id}`;
            }
            const name = nameKey(value);
            return name ? `name:${name}` : null;
        };
        for (const state of states.values()) {
            if (Array.isArray(state.rawPartners)) {
                state.unknownPartners = !state.rawPartners.every(value => partnerKey(value) !== null);
            }
            // A partial observation cannot establish the full slot count, but each
            // valid completed edge still prevents charging that pair a second time.
            for (const values of [state.rawPartners, state.knownPartners]) {
                if (!Array.isArray(values)) continue;
                for (const partner of values) {
                    const key = partnerKey(partner);
                    if (key !== null && key !== `name:${state.key}`) state.partners.add(key);
                }
            }
        }
        // A partner reporting an existing agreement is sufficient evidence for both
        // accounts, even if the other account's snapshot is older or missing.
        for (const state of states.values()) {
            for (const key of state.partners) {
                if (key.startsWith('name:')) states.get(key.slice(5))?.partners.add(`name:${state.key}`);
            }
        }
        const seen = new Set();
        let pending = [];
        for (const pair of config.pairs) {
            const names = Array.isArray(pair) ? pair : [];
            const a = nameKey(names[0]), b = nameKey(names[1]);
            if (names.length !== 2 || !a || !b || a === b) { reject(names, 'A confirmed agreement must name two different players.'); continue; }
            const pairKey = [a, b].sort().join('\u0000');
            if (seen.has(pairKey)) { reject(names, 'Duplicate confirmed pair; it was scheduled only once.'); continue; }
            seen.add(pairKey);
            const first = states.get(a), second = states.get(b);
            if (!first || !second) { reject(names, `Missing economic row for ${!first ? names[0] : names[1]}.`); continue; }
            if (duplicateNames.has(a) || duplicateNames.has(b)) { reject(names, 'Ambiguous duplicate player names in economic data.'); continue; }
            if (first.trader && second.trader) { reject(names, 'Trader–Trader pairs are unsupported by the coordination board.'); continue; }
            // Normalize the assumed paid initiator/free acceptor direction.
            const p1 = first.trader ? second : first, p2 = first.trader ? first : second;
            pending.push({ names: [p1.name, p2.name], p1, p2,
                cost1: AGREEMENT_FEE, cost2: p2.trader ? 0 : AGREEMENT_FEE });
        }
        const unknownPartners = [...new Set(pending.flatMap(pair => [pair.p1, pair.p2]))]
            .filter(state => state.unknownPartners).map(state => state.name);
        if (unknownPartners.length) assumptions.push(`Completed partners are unknown for ${unknownPartners.join(', ')}. Funding can be estimated, but remaining TA slots cannot be fully verified.`);

        function balance(state) {
            if (state.cash === null || state.ppValue === null || state.earned === null) return null;
            return finite(state.cash + state.ppValue + state.earned - state.spent);
        }
        function delay(state, cost) {
            if (!cost) return { hours: 0 };
            if (state.cash === null) return { reason: `Missing or invalid A$ balance for ${state.name}.` };
            // Known cash alone can cover a fee without requiring unrelated unknown
            // PP, a missing market price or an unobserved production rate.
            const cashFloor = state.cash - state.spent;
            if (cashFloor + EPSILON >= cost) return { hours: 0 };
            if (state.ppValue === null) return { reason: `Missing PP balance or positive A$/PP sale price for ${state.name}.` };
            const knownValue = state.cash + state.ppValue + (state.earned ?? 0) - state.spent;
            if (!Number.isFinite(knownValue)) return { reason: `Economic values exceed the supported numeric range for ${state.name}.` };
            if (knownValue + EPSILON >= cost) return { hours: 0 };
            if (state.income === null) return { reason: `Missing hourly production or positive A$/PP sale price for ${state.name}.` };
            if (state.income === 0) return { reason: `${state.name} has insufficient funds and zero hourly income.` };
            const hours = (cost - knownValue) / state.income;
            return Number.isFinite(hours) && currentTime + hours <= MAX_HOURS
                ? { hours } : { reason: `${state.name} cannot fund this agreement within the ${MAX_HOURS / 24}-day forecast horizon.` };
        }
        while (pending.length) {
            const fundable = [];
            for (const pair of pending) {
                if (pair.p1.partners.has(`name:${pair.p2.key}`) || pair.p2.partners.has(`name:${pair.p1.key}`)) {
                    reject(pair.names, 'This agreement is already present in reported completed partners.');
                    continue;
                }
                const full = [pair.p1, pair.p2].find(state => state.partners.size >= MAX_AGREEMENTS);
                if (full) { reject(pair.names, `${full.name} already has five reported or scheduled agreements.`); continue; }
                const d1 = delay(pair.p1, pair.cost1), d2 = delay(pair.p2, pair.cost2);
                if (d1.reason || d2.reason) { reject(pair.names, d1.reason || d2.reason); continue; }
                fundable.push({ ...pair, hours: Math.max(d1.hours, d2.hours) });
            }
            if (!fundable.length) break;
            const traderPlayers = new Set(fundable.filter(pair => pair.p2.trader).flatMap(pair => [pair.p1.key, pair.p2.key]));
            const candidates = fundable.filter(pair => pair.p2.trader || !traderPlayers.has(pair.p1.key) && !traderPlayers.has(pair.p2.key));
            candidates.sort((a, b) => a.hours - b.hours ||
                (traders.get(a.p2.key) ?? Infinity) - (traders.get(b.p2.key) ?? Infinity));
            const next = candidates[0];
            currentTime += next.hours;
            const active = new Set(fundable.flatMap(pair => [pair.p1, pair.p2]));
            for (const state of active) {
                if (next.hours) state.earned = state.income === null || state.earned === null ? null : finite(state.earned + state.income * next.hours);
            }
            next.p1.spent += next.cost1;
            next.p2.spent += next.cost2;
            next.p1.partners.add(`name:${next.p2.key}`);
            next.p2.partners.add(`name:${next.p1.key}`);
            schedule.push({ time: currentTime, p1: next.p1.name, p2: next.p2.name,
                is_trader: next.p2.trader, cost1: next.cost1, cost2: next.cost2 });
            pending = fundable.filter(pair => pair.p1 !== next.p1 || pair.p2 !== next.p2);
        }
        return result();
    }

    return { plan, constants: Object.freeze({ AGREEMENT_FEE, MAX_AGREEMENTS, MAX_HOURS }) };
});
