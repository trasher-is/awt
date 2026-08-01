// THE battle model. One copy, used by every caller in this repo.
//
// Before this file existed the model lived in three hand-copied places
// (src/utils/battle.js, public/js/ui/battle-calc.js and an inline block in the
// !battle handler) and two of them had already drifted apart: the bot still ran
// the pre-calibration model from 2026-06-26 while the dashboard was refitted to
// in-game samples on 2026-06-27/28. On a 2304-case sweep the two disagreed by
// 19.1 percentage points on average and by up to 66.7 pp on win chance. See
// docs/battle-model.md for the numbers and the calibration history.
//
// LOADING: this file is deliberately written so that ONE copy serves both
// runtimes without a build step.
//   • Node:    require('../../public/js/utils/battle-model.js')
//   • Browser: import '../utils/battle-model.js';  then read globalThis.AWBattleModel
//     (the module has no ESM exports, so the import runs it for its side effect
//     and the API lands on globalThis — a static, synchronous import.)
//
// ─── THE MODEL ────────────────────────────────────────────────────────────────
// Each ship has an ATTACK and a DEFENSE stat; CV = att + def.
//   D: att 2, def 1 (cv 3) | C: att 8, def 16 (cv 24) | B: att 36, def 24 (cv 60)
//   Starbase level n: cv = round(4·1.5^n) − 4, att = def = floor(cv/2).
//
// SURVIVORS (reverse-engineered from in-game samples, commit fb2013f):
//   lossFraction_own = Σ enemyCV / Σ(att + 2·def)_own      — uniform across ship types
//   Race defense divides your own losses by (1 + 0.11·RD); it does not touch the enemy.
//   Mathematics adds a small symmetric toughness term (0.0015/level).
//   Race attack, physics and player level do NOT change survivors — win % only.
//
// WIN % is a separate logistic on force ratio, attack ratio and stat differences
// (commits 243bdfe / 7289025 / 2cc1467, fit across 24 in-game samples: mean
// absolute error 0.97%, max 4.0%).
(function (root, factory) {
    const api = factory();
    // Node (CommonJS)
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    // Browser (side-effect ESM import, or a plain <script> tag)
    root.AWBattleModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SHIPS = [
        { key: 'destroyers',  name: 'Destroyer',  att: 2,  def: 1,  cv: 3  },
        { key: 'cruisers',    name: 'Cruiser',    att: 8,  def: 16, cv: 24 },
        { key: 'battleships', name: 'Battleship', att: 36, def: 24, cv: 60 },
    ];

    // Per-ship "toughness" — the denominator of the loss fraction.
    const TOUGH = i => SHIPS[i].att + 2 * SHIPS[i].def;

    // Starbase: cv = round(4·1.5^n) − 4; att = def = floor(cv/2).
    // Confirmed in-game: lvl1=2, 2=5, 3=10, 4=16, 5=26, 6=42, 7=64, 10=227, 15=1748, 20=13297.
    function sbCV(n) { return n > 0 ? Math.round(4 * Math.pow(1.5, n)) - 4 : 0; }
    function sbHalf(n) { return Math.floor(sbCV(n) / 2); }

    const RACE_DEF = 0.11;      // race defense: own losses ÷ (1 + 0.11·RD)
    const MATH_TOUGH = 0.0015;  // small symmetric toughness gain per math level
    const MATH_BRACKET = 0.125; // a 6+ mathematics lead grants +12.5% combat to that side

    // Win-% logistic coefficients. Force and attack enter as POWER laws, not
    // linearly: the in-game force sweep (110/125/150 vs 100 destroyers) shows the
    // effective weight rising with the ratio (~14 -> 16 -> 18).
    const WIN_FORCE_W = 21.8;   const WIN_FORCE_P = 1.24;  // CV ratio:      W·|FR|^P
    const WIN_ATT_W = 2.67;     const WIN_ATT_P = 0.914;   // attack ratio:  W·|AR|^P
    const WIN_SB_FACTOR = 0.94; // a starbase counts ~0.94× its CV toward the win ratio
    const WIN_RA = 0.55;        // per race-attack level below the +6 threshold
    const WIN_RA_BASE6 = 7.4;   // RA magnitude at a 6+ diff — effectively decisive in-game
    const WIN_RA_SLOPE = 0.5;
    const WIN_LVL = 0.069;      // per player-level diff (only when both fleets are full D/C/B)
    const WIN_PHYS_LIN = 0.1034;  // physics below a +6 diff — confirmed exact at diff 4 & 5
    const WIN_PHYS_BASE6 = 2.94;  // jump at exactly +6
    const WIN_PHYS_SLOPE = 0.30;  // per level beyond +6
    const ANNIHILATE = 1.25;    // overkill ratio at which a side counts as wiped out
    const SURVIVES = 0.9;       // ...but the winner must lose less than this to be a clear victor

    // Accepts either [D, C, B] or { destroyers, cruisers, battleships }.
    function toFleet(f) {
        if (Array.isArray(f)) return [f[0] || 0, f[1] || 0, f[2] || 0];
        if (!f) return [0, 0, 0];
        return SHIPS.map(s => f[s.key] || 0);
    }

    const cvOf = f => toFleet(f).reduce((s, n, i) => s + n * SHIPS[i].cv, 0);
    const attOf = f => toFleet(f).reduce((s, n, i) => s + n * SHIPS[i].att, 0);
    const toughOf = f => toFleet(f).reduce((s, n, i) => s + n * TOUGH(i), 0);

    const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const norm = s => ({
        phys: (s && s.phys) || 0, math: (s && s.math) || 0,
        ra: (s && s.ra) || 0, rd: (s && s.rd) || 0, lvl: (s && s.lvl) || 0
    });

    // Input ranges. These live here, next to the model, because they are part of "the same
    // inputs": the panel used to cap science at 30 while !battle capped it at 10, so the
    // same --dp 20 reached the model as two different numbers. Every caller must clamp
    // through normalizeInputs() so that can't happen again.
    const int = v => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
    const clampScience = v => Math.max(0, Math.min(30, int(v)));
    const clampRace = v => Math.max(-4, Math.min(4, int(v)));
    const clampStarbase = v => Math.max(0, Math.min(50, int(v)));
    const clampLevel = v => Math.max(0, int(v));

    // Take whatever a caller collected (form fields, chat flags, a DB row) and produce the
    // canonical input object simulate() expects.
    function normalizeInputs(raw) {
        const side = s => ({
            phys: clampScience(s && s.phys), math: clampScience(s && s.math),
            ra: clampRace(s && s.ra), rd: clampRace(s && s.rd), lvl: clampLevel(s && s.lvl)
        });
        return {
            defFleet: toFleet(raw.defFleet),
            atkFleet: toFleet(raw.atkFleet),
            sbLevel: clampStarbase(raw.sbLevel),
            def: side(raw.def),
            atk: side(raw.atk)
        };
    }

    // Resolve a player row from the DB into combat stats, with the agreed fallbacks:
    //   • no intel on the race -> assume race attack/defence +4, and physics = maths =
    //     science_level (the public ceiling).
    //   • race known but the intel sciences are stale (>24h) -> keep the race, but use
    //     science_level for physics & maths.
    function resolveStats(p) {
        if (!p) return { ra: 4, rd: 4, phys: 0, math: 0, lvl: 0, unknown: true };
        const sci = p.science_level || 0;
        if (p.has_intel) {
            const ts = p.intel_updated_at ? Date.parse(p.intel_updated_at) : 0;
            const fresh = ts && (Date.now() - ts < 24 * 3600 * 1000);
            return {
                ra: p.race_attack || 0,
                rd: p.race_defense || 0,
                phys: fresh ? (p.physics || 0) : sci,
                math: fresh ? (p.mathematics || 0) : sci,
                lvl: p.level || 0,
                unknown: false
            };
        }
        return { ra: 4, rd: 4, phys: sci, math: sci, lvl: p.level || 0, unknown: true };
    }

    // Win probability for the defender. cvD / cvA are the combat values that feed the
    // force ratio (the defender's already weighted by WIN_SB_FACTOR — the same weighted
    // value also drives the 1.5× shortcut below), attD / attA the attack totals.
    function calcWin(d, a, defFleet, atkFleet, cvD, cvA, attD, attA) {
        const dra = d.ra - a.ra, adra = Math.abs(dra);
        const dp = d.phys - a.phys, adp = Math.abs(dp);
        const raMag = adra < 6 ? WIN_RA * adra : WIN_RA_BASE6 + WIN_RA_SLOPE * (adra - 6);
        const physMag = adp < 6 ? WIN_PHYS_LIN * adp : WIN_PHYS_BASE6 + WIN_PHYS_SLOPE * (adp - 6);
        let statS = sgn(dra) * raMag + sgn(dp) * physMag;
        if (defFleet.every(n => n > 0) && atkFleet.every(n => n > 0)) statS += WIN_LVL * (d.lvl - a.lvl);

        // A 1.5× CV lead is a guaranteed win ONLY in a same-ship-type fight, where the CV
        // ratio equals the attack ratio and the outcome is deterministic. For mixed
        // compositions a CV lead can be pure defense, so let the attack-aware logistic
        // decide. Stats can overturn a force deficit, hence the statS sign guard.
        const pureIdx = f => {
            const nz = f.reduce((acc, n, i) => (n > 0 ? acc.concat(i) : acc), []);
            return nz.length === 1 ? nz[0] : -1;
        };
        const sameType = pureIdx(defFleet) >= 0 && pureIdx(defFleet) === pureIdx(atkFleet);
        if (sameType) {
            if (cvA >= 1.5 * cvD && statS <= 0) return 0;
            if (cvD >= 1.5 * cvA && statS >= 0) return 1;
        }

        const denom = cvD + cvA, attDenom = attD + attA;
        const FR = denom > 0 ? (cvD - cvA) / denom : 0;
        const AR = attDenom > 0 ? (attD - attA) / attDenom : 0;
        const S = sgn(FR) * WIN_FORCE_W * Math.abs(FR) ** WIN_FORCE_P
                + sgn(AR) * WIN_ATT_W * Math.abs(AR) ** WIN_ATT_P
                + statS;
        return 1 / (1 + Math.exp(-S));
    }

    // Full simulation: survivors + win chance.
    //   input: { defFleet, atkFleet, sbLevel, def: {phys,math,ra,rd,lvl}, atk: {...} }
    // Returns null when neither side has anything that can fight.
    function simulate(input) {
        const defFleet = toFleet(input.defFleet);
        const atkFleet = toFleet(input.atkFleet);
        const sbLvl = Math.max(0, input.sbLevel || 0);
        const def = norm(input.def), atk = norm(input.atk);

        const sbCv = sbCV(sbLvl);
        const sbTough = sbLvl > 0 ? sbHalf(sbLvl) * 3 : 0; // att + 2·def with att = def

        const cmDef = 1 + MATH_BRACKET * ((def.math - atk.math) >= 6 ? 1 : 0);
        const cmAtk = 1 + MATH_BRACKET * ((atk.math - def.math) >= 6 ? 1 : 0);

        const enemyCVtoDef = cvOf(atkFleet) * cmAtk;
        const enemyCVtoAtk = (cvOf(defFleet) + sbCv) * cmDef;

        const defTough = (toughOf(defFleet) + sbTough) * (1 + RACE_DEF * def.rd) * (1 + MATH_TOUGH * def.math) * cmDef;
        const atkTough = toughOf(atkFleet) * (1 + RACE_DEF * atk.rd) * (1 + MATH_TOUGH * atk.math) * cmAtk;
        if (defTough === 0 && atkTough === 0) return null;

        const rawDefKilled = defTough > 0 ? enemyCVtoDef / defTough : 99;
        const rawAtkKilled = atkTough > 0 ? enemyCVtoAtk / atkTough : 99;
        const fracDefKilled = Math.min(1, rawDefKilled);
        const fracAtkKilled = Math.min(1, rawAtkKilled);

        const survDef = defFleet.map(n => n * (1 - fracDefKilled));
        const survAtk = atkFleet.map(n => n * (1 - fracAtkKilled));
        const survSB = sbLvl > 0 ? (1 - fracDefKilled) : 0;

        const initCVD = cvOf(defFleet) + sbCv;
        const initCVA = cvOf(atkFleet);

        // A guaranteed win is only declared when the LOSER is annihilated AND the winner
        // actually survives. Without the survival check a near-mutual wipe snapped the
        // result to 100%/0%, so removing a single enemy ship could swing the win chance
        // from ~10% to 100%. A starbase defending alongside a fleet is not modelled
        // reliably, so that combination always falls through to the logistic.
        const sbCombined = sbLvl > 0 && defFleet.some(n => n > 0);
        const atkGone = !sbCombined && rawAtkKilled >= ANNIHILATE && fracDefKilled < SURVIVES;
        const defGone = !sbCombined && rawDefKilled >= ANNIHILATE && fracAtkKilled < SURVIVES;

        let winD;
        if (atkGone && !defGone) winD = 1;
        else if (defGone && !atkGone) winD = 0;
        else {
            const winCVD = cvOf(defFleet) + WIN_SB_FACTOR * sbCv;
            const attD = attOf(defFleet) + (sbLvl > 0 ? sbHalf(sbLvl) : 0);
            const attA = attOf(atkFleet);
            winD = calcWin(def, atk, defFleet, atkFleet, winCVD, initCVA, attD, attA);
        }
        const winA = 1 - winD;

        // In-game rule: the winning side is never fully wiped — you always keep at least
        // one ship in a battle you win.
        const ensureSurvivor = (fleet, surv) => {
            if (!fleet.some(n => n > 0)) return;
            if (surv.reduce((s, n) => s + n, 0) >= 1) return;
            let idx = 0;
            fleet.forEach((n, i) => { if (n > fleet[idx]) idx = i; });
            surv[idx] = 1;
        };
        if (winD >= winA) ensureSurvivor(defFleet, survDef);
        else ensureSurvivor(atkFleet, survAtk);

        const cvDefRemain = survDef.reduce((s, n, i) => s + n * SHIPS[i].cv, 0) + survSB * sbCv;
        const cvAtkRemain = survAtk.reduce((s, n, i) => s + n * SHIPS[i].cv, 0);

        return {
            defFleet, atkFleet, sbLvl, survDef, survAtk, survSB,
            initCVD, initCVA, cvDefRemain, cvAtkRemain, winD, winA
        };
    }

    // Fleet-only convenience wrapper used by the interception ranking: probability that
    // allyFleet beats enemyFleet, with no starbase involved.
    function winChance(allyFleet, ally, enemyFleet, enemy) {
        const r = simulate({ defFleet: allyFleet, atkFleet: enemyFleet, sbLevel: 0, def: ally, atk: enemy });
        return r ? r.winD : 0.5;
    }

    return {
        SHIPS, TOUGH, sbCV, sbHalf,
        cvOf, attOf, toughOf, toFleet,
        clampScience, clampRace, clampStarbase, clampLevel, normalizeInputs,
        resolveStats, simulate, winChance,
        constants: {
            RACE_DEF, MATH_TOUGH, MATH_BRACKET,
            WIN_FORCE_W, WIN_FORCE_P, WIN_ATT_W, WIN_ATT_P, WIN_SB_FACTOR,
            WIN_RA, WIN_RA_BASE6, WIN_RA_SLOPE, WIN_LVL,
            WIN_PHYS_LIN, WIN_PHYS_BASE6, WIN_PHYS_SLOPE,
            ANNIHILATE, SURVIVES
        }
    };
});
