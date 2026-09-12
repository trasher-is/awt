// A bounded, local-PP development forecast for the standard server. Strategy targets are
// planning policies, never game requirements. See docs/road-to-ta.md for sources/limits.
(function (root, factory) {
    const isNode = typeof module === 'object' && module && module.exports;
    const api = factory(isNode ? require('./game-tables.js') : root.AWTables,
        isNode ? require('./sqlite-time.js') : root.AWSqliteTime);
    if (isNode) module.exports = api;
    root.AWRoadToTA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Time) {
    'use strict';

    const FEE = 20000, MAX_TAS = 5, HOUR = 3600000, EPS = 1e-8;
    const BUILDINGS = ['HF', 'RF', 'RL', 'GC'];
    const POLICIES = {
        rush: { required: 2, order: ['RF', 'HF', 'RL', 'GC'], profiles: [[0, 0, 0, 0], [6, 8, 0, 0], [8, 10, 0, 0], [10, 12, 0, 0]] },
        normal: { required: 3, order: ['RL', 'RF', 'HF', 'GC'], profiles: [[8, 10, 10, 8], [10, 12, 12, 10], [12, 13, 13, 12]] },
        slow: { required: 6, order: ['GC', 'RL', 'RF', 'HF'], profiles: [[10, 12, 12, 12], [12, 13, 13, 13], [12, 14, 14, 14]] }
    };
    const clock = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });

    function timestamp(value) {
        return Time.parseTimestamp(value)?.getTime() ?? NaN;
    }

    // Search real UTC minutes so both missing/repeated DST hours are handled correctly.
    // Acceptance at a boundary is conservatively deferred to the next boundary; then
    // allow five more minutes for the separately scheduled trade-bonus recalculation.
    function nextTradeActivation(value) {
        const ms = timestamp(value);
        if (!Number.isFinite(ms)) throw new Error('A valid funding timestamp is required.');
        let candidate = Math.floor(ms / 60000) * 60000 + 60000;
        for (let i = 0; i < 8 * 60; i++, candidate += 60000) {
            const parts = clock.formatToParts(candidate);
            const hour = Number(parts.find(p => p.type === 'hour').value);
            const minute = Number(parts.find(p => p.type === 'minute').value);
            if (hour % 6 === 0 && minute === 0) return candidate + 5 * 60000;
        }
        throw new Error('Could not resolve the next trade activation.');
    }

    function finite(value, min, max, integer) {
        return typeof value === 'number' && Number.isFinite(value)
            && value >= min && value <= max && (!integer || Number.isInteger(value));
    }

    function validate(input) {
        const errors = [];
        if (!input || typeof input !== 'object') return ['Enter the current player and planet values.'];
        if (!POLICIES[input.mode]) errors.push('Choose Rush, Normal or Slow.');
        const ranges = {
            social: [0, 100, true], playerLevel: [0, 1000, true], scienceRate: [0, 1e9],
            productionMultiplier: [0.001, 1000], growthMultiplier: [0.001, 1000], scienceMultiplier: [0.001, 1000],
            cash: [0, 1e12], ppPrice: [0.000001, 1e6], completedTas: [0, MAX_TAS, true],
            currentTradeBonusPct: [0, 10000]
        };
        for (const [key, limits] of Object.entries(ranges)) {
            if (!finite(input[key], ...limits)) errors.push(`Enter a valid ${key}; missing values cannot be treated as zero.`);
        }
        if (input.horizonDays !== undefined && !finite(input.horizonDays, 1 / 24, 180)) errors.push('Use a horizon between one hour and 180 days.');
        if (input.traderAccept !== undefined && typeof input.traderAccept !== 'boolean') errors.push('Trader acceptance must be true or false.');
        if (input.partnerQualifiedPlanets !== undefined && (!Array.isArray(input.partnerQualifiedPlanets)
            || input.partnerQualifiedPlanets.length > MAX_TAS
            || input.partnerQualifiedPlanets.some(n => !finite(n, 0, 100, true)))) errors.push('Partner counts must be whole numbers from 0 to 100.');
        if (!Array.isArray(input.planets) || !input.planets.length || input.planets.length > 100) {
            errors.push('Enter between 1 and 100 currently owned planets.');
            return errors;
        }
        const ids = new Set();
        input.planets.forEach((p, i) => {
            if (!p || typeof p !== 'object') { errors.push(`Planet ${i + 1} is missing.`); return; }
            const id = typeof p.id === 'number' && Number.isFinite(p.id) || typeof p.id === 'string' && p.id.trim();
            if (!id || ids.has(String(p.id))) errors.push(`Planet ${i + 1} needs a unique ID.`);
            ids.add(String(p.id));
            // Existing SU-funded levels may exceed the PP table. Preserve those levels;
            // candidate targets never request another purchase beyond the published table.
            for (const key of BUILDINGS) if (!finite(p[key], 0, 100, true)) errors.push(`Planet ${i + 1}: enter completed ${key} levels (0–100).`);
            if (!finite(p.population, 1, 100, true)) errors.push(`Planet ${i + 1}: enter completed population level (1–100).`);
            if (!finite(p.pp, 0, 1e12)) errors.push(`Planet ${i + 1}: enter its own unspent PP balance.`);
            for (const key of ['is_sieged', 'isSieged']) if (p[key] !== undefined && ![false, true, 0, 1].includes(p[key])) errors.push(`Planet ${i + 1}: its siege flag must be true or false.`);
            if (p.growthPoints !== undefined && !finite(p.growthPoints, 0, (T.POP_GROWTH[p.population + 1] || Infinity) - EPS)) errors.push(`Planet ${i + 1}: growth progress must be below the next level's cost.`);
        });
        return errors;
    }

    function plan(input) {
        const errors = validate(input);
        const base = { ok: false, mode: input?.mode, errors, warnings: [], assumptions: [] };
        if (errors.length) return base;
        const now = input.now === undefined ? Date.now() : timestamp(input.now);
        if (!Number.isFinite(now) || !Number.isFinite(new Date(now + 180 * 24 * HOUR).getTime())) {
            errors.push('Enter a valid forecast start timestamp.'); return base;
        }
        const policy = POLICIES[input.mode];
        if (input.completedTas < MAX_TAS && input.planets.length < policy.required) {
            errors.push(`${input.mode === 'rush' ? 'Rush' : input.mode === 'normal' ? 'Normal' : 'Slow'} needs ${policy.required} current planets at population 10; only ${input.planets.length} planets were supplied. Expand first, then refresh this plan.`);
            return base;
        }
        if (input.completedTas < MAX_TAS && input.social < 10 && input.scienceRate <= 0) {
            errors.push('Social 10 is needed for population 10. Enter a positive current science rate to estimate the research.'); return base;
        }
        const variants = policy.profiles.map(profile => simulate(input, now, policy, profile));
        // Lexicographic next-TA readiness: favour the earliest next agreement, then the
        // next one. Equal schedules favour less PP spent. This is a small policy sweep,
        // not a proof of the globally optimal building order.
        variants.sort((a, b) => {
            for (let i = 0; i < a.agreements.length; i++) {
                const left = a.agreements[i].fundedHours ?? Infinity;
                const right = b.agreements[i].fundedHours ?? Infinity;
                if (left !== right) return left - right;
            }
            return a.totals.buildingPP - b.totals.buildingPP;
        });
        const selected = variants[0];
        selected.selection = { candidates: variants.length, method: 'Earliest sequential funding within the selected strategy; ties prefer less building PP.', optimal: false };
        return selected;
    }

    function simulate(input, now, policy, profile) {
        const horizon = (input.horizonDays ?? 60) * 24;
        const iso = hours => hours === null ? null : new Date(now + Math.round(hours * HOUR)).toISOString();
        const popCap = social => social <= 25 ? T.popCap(social) : social;
        // Farms are useful for the population gate only on the first N promising planets.
        // Rank by existing population, then farms, then stable input order.
        const candidates = input.planets.map((p, index) => ({ p, index }))
            .sort((a, b) => b.p.population - a.p.population || b.p.HF - a.p.HF || a.index - b.index);
        const grow = new Set(candidates.slice(0, policy.required).map(c => c.index));
        const planets = input.planets.map((p, index) => {
            const start = { population: p.population, HF: p.HF, RF: p.RF, RL: p.RL, GC: p.GC, pp: p.pp };
            const target = Object.fromEntries(BUILDINGS.map((b, i) => [b,
                p.is_sieged || p.isSieged || b === 'HF' && (!grow.has(index) || p.population >= 10)
                    ? p[b] : Math.max(p[b], profile[i])
            ]));
            return { id: p.id, name: String(p.name || p.id), ...start, start, target,
                growthPoints: p.growthPoints ?? 0, isSieged: !!(p.is_sieged || p.isSieged), builds: [], savingHours: null };
        });
        let hours = 0, social = input.social, socialPoints = 0, cash = input.cash;
        let addedTradePct = 0, gateHours = planets.filter(p => p.population >= 10).length >= policy.required ? 0 : null;
        const totals = { buildingPP: 0, soldPP: 0, earnedPP: 0, spentCash: 0, sciencePoints: 0, saleProceeds: 0, lostSiegePP: 0 };
        const agreements = Array.from({ length: MAX_TAS - input.completedTas }, (_, i) => ({
            number: input.completedTas + i + 1, fundedHours: null, activeHours: null,
            cost: input.traderAccept ? 0 : FEE, partnerQualifiedPlanets: input.partnerQualifiedPlanets?.[i] ?? 0
        }));
        const warnings = [];
        const tradeFactor = () => (1 + (input.currentTradeBonusPct + addedTradePct) / 100) / (1 + input.currentTradeBonusPct / 100);
        const scienceRate = () => (input.scienceRate + planets.reduce((n, p) => n + p.population - p.start.population + p.RL - p.start.RL, 0) * input.scienceMultiplier) * tradeFactor();
        const productionRate = p => (p.RF + p.population) * input.productionMultiplier * tradeFactor();
        const growthRate = p => p.population < popCap(social) && p.population < 100 ? (p.HF + 1) * input.growthMultiplier * tradeFactor() : 0;
        const ready = p => BUILDINGS.every(b => p[b] >= p.target[b]);
        const saleFactor = p => p.isSieged ? 0.7 : 1;
        const canSell = () => planets.every(ready) && input.playerLevel >= 1 && planets.some(p => p.population >= 5)
            && planets.reduce((n, p) => n + p.pp, 0) >= 150 - EPS;
        const nextPurchase = p => {
            if (p.isSieged) return null;
            const remaining = policy.order.filter(b => p[b] < p.target[b]);
            remaining.sort((a, b) => T.BUILDING[p[a] + 1] - T.BUILDING[p[b] + 1] || policy.order.indexOf(a) - policy.order.indexOf(b));
            const building = remaining[0];
            return building ? { building, cost: T.BUILDING[p[building] + 1] } : null;
        };
        let iterations = 0;
        for (; iterations < 50000; iterations++) {
            for (const a of agreements) if (a.activeHours !== null && !a.activated && a.activeHours <= hours + EPS) {
                addedTradePct += a.partnerQualifiedPlanets;
                a.activated = true;
            }
            while (social < 10 && socialPoints >= T.SCIENCE[social + 1] - EPS) {
                socialPoints = Math.max(0, socialPoints - T.SCIENCE[social + 1]); social++;
            }
            // Do not recommend spending another PP when the entire remaining fee is
            // already covered and the population policy is met (including five TAs).
            const coveredByCash = cash >= agreements.filter(a => a.fundedHours === null).reduce((n, a) => n + a.cost, 0) - EPS;
            if (!agreements.length || coveredByCash && planets.filter(p => p.population >= 10).length >= policy.required) {
                for (const p of planets) for (const b of BUILDINGS) p.target[b] = p[b];
            }
            for (const p of planets) {
                while (p.population < popCap(social) && p.population < 100 && p.growthPoints >= T.POP_GROWTH[p.population + 1] - EPS) {
                    p.growthPoints = Math.max(0, p.growthPoints - T.POP_GROWTH[p.population + 1]); p.population++;
                }
                // Once the gate population is reached, stop buying farms for that gate.
                if (p.population >= 10) p.target.HF = p.HF;
                for (let purchase = nextPurchase(p); purchase && p.pp >= purchase.cost - EPS; purchase = nextPurchase(p)) {
                    const from = p[purchase.building];
                    p.pp = Math.max(0, p.pp - purchase.cost); p[purchase.building]++;
                    totals.buildingPP += purchase.cost;
                    p.builds.push({ building: purchase.building, from, to: from + 1, cost: purchase.cost, hours, at: iso(hours) });
                }
                if (ready(p) && p.savingHours === null) p.savingHours = hours;
            }
            if (gateHours === null && planets.filter(p => p.population >= 10).length >= policy.required) gateHours = hours;
            if (gateHours !== null) for (const agreement of agreements) {
                if (agreement.fundedHours !== null) continue;
                const available = canSell() ? planets.filter(ready).reduce((n, p) => n + p.pp * input.ppPrice * saleFactor(p), 0) : 0;
                if (cash + available < agreement.cost - EPS) break;
                // The documented Spend All action sells every planet's PP. Wait until
                // construction is complete everywhere so no protected building budget
                // is liquidated, and keep surplus cash for subsequent agreements.
                if (cash < agreement.cost - EPS) for (const p of planets) {
                    const sold = p.pp;
                    const proceeds = sold * input.ppPrice * saleFactor(p);
                    p.pp = 0; cash += proceeds;
                    totals.soldPP += sold; totals.saleProceeds += proceeds; totals.lostSiegePP += sold * (1 - saleFactor(p));
                }
                cash = Math.max(0, cash - agreement.cost); totals.spentCash += agreement.cost;
                agreement.fundedHours = hours;
                agreement.activeHours = (nextTradeActivation(now + hours * HOUR) - now) / HOUR;
            }
            if (hours >= horizon - EPS || agreements.every(a => a.fundedHours !== null)) break;
            let step = horizon - hours;
            const limit = n => { if (Number.isFinite(n) && n > EPS) step = Math.min(step, n); };
            for (const a of agreements) if (a.activeHours !== null && !a.activated) limit(a.activeHours - hours);
            const sci = scienceRate();
            if (social < 10 && sci > 0) limit((T.SCIENCE[social + 1] - socialPoints) / sci);
            for (const p of planets) {
                const prod = productionRate(p), growth = growthRate(p), buy = nextPurchase(p);
                if (buy) limit((buy.cost - p.pp) / prod);
                if (growth > 0) limit((T.POP_GROWTH[p.population + 1] - p.growthPoints) / growth);
            }
            const nextTA = agreements.find(a => a.fundedHours === null);
            if (gateHours !== null && nextTA && planets.every(ready) && input.playerLevel >= 1 && planets.some(p => p.population >= 5)) {
                const liquid = planets.filter(ready);
                const value = liquid.reduce((n, p) => n + p.pp * input.ppPrice * saleFactor(p), 0);
                const income = liquid.reduce((n, p) => n + productionRate(p) * input.ppPrice * saleFactor(p), 0);
                if (income > 0) limit((nextTA.cost - cash - value) / income);
                const allPP = planets.reduce((n, p) => n + p.pp, 0);
                if (allPP < 150 - EPS) limit((150 - allPP) / planets.reduce((n, p) => n + productionRate(p), 0));
            }
            if (!Number.isFinite(step) || step <= EPS) { warnings.push('The event simulation reached its numerical limit. Refresh the snapshot before relying on a later estimate.'); break; }
            for (const p of planets) {
                const earned = productionRate(p) * step;
                p.pp += earned; totals.earnedPP += earned;
                p.growthPoints += growthRate(p) * step;
            }
            totals.sciencePoints += sci * step;
            if (social < 10) socialPoints += sci * step;
            hours += step;
        }
        if (iterations >= 50000) warnings.push('The event limit was reached; later milestones are unknown.');
        if (agreements.some(a => a.fundedHours === null)) warnings.push('Some agreements are not fundable within the forecast horizon under these assumptions.');
        if (input.playerLevel < 1) warnings.push('PP sales require Player Level 1. Its future growth is not predicted; existing cash may still fund agreements.');
        if (planets.some(p => p.isSieged)) warnings.push('Sieged planets keep producing and growing, but only 70% of sold PP becomes cash. No buildings are scheduled there while the siege persists.');
        const allSaving = planets.every(p => p.savingHours !== null);
        const savingHours = allSaving ? Math.max(...planets.map(p => p.savingHours)) : null;
        const assumptions = [
            `PP sale price remains ${input.ppPrice} A$/PP; future market movement is not predicted.`,
            'Only currently supplied planets are simulated. No colonisation, transfers, attacks, Supply Units, artifact purchases or random spontaneous growth are assumed.',
            'PP is sold with Spend All after construction finishes on every planet; all sale proceeds become cash, including any surplus over the next fee.',
            'Building and growth costs use the published rounded tables; hosting-cycle delays can shift the exact result.',
            'All current bonuses are already included in the supplied multipliers. New trade bonuses use the partner population-10 counts supplied for each agreement.',
            'Funded means this player can pay; activation additionally assumes a willing, funded partner, then the next Berlin 00/06/12/18 boundary plus five minutes.'
        ];
        if (input.planets.some(p => p.growthPoints === undefined)) assumptions.push('Missing within-level population progress is conservatively treated as zero.');
        if (input.social < 10) assumptions.push('Research switches to Social until level 10, with zero existing progress credited; other research can continue afterward. Science points are never spent as PP.');
        if (!input.partnerQualifiedPlanets || input.partnerQualifiedPlanets.length < agreements.length) assumptions.push('Unknown future partners add zero forecast trade bonus; fill their qualifying planet counts to include that benefit.');
        if (input.traderAccept) assumptions.push('Every forecast agreement is accepted by a confirmed Trader for free; initiating still costs 20,000 A$.');
        return { ok: true, mode: input.mode, errors: [], warnings, assumptions, horizonHours: horizon,
            gate: { requiredPlanets: policy.required, qualifiedNow: input.planets.filter(p => p.population >= 10).length, population: 10, at: iso(gateHours), hours: gateHours },
            savingAt: iso(savingHours), savingHours,
            agreements: agreements.map(({ activated, ...a }) => ({ ...a, fundedAt: iso(a.fundedHours), activeAt: iso(a.activeHours) })),
            planets: planets.map(p => ({ id: p.id, name: p.name, start: p.start, target: p.target,
                final: { population: p.population, HF: p.HF, RF: p.RF, RL: p.RL, GC: p.GC, pp: p.pp },
                builds: p.builds, savingAt: iso(p.savingHours), savingHours: p.savingHours })),
            totals: { ...totals, cash, pp: planets.reduce((n, p) => n + p.pp, 0), simulatedHours: hours, social },
            profile: Object.fromEntries(BUILDINGS.map((b, i) => [b, profile[i]]))
        };
    }

    return { plan, validate, nextTradeActivation, constants: { FEE, MAX_TAS } };
});
