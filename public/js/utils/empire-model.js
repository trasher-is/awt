// Forward simulation of ONE empire: you give it a race and the building levels every planet
// should end up at, it tells you whether 60 days is enough and where the time went.
//
// This is not an optimiser. It does not search race picks. Inputs in, timeline out.
//
// LOADING: dual-runtime, like travel-model.js — no import/export.
//   • Node:    require('../../public/js/utils/empire-model.js')
//   • Browser: import '../utils/game-tables.js'; import '../utils/travel-model.js';
//              import '../utils/empire-model.js';  then read globalThis.AWEmpire
//
// ─── WHAT IS GROUND TRUTH HERE AND WHAT IS NOT ────────────────────────────────
// Confirmed, from docs/game-rules.md:
//   growth/h = (hydroponic farms + 1) × growth bonus        per planet
//   PP/h     = (robotic factories + population) × prod bonus per planet
//   sci/h    = (research labs + population) × sci bonus      per planet, one field at a time
//   population is capped by social level; culture level is the planet cap
//   bonuses stack multiplicatively: total = Π(1 + each) − 1
//
// NOT CONFIRMED — the one formula in here with no published source:
//   cult/h = galactic cybernets × culture bonus
// docs/game-rules.md publishes the culture COST table but never a culture RATE formula. The
// line above is inherited from the old standalone sim and has never been checked against the
// game. It decides how fast planet slots unlock, which is the single biggest driver of a
// wide build, so treat planet-count output as indicative until someone verifies it in game.
// `cultureFormula: 'gc+1'` is offered because every other rate in the game has a base term;
// if the real rate turns out to have one, switch the default rather than editing rates
// elsewhere. Whatever is confirmed belongs in docs/game-rules.md first, per AGENTS.md.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWEmpire = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const isNode = typeof module === 'object' && module !== null && !!module.exports;
    const T = isNode ? require('./game-tables.js') : globalThis.AWTables;
    const TRAVEL = isNode ? require('./travel-model.js') : globalThis.AWTravelModel;

    // Per-point race trait rates. Deliberately not all equal — do not unify them.
    // attack/defence raised 7%/11% -> 8%/12% by patch 6.0.0-beta (2026-08-28 changelog,
    // "Combat Balance Changes") — see docs/game-rules.md's Race picks table.
    const TRAIT_PCT = {
        growth: 0.08, science: 0.08, culture: 0.04,
        production: 0.04, speed: 0.11, attack: 0.08, defence: 0.12
    };

    const BUILDINGS = ['HF', 'RF', 'GC', 'RL', 'SB'];
    const SCIENCE_FIELDS = ['biology', 'economy', 'energy', 'mathematics', 'physics', 'social'];

    // Startup Lab gives the home planet 12 research labs already built.
    const STARTUP_LAB_RL = 12;

    // Spontaneous growth: a planet 6+ population levels below your social level gets a free
    // level at the daily update.
    const SPONTANEOUS_GAP = 6;

    const DEFAULTS = {
        days: 60,
        tickMinutes: 60,

        race: {
            growth: 0, science: 0, culture: 0, production: 0,
            speed: 0, attack: 0, defence: 0,
            startupLab: false, trader: false
        },

        // The levels EVERY planet should reach. This is the headline input.
        targets: { HF: 12, RF: 13, GC: 13, RL: 13, SB: 0 },

        // 'balanced' spends on the lowest-level unfinished building anywhere, which follows
        // the cost curve (level 13 costs 649 PP, level 1 costs 5) and keeps planets level.
        // 'priority' finishes each type in buildOrder before starting the next.
        buildMode: 'balanced',
        buildOrder: ['RF', 'GC', 'HF', 'RL', 'SB'],

        // Ordered research plan. Reached in sequence; leftover points carry to the next.
        sciencePlan: [
            { field: 'social', level: 10 },
            { field: 'energy', level: 40 }
        ],
        // What to research once the plan is finished. null means nothing, and the science
        // produced from then on is counted as wasted rather than quietly vanishing.
        scienceOverflow: null,

        // Colony ships sent per new colony. 1 colonises with nothing; 3+ disband the extras
        // into starting PP at 15 each (2 is strictly wasteful — 60 PP for nothing).
        colonyShips: 1,
        // Colonisation outbids the build queue for PP. A new planet compounds; a building
        // level does not.
        colonyFirst: true,
        maxPlanets: 0,             // 0 = limited only by culture level

        // Where new colonies are, for travel time. systemDistance 0 = same system as home.
        colonyRoute: { planetDelta: 3, systemDistance: 0 },

        // Trade agreements: rate is the TR% as a fraction. The +5% join-cohort economy bonus
        // is ADDITIVE to TR% before everything multiplies.
        tradeRate: 0,
        economyBonus: false,
        // TR% is applied to these rates.
        tradeAffects: ['growth', 'science', 'culture', 'production'],

        // Artifact by exact name from the table, e.g. 'Memory Jar 3'. One at a time.
        // Player level is NOT simulated (it needs combat XP plus unverified autogrowth), so
        // the artifact's own player-level gate is reported as a warning, never enforced.
        artifact: null,
        artifactFromDay: 0,

        cultureFormula: 'gc',      // 'gc' (assumed default) or 'gc+1'
        startingPP: 300
    };

    function merge(base, over) {
        const out = {};
        for (const k of Object.keys(base)) {
            const b = base[k], o = over ? over[k] : undefined;
            if (o === undefined) { out[k] = Array.isArray(b) ? b.slice() : (b && typeof b === 'object' ? merge(b, null) : b); }
            else if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = merge(b, o);
            else out[k] = Array.isArray(o) ? o.slice() : o;
        }
        // let callers add keys the defaults do not know about
        if (over) for (const k of Object.keys(over)) if (!(k in out)) out[k] = over[k];
        return out;
    }

    // total = Π(1 + each) − 1, per docs/game-rules.md. Returns the MULTIPLIER, not the bonus.
    function stackMultiplier(bonuses) {
        let m = 1;
        for (const b of bonuses) m *= (1 + b);
        return m;
    }

    class Planet {
        constructor(id, buildings) {
            this.id = id;
            this.popLevel = 1;
            this.popPoints = 0;
            this.pp = 0;                 // colony starting PP lands here, then pools
            this.buildings = Object.assign({ HF: 0, RF: 0, GC: 0, RL: 0, SB: 0 }, buildings || {});
            this.bornDay = 0;
        }
    }

    class Empire {
        constructor(cfg) {
            this.cfg = cfg;
            this.race = cfg.race;

            this.pp = cfg.startingPP;
            this.spent = { buildings: 0, colonyShips: 0 };

            const home = new Planet(1, cfg.race.startupLab ? { RL: STARTUP_LAB_RL } : null);
            this.planets = [home];
            this.inFlight = [];          // { arriveAt, ships }

            this.culturePoints = 0;
            this.cultureLevel = 1;

            this.science = {};
            for (const f of SCIENCE_FIELDS) this.science[f] = 0;
            this.sciencePoints = 0;      // points banked toward the current plan step
            this.planIndex = 0;
            this.scienceWasted = 0;      // produced after the plan ran out, with no overflow field

            this.hours = 0;
            this.warnings = [];
            this.milestones = [];
            this.history = [];
        }

        // ── rates ────────────────────────────────────────────────────────────────
        artifactBonus(kind) {
            const cfg = this.cfg;
            if (!cfg.artifact) return 0;
            if (this.hours < cfg.artifactFromDay * 24) return 0;
            const a = T.ARTIFACTS.find(x => x.name === cfg.artifact);
            return a ? a[kind] : 0;
        }

        tradeBonus(kind) {
            const cfg = this.cfg;
            if (!cfg.tradeAffects.includes(kind)) return 0;
            return cfg.tradeRate + (cfg.economyBonus ? 0.05 : 0);
        }

        multiplier(kind) {
            return stackMultiplier([
                (this.race[kind] || 0) * TRAIT_PCT[kind],
                this.artifactBonus(kind),
                this.tradeBonus(kind)
            ]);
        }

        popCap() { return T.popCap(this.science.social); }

        growthRate() {
            const m = this.multiplier('growth');
            const cap = this.popCap();
            return this.planets.reduce((s, p) =>
                s + (p.popLevel >= cap ? 0 : (p.buildings.HF + 1) * m), 0);
        }

        ppRate() {
            const m = this.multiplier('production');
            return this.planets.reduce((s, p) => s + (p.buildings.RF + p.popLevel) * m, 0);
        }

        sciRate() {
            const m = this.multiplier('science');
            return this.planets.reduce((s, p) => s + (p.buildings.RL + p.popLevel) * m, 0);
        }

        cultureRate() {
            const m = this.multiplier('culture');
            const base = this.cfg.cultureFormula === 'gc+1' ? 1 : 0;
            return this.planets.reduce((s, p) => s + (p.buildings.GC + base) * m, 0);
        }

        totalPop() { return this.planets.reduce((s, p) => s + p.popLevel, 0); }

        // Score: population levels above 10, plus science levels above 20, plus player level
        // (not simulated, so omitted — reported as a floor, not a total).
        scoreFloor() {
            let s = 0;
            for (const p of this.planets) s += Math.max(0, p.popLevel - 10);
            for (const f of SCIENCE_FIELDS) s += Math.max(0, this.science[f] - 20);
            return s;
        }

        // Cost still outstanding to bring every planet to target, at today's planet count.
        remainingBuildPP() {
            let sum = 0;
            for (const p of this.planets) {
                for (const b of BUILDINGS) {
                    sum += T.aggregate(T.BUILDING, p.buildings[b], this.cfg.targets[b] || 0);
                }
            }
            return sum;
        }

        targetsMet() {
            return this.planets.every(p =>
                BUILDINGS.every(b => p.buildings[b] >= (this.cfg.targets[b] || 0)));
        }

        note(kind, text) {
            this.milestones.push({
                day: Math.floor(this.hours / 24) + 1,
                hour: Math.round(this.hours % 24),
                kind, text
            });
        }

        // ── the tick ─────────────────────────────────────────────────────────────
        tick(dt) {
            this.grow(dt);
            this.produce(dt);
            this.research(dt);
            this.culture(dt);
            this.landFlights();
            this.spend();
            this.hours += dt;
        }

        grow(dt) {
            const m = this.multiplier('growth');
            const cap = this.popCap();
            for (const p of this.planets) {
                if (p.popLevel >= cap) continue;
                p.popPoints += (p.buildings.HF + 1) * m * dt;
                while (p.popLevel < cap && p.popLevel < T.maxLevel(T.POP_GROWTH)) {
                    const cost = T.POP_GROWTH[p.popLevel + 1];
                    if (p.popPoints < cost) break;
                    p.popPoints -= cost;
                    p.popLevel++;
                }
            }
        }

        produce(dt) { this.pp += this.ppRate() * dt; }

        research(dt) {
            const plan = this.cfg.sciencePlan;
            const produced = this.sciRate() * dt;

            if (this.planIndex >= plan.length) {
                // Plan finished. Either keep pushing one field, or admit the output is lost.
                const field = this.cfg.scienceOverflow;
                if (!field || !(field in this.science)) { this.scienceWasted += produced; return; }
                this.sciencePoints += produced;
                while (this.science[field] < T.maxLevel(T.SCIENCE)) {
                    const cost = T.SCIENCE[this.science[field] + 1];
                    if (this.sciencePoints < cost) break;
                    this.sciencePoints -= cost;
                    this.science[field]++;
                }
                return;
            }

            this.sciencePoints += produced;

            // A step can complete mid-tick; the leftover rolls into the next step rather
            // than being dropped, and several steps can fall in one tick.
            for (;;) {
                if (this.planIndex >= plan.length) break;
                const step = plan[this.planIndex];
                const field = step.field;
                if (!(field in this.science)) {
                    this.warnings.push(`unknown science field "${field}" in sciencePlan — skipped`);
                    this.planIndex++;
                    continue;
                }
                if (this.science[field] >= step.level) { this.planIndex++; continue; }
                const next = this.science[field] + 1;
                if (next > T.maxLevel(T.SCIENCE)) { this.planIndex++; continue; }
                const cost = T.SCIENCE[next];
                if (this.sciencePoints < cost) break;
                this.sciencePoints -= cost;
                this.science[field] = next;
                if (next === step.level) {
                    this.note('science', `${field} reached ${next}`);
                    this.planIndex++;
                }
            }
        }

        culture(dt) {
            this.culturePoints += this.cultureRate() * dt;
            while (this.cultureLevel < T.maxLevel(T.CULTURE)) {
                const cost = T.CULTURE[this.cultureLevel + 1];
                if (this.culturePoints < cost) break;
                this.culturePoints -= cost;
                this.cultureLevel++;
                this.note('culture', `culture ${this.cultureLevel} — ${this.cultureLevel} planet slots`);
            }
        }

        // ── colonisation ─────────────────────────────────────────────────────────
        planetLimit() {
            const hard = this.cfg.maxPlanets || Infinity;
            return Math.min(this.cultureLevel, hard);
        }

        colonyFlightSeconds() {
            const r = this.cfg.colonyRoute;
            return TRAVEL.calcTravelSeconds(
                0, 0, 0,
                r.systemDistance, 0, r.planetDelta,
                this.science.energy, this.race.speed, false
            );
        }

        tryColonise() {
            const pending = this.planets.length + this.inFlight.length;
            if (pending >= this.planetLimit()) return false;
            const ships = Math.max(1, Math.floor(this.cfg.colonyShips));
            const cost = ships * T.CIVIL_SHIP_PP;
            if (this.pp < cost) return false;

            this.pp -= cost;
            this.spent.colonyShips += cost;
            const seconds = this.colonyFlightSeconds();
            this.inFlight.push({ arriveAt: this.hours + seconds / 3600, ships });
            return true;
        }

        landFlights() {
            const still = [];
            for (const f of this.inFlight) {
                if (f.arriveAt > this.hours) { still.push(f); continue; }
                const p = new Planet(this.planets.length + 1);
                p.bornDay = Math.floor(this.hours / 24) + 1;
                this.planets.push(p);
                this.pp += T.colonyStartingPP(f.ships);
                this.note('colony', `planet ${p.id} colonised (${f.ships} CS)`);
            }
            this.inFlight = still;
        }

        // ── spending ─────────────────────────────────────────────────────────────
        // Every candidate next building level, ranked. 'balanced' takes the cheapest level
        // anywhere (all building types share one cost table, so cheapest == lowest level);
        // 'priority' finishes types in buildOrder first.
        bestPurchase() {
            const cfg = this.cfg;
            let best = null;
            for (const p of this.planets) {
                for (let i = 0; i < cfg.buildOrder.length; i++) {
                    const b = cfg.buildOrder[i];
                    const target = cfg.targets[b] || 0;
                    const level = p.buildings[b];
                    if (level >= target) continue;
                    const next = level + 1;
                    if (next > T.maxLevel(T.BUILDING)) continue;   // needs Supply Units, not PP
                    const key = cfg.buildMode === 'priority'
                        ? [i, level, p.id]
                        : [level, i, p.id];
                    if (!best || cmp(key, best.key) < 0) {
                        best = { key, planet: p, building: b, level: next, cost: T.BUILDING[next] };
                    }
                }
            }
            return best;
        }

        spend() {
            // Bounded so a zero-cost or mis-specified table can never spin forever.
            for (let guard = 0; guard < 5000; guard++) {
                if (this.cfg.colonyFirst && this.tryColonise()) continue;
                const buy = this.bestPurchase();
                if (!buy || this.pp < buy.cost) {
                    if (!this.cfg.colonyFirst && this.tryColonise()) continue;
                    return;
                }
                this.pp -= buy.cost;
                this.spent.buildings += buy.cost;
                buy.planet.buildings[buy.building] = buy.level;
            }
        }

        // ── the daily update, 00:00 CET ───────────────────────────────────────────
        dailyUpdate() {
            const cap = this.popCap();
            const social = this.science.social;
            // Spontaneous growth picks a random eligible planet in game. The sim picks the
            // lowest-population one so a run is reproducible; over 60 days the count of
            // free levels is what matters, not which planet got them.
            const eligible = this.planets
                .filter(p => p.popLevel + SPONTANEOUS_GAP <= social && p.popLevel < cap)
                .sort((a, b) => a.popLevel - b.popLevel || a.id - b.id);
            if (eligible.length) eligible[0].popLevel++;
        }

        sample() {
            this.history.push({
                day: Math.floor(this.hours / 24),
                planets: this.planets.length,
                pop: this.totalPop(),
                ppRate: this.ppRate(),
                sciRate: this.sciRate(),
                cultureLevel: this.cultureLevel,
                pp: this.pp,
                remainingBuildPP: this.remainingBuildPP(),
                score: this.scoreFloor()
            });
        }
    }

    // lexicographic compare of equal-length numeric keys
    function cmp(a, b) {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
    }

    function validate(cfg, warnings) {
        const r = cfg.race;
        const sum = TRAIT_SUM(r);
        if (sum !== 0) {
            warnings.push(`race picks sum to ${sum}, not 0 — the game's creation screen would reject this`);
        }
        for (const b of Object.keys(cfg.targets)) {
            if (!BUILDINGS.includes(b)) warnings.push(`unknown building "${b}" in targets — ignored`);
            else if (cfg.targets[b] > T.maxLevel(T.BUILDING)) {
                warnings.push(`${b} target ${cfg.targets[b]} is past level ${T.maxLevel(T.BUILDING)}, ` +
                    `where the game stops taking production points and wants Supply Units — capped`);
                cfg.targets[b] = T.maxLevel(T.BUILDING);
            }
        }
        if (cfg.colonyShips === 2) {
            warnings.push('colonyShips: 2 wastes 60 PP — the single extra ship does not disband. Use 1 or 3+.');
        }
        if (cfg.artifact) {
            const a = T.ARTIFACTS.find(x => x.name === cfg.artifact);
            if (!a) warnings.push(`unknown artifact "${cfg.artifact}" — no bonus applied`);
            else warnings.push(`artifact "${a.name}" needs player level ${a.playerLevel} and ` +
                `$${a.basePrice.toLocaleString()}; player level and A$ are not simulated, so this ` +
                `assumes you own it from day ${cfg.artifactFromDay}`);
        }
        if (cfg.tradeRate > 0) {
            warnings.push(`TR ${Math.round(cfg.tradeRate * 100)}% assumed held for the whole run; ` +
                'trade-agreement cost, the 5-per-player cap and the 6-hourly accept window are not simulated');
        }
        if (cfg.cultureFormula === 'gc') {
            warnings.push('culture rate = cybernets × bonus is ASSUMED, not published — planet count is indicative');
        }
    }

    const TRAIT_SUM = r =>
        (r.growth || 0) + (r.science || 0) + (r.culture || 0) + (r.production || 0) +
        (r.speed || 0) + (r.attack || 0) + (r.defence || 0) +
        (r.startupLab ? 1 : 0) + (r.trader ? 6 : 0);

    function simulate(config) {
        const cfg = merge(DEFAULTS, config);
        const warnings = [];
        validate(cfg, warnings);

        const e = new Empire(cfg);
        e.warnings = warnings.concat(e.warnings);

        const dt = cfg.tickMinutes / 60;
        const totalHours = cfg.days * 24;
        const ticksPerDay = Math.round(24 / dt);

        // "Caught up" means every planet you currently hold is at target AND culture has no
        // unfilled slot. It is not a finish line: culture keeps unlocking slots, so an
        // empire can be caught up on day 30, colonise on day 31 and be behind again for an
        // hour. The first time it happens is the useful number; whether it still holds at
        // the end is reported separately.
        let firstCaughtUpHour = null;
        e.sample();
        for (let t = 1; t <= Math.round(totalHours / dt); t++) {
            e.tick(dt);
            if (t % ticksPerDay === 0) {
                e.dailyUpdate();
                e.sample();
            }
            if (firstCaughtUpHour === null && e.targetsMet() && e.planets.length >= e.planetLimit()) {
                firstCaughtUpHour = e.hours;
                e.note('done', 'every planet held is at target, no slot unfilled');
            }
        }

        return {
            config: cfg,
            warnings: e.warnings,
            milestones: e.milestones,
            history: e.history,
            firstCaughtUpDay: firstCaughtUpHour === null ? null : Math.floor(firstCaughtUpHour / 24) + 1,
            caughtUpAtEnd: e.targetsMet() && e.planets.length >= e.planetLimit(),
            final: {
                planets: e.planets.length,
                totalPop: e.totalPop(),
                popCap: e.popCap(),
                cultureLevel: e.cultureLevel,
                science: Object.assign({}, e.science),
                ppRate: e.ppRate(),
                sciRate: e.sciRate(),
                cultureRate: e.cultureRate(),
                unspentPP: e.pp,
                spent: Object.assign({}, e.spent),
                remainingBuildPP: e.remainingBuildPP(),
                scienceWasted: e.scienceWasted,
                scoreFloor: e.scoreFloor(),
                // Production points left over are the fleet you could have had instead, at
                // the economy level actually reached. Ships are not built by the sim.
                fleetIfSpent: {
                    economy: e.science.economy,
                    destroyers: Math.floor(e.pp / T.destroyerCost(e.science.economy)),
                    cruisers: Math.floor(e.pp / T.cruiserCost(e.science.economy)),
                    battleships: Math.floor(e.pp / T.battleshipCost(e.science.economy))
                },
                buildings: e.planets.map(p => ({
                    id: p.id, bornDay: p.bornDay, pop: p.popLevel,
                    buildings: Object.assign({}, p.buildings)
                }))
            }
        };
    }

    // Cost of a target vector for one planet, and for N planets. Cheap sanity check that
    // does not need a run.
    function targetCostPP(targets, planets) {
        let per = 0;
        for (const b of BUILDINGS) per += T.aggregate(T.BUILDING, 0, targets[b] || 0);
        return { perPlanet: per, total: per * (planets || 1) };
    }

    return {
        simulate, targetCostPP,
        constants: { TRAIT_PCT, BUILDINGS, SCIENCE_FIELDS, STARTUP_LAB_RL, SPONTANEOUS_GAP },
        DEFAULTS
    };
});
