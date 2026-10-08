// Trade-agreement Schedule: when each confirmed agreement can really go live, and who has to
// do what before which trade cycle. Dual-runtime (see AGENTS.md): no import/export.
//
// The rules it plans against (docs/game-rules.md#trade-agreements, confirmed by the operator
// 2026-09-26):
//   - the SENDER pays 20,000 A$ when sending the offer;
//   - the ACCEPTOR pays 20,000 A$ when accepting it, or nothing if their race is Trader,
//     so a Trader is always planned as the acceptor;
//   - the agreement only goes live at the next trade cycle AFTER it is accepted
//     (00:00/06:00/12:00/18:00 Europe/Berlin, AWRoadToTA.nextTradeActivation), and only
//     from then on do both sides get the TR%;
//   - an offer nobody accepts expires after 2 days, so the sender waits until the acceptor
//     can pay within that window instead of sending the moment they can afford it.
//
// Each side's income is their production sold at the PP price, and on activation it grows by
// the partner's population-10 planet count in TR%, applied the way the game stacks bonuses:
// (1 + (TR + gain)/100) / (1 + TR/100).
//
// Order: repeatedly take the pending agreement that can go live soonest (ties: the bigger
// combined TR gain). An exhaustive check over all 3.6M orders of the ten agreements pending on
// 2026-09-26 found no order that does meaningfully better (924 vs 923 TR%-days over 14 days),
// so the value of this model is in the dates and the actions, not in a clever order.
(function (root, factory) {
    const isNode = typeof module === 'object' && module && module.exports;
    const api = factory(isNode ? require('./road-to-ta-model.js') : root.AWRoadToTA);
    if (isNode) module.exports = api;
    root.AWTaSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RoadToTA) {
    'use strict';

    const FEE = 20000;
    const HOUR = 3600000;
    const TICK = 5 * 60000;            // the game credits income every 5-minute hosting cycle
    const OFFER_LIFETIME = 48 * HOUR;
    const ACTIVATION_SLACK = 5 * 60000; // nextTradeActivation adds this after the cycle
    const HORIZON = 90 * 24 * HOUR;     // beyond this, "cannot afford" rather than a date

    const ceilTick = t => Math.ceil(t / TICK) * TICK;

    // A member's money over time: a starting balance, an income rate that steps up at each
    // activation, and the payments already committed.
    function makeLedger(member, now) {
        return {
            name: member.name,
            trader: !!member.trader,
            pop10: member.pop10 || 0,
            tr: member.tr || 0,
            start: now,
            balance: member.saved || 0,
            rates: [{ at: now, perHour: Math.max(0, member.rate || 0) }],
            payments: [],
            lastPayment: -Infinity,
        };
    }

    function rateAt(ledger, t) {
        let r = ledger.rates[0].perHour;
        for (const seg of ledger.rates) if (seg.at <= t) r = seg.perHour;
        return r;
    }

    function moneyAt(ledger, t) {
        let money = ledger.balance, cursor = ledger.start;
        const points = ledger.rates.map(s => s.at).filter(x => x > ledger.start && x < t).sort((a, b) => a - b);
        for (const p of points.concat([t])) {
            money += rateAt(ledger, cursor) * (p - cursor) / HOUR;
            cursor = p;
        }
        for (const pay of ledger.payments) if (pay.at <= t) money -= pay.amount;
        return money;
    }

    // Earliest instant ≥ from at which the member has `amount` in hand. Payments are kept in
    // time order per member, so nothing committed later can be starved by this one.
    function earliestAfford(ledger, from, amount) {
        let t = ceilTick(Math.max(from, ledger.lastPayment));
        if (amount <= 0) return t;
        const breaks = ledger.rates.map(s => s.at).filter(x => x > t).sort((a, b) => a - b);
        for (const end of breaks.concat([t + HORIZON])) {
            const m = moneyAt(ledger, t);
            if (m >= amount - 1e-6) return t;
            const r = rateAt(ledger, t);
            if (r > 0) {
                const reach = t + (amount - m) / r * HOUR;
                if (reach <= end) return ceilTick(reach);
            }
            t = end;
        }
        return null;
    }

    function applyActivation(ledger, at, gain) {
        const current = rateAt(ledger, at);
        const factor = (1 + (ledger.tr + gain) / 100) / (1 + ledger.tr / 100);
        ledger.rates.push({ at, perHour: current * factor });
        ledger.rates.sort((a, b) => a.at - b.at);
        // Segments after `at` were computed before this boost; scale them too.
        for (const seg of ledger.rates) if (seg.at > at) seg.perHour *= factor;
        ledger.tr += gain;
    }

    // Best way to run one agreement from the current state, or null if it cannot be funded.
    function bestPlanFor(a, b, now, fee) {
        const options = [];
        const directions = a.trader && !b.trader ? [[b, a]] : b.trader && !a.trader ? [[a, b]] : [[a, b], [b, a]];
        for (const [sender, acceptor] of directions) {
            const acceptFee = acceptor.trader ? 0 : fee;
            const canSend = earliestAfford(sender, now, fee);
            if (canSend === null) continue;
            const canAccept = earliestAfford(acceptor, canSend, acceptFee);
            if (canAccept === null) continue;
            // Do not let the offer expire: send no earlier than 2 days (less a margin)
            // before the acceptor will be able to pay.
            const sendAt = Math.max(canSend, ceilTick(canAccept - OFFER_LIFETIME + HOUR));
            const activeAt = RoadToTA.nextTradeActivation(canAccept);
            options.push({ sender, acceptor, sendAt, acceptAt: canAccept, cycleAt: activeAt - ACTIVATION_SLACK, activeAt, senderFee: fee, acceptorFee: acceptFee });
        }
        options.sort((x, y) => x.activeAt - y.activeAt || x.acceptAt - y.acceptAt || x.sendAt - y.sendAt);
        return options[0] || null;
    }

    /**
     * @param {object} input
     * @param {number} input.now  epoch ms
     * @param {Array<{name, saved, rate, trader, pop10, tr}>} input.members  saved in A$, rate in A$/h
     * @param {Array<[string, string]>} input.pairs  confirmed agreements not yet sent in game
     * @param {Array<{a, b, state, sender, since}>} [input.inFlight]  offers already sent:
     *   state 'pending' (only the sender has paid) or 'establishing' (accepted, live at the
     *   next cycle); sender may be null when unknown; since = epoch ms the hub first saw it.
     *   Their sender's fee is already out of that member's balance, so planning them as
     *   pairs would make the sender pay twice; dropping them would forget the acceptor's fee
     *   and the TR% they add.
     * @param {number} [input.fee]
     */
    function plan({ now, members, pairs, inFlight = [], fee = FEE }) {
        const ledgers = new Map();
        for (const m of members) ledgers.set(String(m.name).toLowerCase(), makeLedger(m, now));
        const missing = new Set();
        const lookup = (name) => {
            const l = ledgers.get(String(name).toLowerCase());
            if (!l) missing.add(name);
            return l;
        };
        let pending = [];
        for (const [x, y] of pairs) {
            const a = lookup(x), b = lookup(y);
            if (a && b) pending.push([a, b]);
        }

        const steps = [], unfunded = [], expired = [];
        const activate = (sender, acceptor, activeAt) => {
            const senderGain = acceptor.pop10, acceptorGain = sender.pop10;
            applyActivation(sender, activeAt, senderGain);
            applyActivation(acceptor, activeAt, acceptorGain);
            return { senderGain, acceptorGain };
        };

        // Committed first: accepted ones only add their TR% at the cycle, then pending ones
        // in the order they expire, each acceptor paying before anything else they plan.
        const order = { establishing: 0, pending: 1 };
        const flights = inFlight.filter(f => f.state in order)
            .sort((x, y) => order[x.state] - order[y.state] || (x.since || 0) - (y.since || 0));
        for (const f of flights) {
            const a = lookup(f.a), b = lookup(f.b);
            if (!a || !b) continue;
            const since = f.since || now;
            const knownSender = f.sender ? String(f.sender).toLowerCase() : null;
            let sender = knownSender === b.name.toLowerCase() ? b : knownSender === a.name.toLowerCase() ? a : null;
            if (f.state === 'establishing') {
                const activeAt = RoadToTA.nextTradeActivation(since);
                if (activeAt <= now) continue;               // already live: in today's TR%
                const [s, c] = sender === b ? [b, a] : [a, b];
                steps.push({ sender: s.name, acceptor: c.name, senderKnown: !!sender, acceptorIsTrader: c.trader, state: 'establishing',
                    sendAt: null, acceptAt: since, cycleAt: activeAt - ACTIVATION_SLACK, activeAt, ...activate(s, c, activeAt) });
                continue;
            }
            const expiresAt = since + OFFER_LIFETIME;
            if (expiresAt <= now) { expired.push([a.name, b.name]); continue; }
            // Unknown sender: a Trader is the acceptor, otherwise whoever can pay sooner.
            let options = sender ? [[sender, sender === a ? b : a]]
                : a.trader && !b.trader ? [[b, a]] : b.trader && !a.trader ? [[a, b]] : [[a, b], [b, a]];
            let best = null;
            for (const [s, c] of options) {
                const acceptorFee = c.trader ? 0 : fee;
                const acceptAt = earliestAfford(c, now, acceptorFee);
                if (acceptAt === null) continue;
                if (!best || acceptAt < best.acceptAt) best = { s, c, acceptorFee, acceptAt };
            }
            if (!best) { unfunded.push([a.name, b.name]); continue; }
            const { s, c } = best;
            if (best.acceptorFee > 0) c.payments.push({ at: best.acceptAt, amount: best.acceptorFee });
            c.lastPayment = Math.max(c.lastPayment, best.acceptAt);
            const activeAt = RoadToTA.nextTradeActivation(best.acceptAt);
            steps.push({ sender: s.name, acceptor: c.name, senderKnown: !!sender, acceptorIsTrader: c.trader, state: 'pending',
                sendAt: since, expiresAt, late: best.acceptAt > expiresAt, acceptAt: best.acceptAt,
                cycleAt: activeAt - ACTIVATION_SLACK, activeAt, ...activate(s, c, activeAt) });
        }
        while (pending.length) {
            let best = null, bestIdx = -1;
            pending.forEach(([a, b], i) => {
                const p = bestPlanFor(a, b, now, fee);
                if (!p) return;
                const gain = a.pop10 + b.pop10;
                if (!best || p.activeAt < best.activeAt || (p.activeAt === best.activeAt && gain > best.gain)) {
                    best = { ...p, gain };
                    bestIdx = i;
                }
            });
            if (!best) { unfunded.push(...pending.map(([a, b]) => [a.name, b.name])); break; }
            const { sender, acceptor } = best;
            sender.payments.push({ at: best.sendAt, amount: best.senderFee });
            sender.lastPayment = best.sendAt;
            if (best.acceptorFee > 0) acceptor.payments.push({ at: best.acceptAt, amount: best.acceptorFee });
            acceptor.lastPayment = Math.max(acceptor.lastPayment, best.acceptAt);
            const { senderGain, acceptorGain } = activate(sender, acceptor, best.activeAt);
            steps.push({
                sender: sender.name, acceptor: acceptor.name, acceptorIsTrader: acceptor.trader,
                sendAt: best.sendAt, acceptAt: best.acceptAt, cycleAt: best.cycleAt, activeAt: best.activeAt,
                senderGain, acceptorGain,
            });
            pending.splice(bestIdx, 1);
        }
        const finish = steps.length ? Math.max(...steps.map(s => s.activeAt)) : null;
        return { steps, unfunded, expired, missing: [...missing], finish };
    }

    // TR%-days gained before `horizon`: how much trade bonus the plan actually delivers, and
    // for how long. Used to compare plans, e.g. with and without selling stockpiles.
    function trDays(result, horizon) {
        return result.steps.reduce((s, st) => s + (st.senderGain + st.acceptorGain) * Math.max(0, horizon - st.activeAt) / (24 * HOUR), 0);
    }

    return { plan, trDays, constants: { FEE, OFFER_LIFETIME } };
});
