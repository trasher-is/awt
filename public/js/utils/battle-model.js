// THE battle model. One copy, used by every caller in this repo.
//
// Before this file existed the model lived in three hand-copied places
// (src/utils/battle.js, public/js/ui/battle-calc.js and an inline block in the
// !battle handler) and two of them had already drifted apart: the bot still ran
// the pre-calibration model from 2026-06-26 while the dashboard was refitted to
// in-game samples on 2026-06-27/28. On a 2304-case sweep the two disagreed by
// 19.1 percentage points on average and by up to 66.7 pp on win chance. See
// docs/battle-model.md for that history.
//
// REPLACED 2026-09-06: the logistic-regression fit below (force/attack power
// laws, WIN_RA/WIN_PHYS/WIN_LVL coefficients) is gone. It's been reverse-
// engineered directly from the live calculator at astrowars.games/About/
// BattleCalculator instead: ~4200 real POST requests across four rounds
// (scripts/battle-harvest/ in this repo), producing a closed-form formula
// rather than a regression. Validated against the 9 pre-existing in-game
// fixtures in battle-fixtures.json — collected independently, months earlier,
// for the OLD model — to within 0.14pp on every one of them.
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
// Four mechanics, two outcomes, no cross-interaction between them:
//
//   WIN % — Race Attack and Physics, both additive log-odds terms:
//     lneff = w·ln(CVatk/CVdef) + (1−w)·ln(ATKatk/ATKdef)          [force/attack blend]
//           + ln(1+0.08·RAatk) − ln(1+0.08·RAdef)                   [race attack]
//           + ln(1+0.01491·PHatk) − ln(1+0.01491·PHdef)             [physics, below bracket]
//           + ln(EDGEatk) − ln(EDGEdef)                             [bracket + player level]
//     EDGEside = 1 + 0.25 (if this side is 6+ physics ahead)
//                  + 0.00995·(own PL − enemy PL)  (if ahead AND this side fields all 3 types)
//     — the physics bracket and the level advantage ADD inside one factor per side.
//     capped at |lneff| <= ln(1.5) (a certain win/loss beyond that), then run through
//     a saturating curve: winFrac = 1 − 0.5·(1−x)^1.805, x = 2·(R−1), R = e^|lneff|.
//     The blend weight w is 0.813 for any 2-3-type mix, but for a PURE single-type
//     duel it's pair-specific (0.807 destroyer/cruiser, 0.760 battleship/destroyer,
//     0.816 battleship/cruiser) — see PAIR_CV_WEIGHT below — and a single ship type
//     against a starbase has its own (LONE_SB_CV_WEIGHT, SB_FLEET_SHARE_SLOPE).
//
//   SURVIVORS — Mathematics, Race Defense and Player Level on your OWN toughness
//   (1/lossFraction), independent of win%:
//     lossFrac_own = min(1, (enemyCV / ownToughness) / toughnessMultiplier)
//                    [capped AFTER dividing: a big multiplier cannot rescue a side
//                     whose enemy CV is far above its toughness]
//     toughnessMultiplier = (1 + 0.0015·ownMath)                    [OWN ABSOLUTE level,
//                                                                     not the gap — see note]
//                          × (1 ± 0.25 [|ownMath−enemyMath| >= 6]
//                               + 0.01·max(0, ownPL−enemyPL))      [bracket and level ADD;
//                                                                     level only with all 3 types]
//                          × (1 + 0.12·ownRD)
//     ownToughness includes a defending starbase's att + 2·def.
//     Physics, Race Attack never touch survivors. Player level never touches
//     anything unless the side has destroyers AND cruisers AND battleships.
//
//   ANNIHILATION: the LOSER of a fight that hit the |lneff|>=ln(1.5) certainty cap
//   is wiped to 0 survivors, full stop — overriding whatever the CV-ratio formula
//   alone would say. The winner is unaffected. Separately, a side whose own
//   lossFrac reaches 1 keeps exactly ONE ship — of its type with the most CV, the
//   other types 0 — unless that side is ALSO the certain loser above (which takes
//   priority and zeroes it).
//
// TWO THINGS THAT LOOK SIMILAR BUT AREN'T (both cost real accuracy the first way):
//   • PLEVEL_WIN_K is applied to the level DIFFERENCE, not to each side's absolute
//     level: a 121-point two-sided grid showed the term depends on the difference
//     alone. It counts only for the side that is AHEAD and only if that side fields
//     all three ship types (a 641-case calculator sweep, 2026-10-04: applying the
//     whole gap whenever one side had all three was up to 68pp wrong).
//   • MATH_SLOPE (0.0015) is your OWN absolute math level, not a gap to the
//     enemy. Every earlier test that found "0.0015/level of advantage" held the
//     enemy's math at exactly 0, so "gap" and "own level" were the same number
//     and looked identical. The ±6 BRACKET, unlike the slope, genuinely is
//     gap-based (confirmed at 6 different absolute bases from 15 to 40).
//
// KNOWN GAP: fleets mixing 2-3 ship types on either side fit a little worse than
// pure single-type fights (mean ~0.5pp, worst ~2pp across 420 mixed calculator
// readings with sciences 10-40) — the flat 0.813 blend weight is the remaining
// approximation. See docs/battle-model.md for what's been ruled out.
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
    const [DE, CR, BS] = [0, 1, 2];

    // Per-ship "toughness" — the denominator of the loss fraction.
    const TOUGH = i => SHIPS[i].att + 2 * SHIPS[i].def;

    // Starbase: cv = round(4·1.5^n) − 4; att = def = floor(cv/2).
    // Confirmed in-game: lvl1=2, 2=5, 3=10, 4=16, 5=26, 6=42, 7=64, 10=227, 15=1748, 20=13297.
    function sbCV(n) { return n > 0 ? Math.round(4 * Math.pow(1.5, n)) - 4 : 0; }
    function sbHalf(n) { return Math.floor(sbCV(n) / 2); }

    // ─── fitted constants ──────────────────────────────────────────────────────
    const P_CV_WEIGHT = 0.813;      // fallback blend weight for a mixed (2-3 type) side
    // Pure single-type-vs-single-type duels fit this weight EXACTLY per pair
    // (<0.05pp max error each, vs ~1pp with the one global constant above) —
    // found via a dense 90-point destroyer-vs-battleship sweep after the global
    // constant showed a systematic residual specific to that pairing that
    // neither reweighting it nor adding a defense-ratio third term could close.
    const PAIR_CV_WEIGHT = { 'de,cr': 0.807, 'bs,de': 0.760, 'bs,cr': 0.816 };
    // A single ship type against a LONE starbase has its own weight per type (with the
    // mixed fallback every such fight rated the attacker ~1-2pp low). Destroyers fit 13
    // calculator points to 0.08pp, cruisers 7 to 0.13pp, battleships 5 to 0.08pp.
    const LONE_SB_CV_WEIGHT = { [0]: 0.7745, [1]: 0.830, [2]: 0.7845 };
    // Destroyers against destroyers + a starbase: the destroyer-vs-starbase weight
    // slides down with the fleet's share of the defender's CV (24 calculator points,
    // levels 3-12, shares 0.2-0.9: mean 0.01pp). Other starbase + fleet mixes: 0.813.
    const SB_FLEET_SHARE_SLOPE = 0.026;
    const N_EXP = 1.805;             // saturation curve exponent
    const RACE_ATK_PCT = 0.08;       // confirmed exact, 6.0.0-beta (was 0.07)
    const RACE_DEF_PCT = 0.12;       // confirmed exact, 6.0.0-beta (was 0.11)
    const PHYS_SLOPE = 0.01491;      // per physics level, below the bracket
    const PHYS_BRACKET = Math.log(1.25); // fitted 0.2235 ≈ ln(1.25); triggers at |diff| >= 6
    const PHYS_BRACKET_PCT = 0.25;   // the same +25%, as it adds to the level bonus in one factor
    const PLEVEL_WIN_K = 0.00995;    // per level of ADVANTAGE, for the side ahead — see header
    const PLEVEL_SURV_SLOPE = 0.01;  // toughness ×= 1 + this·max(0, ownPL−enemyPL)
    const MATH_SLOPE = 0.0015;       // toughness ×= 1 + this·OWN absolute math level
    const MATH_BRACKET = 0.25;       // ±25% toughness at a 6+ math GAP (was wrongly 0.125)
    const LN_CAP = Math.log(1.5);    // the "1.5×" certainty / annihilation threshold

    // Accepts either [D, C, B] or { destroyers, cruisers, battleships }.
    function toFleet(f) {
        if (Array.isArray(f)) return [f[0] || 0, f[1] || 0, f[2] || 0];
        if (!f) return [0, 0, 0];
        return SHIPS.map(s => f[s.key] || 0);
    }

    const cvOf = f => toFleet(f).reduce((s, n, i) => s + n * SHIPS[i].cv, 0);
    const attOf = f => toFleet(f).reduce((s, n, i) => s + n * SHIPS[i].att, 0);
    const toughOf = f => toFleet(f).reduce((s, n, i) => s + n * TOUGH(i), 0);
    const hasAllThree = f => f[DE] > 0 && f[CR] > 0 && f[BS] > 0;
    const singleType = f => { const nz = [DE, CR, BS].filter(i => f[i] > 0); return nz.length === 1 ? nz[0] : -1; };
    const SHIP_LETTER = { [DE]: 'de', [CR]: 'cr', [BS]: 'bs' };

    // The CV-vs-attack-value blend weight for this matchup: pair-specific for a pure
    // single-type duel with no starbase, per ship type against a lone starbase, sliding
    // for destroyers against destroyers + a starbase; the global fallback otherwise.
    function cvWeight(atkFleet, defFleet, sbLevel) {
        if (sbLevel > 0) {
            const a = singleType(atkFleet);
            if (!defFleet.some(n => n > 0)) return a >= 0 ? LONE_SB_CV_WEIGHT[a] : P_CV_WEIGHT;
            if (a === DE && singleType(defFleet) === DE) {
                const fleetShare = cvOf(defFleet) / (cvOf(defFleet) + sbCV(sbLevel));
                return LONE_SB_CV_WEIGHT[DE] - SB_FLEET_SHARE_SLOPE * fleetShare;
            }
            return P_CV_WEIGHT;
        }
        const a = singleType(atkFleet), d = singleType(defFleet);
        if (a < 0 || d < 0) return P_CV_WEIGHT;
        if (a === d) return 0.5; // CV ratio == attack ratio identically; weight is moot
        const key = [SHIP_LETTER[a], SHIP_LETTER[d]].sort().join(',');
        return PAIR_CV_WEIGHT[key] !== undefined ? PAIR_CV_WEIGHT[key] : P_CV_WEIGHT;
    }

    const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const norm = s => ({
        phys: (s && s.phys) || 0, math: (s && s.math) || 0,
        ra: (s && s.ra) || 0, rd: (s && s.rd) || 0, lvl: (s && s.lvl) || 0
    });

    // Input ranges. These live here, next to the model, because they are part of "the same
    // inputs": the panel used to cap science at 30 while !battle capped it at 10, so the
    // same --dp 20 reached the model as two different numbers. Every caller must clamp
    // through normalizeInputs() so that can't happen again.
    //
    // clampScience's ceiling was raised from 30 to 100 on 2026-09-06 to match the live
    // calculator's own field range — real end-game fleets run Physics/Mathematics 30-40,
    // which the old 30-cap was silently clipping.
    const int = v => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
    const clampScience = v => Math.max(0, Math.min(100, int(v)));
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

    function satFrac(lneff) {
        const R = Math.exp(Math.min(Math.abs(lneff), LN_CAP));
        const x = 2 * (R - 1);
        const top = 1 - 0.5 * Math.pow(1 - x, N_EXP);
        return lneff >= 0 ? top : 1 - top;
    }

    // Attacker's win fraction (0-1). def gets the starbase; atk never does.
    function calcAttackerWin(atk, def, atkFleet, defFleet, sbLevel) {
        const aCV = cvOf(atkFleet), dCV = cvOf(defFleet) + sbCV(sbLevel);
        if (aCV === 0 && dCV === 0) return 0; // empty vs empty: confirmed 0%, not a coin flip
        if (dCV === 0) return 1;
        if (aCV === 0) return 0;

        const sbAtkVal = sbLevel > 0 ? sbCV(sbLevel) / 2 : 0;
        const aAtk = attOf(atkFleet), dAtk = attOf(defFleet) + sbAtkVal;

        const w = cvWeight(atkFleet, defFleet, sbLevel);
        let lneff = w * Math.log(aCV / dCV) + (1 - w) * Math.log(Math.max(aAtk, 1e-9) / Math.max(dAtk, 1e-9));

        lneff += Math.log(1 + RACE_ATK_PCT * atk.ra) - Math.log(1 + RACE_ATK_PCT * def.ra);

        const physDiff = atk.phys - def.phys;
        lneff += Math.log(1 + PHYS_SLOPE * atk.phys) - Math.log(1 + PHYS_SLOPE * def.phys);
        // The physics bracket and the player-level advantage are percentages that ADD in one
        // factor per side (with a separate ln term each, a side 6+ physics and 30+ levels
        // ahead came out up to 10pp too strong). Level counts only for the side ahead, and
        // only if that side fields all three ship types.
        const edge = (ownFleet, own, enemy, bracketAhead) => 1
            + (bracketAhead ? PHYS_BRACKET_PCT : 0)
            + (hasAllThree(ownFleet) && own.lvl > enemy.lvl ? PLEVEL_WIN_K * (own.lvl - enemy.lvl) : 0);
        lneff += Math.log(edge(atkFleet, atk, def, physDiff >= 6)) - Math.log(edge(defFleet, def, atk, physDiff <= -6));

        return satFrac(lneff);
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
        if (cvOf(defFleet) + sbCv === 0 && cvOf(atkFleet) === 0) return null;

        const winA = calcAttackerWin(atk, def, atkFleet, defFleet, sbLvl);
        const winD = 1 - winA;

        // Own-side toughness: mathematics (absolute level), then the maths bracket and the
        // player-level advantage ADDED in one factor (as on the win side), then race defense.
        // Multiplying the bracket and the level bonus made stacked sides too tough.
        function toughnessMult(ownMath, enemyMath, ownRD, ownFleet, ownLvl, enemyLvl) {
            const gap = ownMath - enemyMath;
            const bracket = gap >= 6 ? MATH_BRACKET : gap <= -6 ? -MATH_BRACKET : 0;
            const level = hasAllThree(ownFleet) ? PLEVEL_SURV_SLOPE * Math.max(0, ownLvl - enemyLvl) : 0;
            return (1 + MATH_SLOPE * ownMath) * (1 + bracket + level) * (1 + RACE_DEF_PCT * ownRD);
        }

        const enemyCVtoDef = cvOf(atkFleet);
        const enemyCVtoAtk = cvOf(defFleet) + sbCv;
        // The starbase's own toughness (att+2*def, att=def=floor(cv/2)) always counts in
        // the defender's denominator, with or without a fleet beside it; the fleet and
        // the starbase then share one loss fraction. An earlier version left it out when
        // a fleet also defended. Against the 816 recorded starbase + fleet observations
        // that put the starbase 0.49 levels off on average (and wiped starbases the
        // calculator leaves at level 6-10); counting it gives 0.13 levels, and 0.01-0.05
        // on six new calculator readings (2026-10-04). Fleet survivors improve with it too.
        const defTough = toughOf(defFleet) + (sbLvl > 0 ? sbHalf(sbLvl) * 3 : 0);
        const atkTough = toughOf(atkFleet);

        const defMult = toughnessMult(def.math, atk.math, def.rd, defFleet, def.lvl, atk.lvl);
        const atkMult = toughnessMult(atk.math, def.math, atk.rd, atkFleet, atk.lvl, def.lvl);

        // The cap comes AFTER the multiplier: enemy CV far above a side's toughness wipes
        // it even with a large bonus. Capping first (min(1, ratio) / mult) let a side with
        // a ×2 multiplier keep half its fleet against any odds — up to 54% of its CV wrong
        // in the 2026-10-04 sweep.
        const fracDefKilled = defTough > 0 ? Math.min(1, (enemyCVtoDef / defTough) / defMult) : 0;
        const fracAtkKilled = atkTough > 0 ? Math.min(1, (enemyCVtoAtk / atkTough) / atkMult) : 0;

        // The one-survivor floor. A side of 5+ ships always keeps at least ONE ship of its
        // type with the most total defence (destroyer 1, cruiser 16, battleship 24 each):
        // that type is lifted to 1 when it would keep less, the others keep their own
        // fractions (140 destroyers + 9 cruisers wiped keep 1 cruiser: defence 144 vs 140).
        // A side of 4 ships or fewer gets no floor and can lose everything — 24 of 24 and
        // 49 of 49 calculator cases. A starbase defending ALONE keeps level 1 when wiped
        // (16 of 16 readings); beside 5+ ships the floor goes to a ship and the starbase can
        // reach 0 (50 destroyers + level 9, wiped: 1 destroyer, starbase 0).
        const floorOne = (fleet, frac, sbCvHere) => {
            const ships = fleet.map(n => (n > 0 ? Math.max(0, n * (1 - frac)) : 0));
            let sbFrac = sbCvHere > 0 ? Math.max(0, 1 - frac) : 0;
            const top = [DE, CR, BS].reduce((b, x) => (fleet[x] * SHIPS[x].def > fleet[b] * SHIPS[b].def ? x : b), DE);
            const shipCount = fleet.reduce((a, b) => a + b, 0);
            if (shipCount >= 5 && ships[top] < 1) ships[top] = 1;
            else if (shipCount === 0 && sbCvHere > 0 && frac >= 1) sbFrac = sbCV(1) / sbCvHere;
            return { ships, sbFrac };
        };

        const defLeft = floorOne(defFleet, fracDefKilled, sbCv);
        let survDef = defLeft.ships;
        let survAtk = floorOne(atkFleet, fracAtkKilled, 0).ships;
        let survSB = defLeft.sbFrac;

        // The LOSER of a fight that hit the certainty cap (win% exactly 0 or 100) is
        // wiped to 0, overriding the CV-ratio formula above — confirmed by a race-attack
        // sample that goes from 250 survivors at 0.31% win to exactly 0 at 0.00%, with
        // the underlying force ratio and CV-based loss formula unchanged either side of
        // that boundary. The winner is unaffected.
        if (winD >= 1) { survAtk = survAtk.map(() => 0); }
        else if (winD <= 0) { survDef = survDef.map(() => 0); survSB = 0; }

        const initCVD = cvOf(defFleet) + sbCv;
        const initCVA = cvOf(atkFleet);
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

    // ─── HOW SURE ARE WE? ─────────────────────────────────────────────────────
    // The win percentage is reverse-engineered from ~4200 live calculator observations
    // across four harvest rounds (see scripts/battle-harvest/ and the file header), not a
    // regression fit — but it is still an approximation with a measured, non-zero error,
    // and printing it as "47.3%" would claim more precision than that.
    //
    //   * BASE_ERROR_PP covers single-type and single-type-vs-single-type fights: 97.7%
    //     of ~3200 realistic-scale observations (player level 1-30) land within 1pp, mean
    //     error 0.09pp. 1pp is therefore an honest band for the common case.
    //   * MIXED_FLEET_EXTRA_PP covers the one remaining gap: a side fielding 2-3 ship
    //     types uses one flat blend weight. After the 2026-10-04 fixes (level advantage,
    //     bracket + level adding in one factor) 420 mixed calculator readings with
    //     sciences 10-40 and level gaps to 40 fit with mean 0.53pp, worst 1.9pp (the
    //     September harvest's mixed rows: worst 1.6pp), so the mixed band is ±2pp.
    //   * Not covered: a side of 2-3 ships, where one ship more or less moves the odds a
    //     lot (2 destroyers vs a level-2 starbase: 4.4pp off).
    //
    // The OLD caveats here (starbase alongside a fleet, a 6+ mathematics gap) are GONE:
    // both are now modelled exactly (mean ~0.06pp and ~0.00pp respectively across the
    // harvested data) rather than approximated, so they no longer need extra margin.
    //
    // src/utils/battle-calc.test.js asserts that every win fixture's error is inside the
    // band winBand() shows for that fight, so the stated confidence can never drift below
    // the measured one.
    const BASE_ERROR_PP = 1.0;
    const MIXED_FLEET_EXTRA_PP = 1.0;

    /**
     * Turn a raw probability into an honest range.
     *   winBand(0.473, { sbLevel: 0, defFleet, atkFleet, def, atk })
     *     -> { low: 47, high: 48, text: '47–48%', marginPp: 1, caveats: [] }
     * `text` is what every surface should print instead of a bare percentage.
     */
    function winBand(winD, context = {}) {
        const pct = Math.max(0, Math.min(100, winD * 100));
        const caveats = [];
        let margin = BASE_ERROR_PP;

        const defFleet = toFleet(context.defFleet);
        const atkFleet = toFleet(context.atkFleet);
        const defTypes = [DE, CR, BS].filter(i => defFleet[i] > 0).length;
        const atkTypes = [DE, CR, BS].filter(i => atkFleet[i] > 0).length;
        if (defTypes >= 2 || atkTypes >= 2) {
            margin += MIXED_FLEET_EXTRA_PP;
            caveats.push('a side fielding 2-3 ship types is less precisely modelled than a pure single-type fleet');
        }

        const low = Math.max(0, Math.round(pct - margin));
        const high = Math.min(100, Math.round(pct + margin));

        // A band that has hit a wall should not read as certainty. "0-4%" is honest;
        // "0%" would not be.
        return {
            point: pct,
            low, high, marginPp: margin, caveats,
            text: low === high ? `${low}%` : `${low}–${high}%`,
        };
    }

    return {
        SHIPS, TOUGH, sbCV, sbHalf,
        cvOf, attOf, toughOf, toFleet,
        clampScience, clampRace, clampStarbase, clampLevel, normalizeInputs,
        resolveStats, simulate, winChance, winBand,
        uncertainty: { BASE_ERROR_PP, MIXED_FLEET_EXTRA_PP },
        constants: {
            P_CV_WEIGHT, PAIR_CV_WEIGHT, N_EXP,
            RACE_ATK_PCT, RACE_DEF_PCT,
            LONE_SB_CV_WEIGHT, SB_FLEET_SHARE_SLOPE,
            PHYS_SLOPE, PHYS_BRACKET, PHYS_BRACKET_PCT,
            PLEVEL_WIN_K, PLEVEL_SURV_SLOPE,
            MATH_SLOPE, MATH_BRACKET, LN_CAP
        }
    };
});
