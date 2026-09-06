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
//           ± ln(1.25)                    if |PHatk−PHdef| >= 6     [physics bracket]
//           ± ln(1+0.00995·|PLatk−PLdef|)                           [player level, RAW DIFF —
//                                                                     see the PLEVEL_WIN_K note]
//     capped at |lneff| <= ln(1.5) (a certain win/loss beyond that), then run through
//     a saturating curve: winFrac = 1 − 0.5·(1−x)^1.805, x = 2·(R−1), R = e^|lneff|.
//     The blend weight w is 0.813 for any 2-3-type mix, but for a PURE single-type
//     duel it's pair-specific (0.807 destroyer/cruiser, 0.760 battleship/destroyer,
//     0.816 battleship/cruiser) — see PAIR_CV_WEIGHT below.
//
//   SURVIVORS — Mathematics, Race Defense and Player Level, all multiplicative on
//   your OWN toughness (1/lossFraction), independent of each other and of win%:
//     lossFrac_own = min(1, enemyCV / ownToughness) / toughnessMultiplier
//     toughnessMultiplier = (1 + 0.0015·ownMath)                    [OWN ABSOLUTE level,
//                                                                     not the gap — see note]
//                          × (1.25 or 0.75 if |ownMath−enemyMath| >= 6, else ×1)
//                          × (1 + 0.12·ownRD)
//                          × (1 + 0.01·max(0, ownPL−enemyPL))       [only if this side
//                                                                     fields all 3 ship types]
//     Physics, Race Attack never touch survivors. Player level never touches
//     anything unless the side has destroyers AND cruisers AND battleships.
//
//   ANNIHILATION: the LOSER of a fight that hit the |lneff|>=ln(1.5) certainty cap
//   is wiped to 0 survivors, full stop — overriding whatever the CV-ratio formula
//   alone would say. The winner is unaffected. Separately, a side whose own
//   lossFrac (after the toughness multipliers) is pushed past 1 — which can only
//   happen from a race-defense malus dividing an already-large loss further up —
//   floors at exactly 1 survivor, never 0, unless that side is ALSO the certain
//   loser above (which takes priority and zeroes it).
//
// TWO THINGS THAT LOOK SIMILAR BUT AREN'T (both cost real accuracy the first way):
//   • PLEVEL_WIN_K is applied to the RAW DIFFERENCE (PLatk−PLdef) as ONE number,
//     not as ln(1+k·PLatk) − ln(1+k·PLdef) computed separately per side. Those
//     look like the same formula and agree when the difference is small, but
//     diverge by up to 2.7pp once both sides carry a large, comparable player
//     level. A 121-point two-sided grid showed the true term depends on the raw
//     difference ALONE — every (PLatk,PLdef) pair sharing a difference lands
//     within 0.001 of the same log-odds value regardless of the absolute levels.
//   • MATH_SLOPE (0.0015) is your OWN absolute math level, not a gap to the
//     enemy. Every earlier test that found "0.0015/level of advantage" held the
//     enemy's math at exactly 0, so "gap" and "own level" were the same number
//     and looked identical. The ±6 BRACKET, unlike the slope, genuinely is
//     gap-based (confirmed at 6 different absolute bases from 15 to 40).
//
// KNOWN GAP: fleets mixing 2-3 ship types on either side fit noticeably worse
// than pure single-type duels or single-type-vs-single-type cross matchups —
// mean error ~0.3pp, worst case ~5.8pp in a 1673-case realistic-scale dataset,
// vs <0.1pp almost everywhere else. A CV-share-weighted average of the pairwise
// weights was tried as the natural fix and made every mixed-fleet case WORSE,
// so the flat 0.813 fallback stays as the best known approximation. See
// docs/battle-model.md for what's been ruled out.
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
    const N_EXP = 1.805;             // saturation curve exponent
    const RACE_ATK_PCT = 0.08;       // confirmed exact, 6.0.0-beta (was 0.07)
    const RACE_DEF_PCT = 0.12;       // confirmed exact, 6.0.0-beta (was 0.11)
    const PHYS_SLOPE = 0.01491;      // per physics level, below the bracket
    const PHYS_BRACKET = Math.log(1.25); // fitted 0.2235 ≈ ln(1.25); triggers at |diff| >= 6
    const PLEVEL_WIN_K = 0.00995;    // applied to the RAW difference — see file header
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

    // The CV-vs-attack-value blend weight for this matchup: pair-specific for a
    // pure single-type duel with no starbase, the global fallback otherwise.
    function cvWeight(atkFleet, defFleet, hasStarbase) {
        if (hasStarbase) return P_CV_WEIGHT;
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

        const w = cvWeight(atkFleet, defFleet, sbLevel > 0);
        let lneff = w * Math.log(aCV / dCV) + (1 - w) * Math.log(Math.max(aAtk, 1e-9) / Math.max(dAtk, 1e-9));

        lneff += Math.log(1 + RACE_ATK_PCT * atk.ra) - Math.log(1 + RACE_ATK_PCT * def.ra);

        const physDiff = atk.phys - def.phys;
        lneff += Math.log(1 + PHYS_SLOPE * atk.phys) - Math.log(1 + PHYS_SLOPE * def.phys);
        if (physDiff >= 6) lneff += PHYS_BRACKET;
        else if (physDiff <= -6) lneff -= PHYS_BRACKET;

        // Player level: gated per side on fielding all three ship types, and applied to
        // the RAW DIFFERENCE as one number — see the file header note on why this isn't
        // two separate per-side ln(1+k·PL) terms.
        const aLvl = hasAllThree(atkFleet) ? atk.lvl : 0;
        const dLvl = hasAllThree(defFleet) ? def.lvl : 0;
        const plDiff = aLvl - dLvl;
        if (plDiff !== 0) lneff += sgn(plDiff) * Math.log(1 + PLEVEL_WIN_K * Math.abs(plDiff));

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

        // Own-side toughness: mathematics (absolute level + gap bracket), race defense,
        // and player level (gated on all-3-types, own-vs-enemy DIFFERENCE, multiplicative)
        // — independent factors, order doesn't matter for a pure product.
        function toughnessMult(ownMath, enemyMath, ownRD, ownFleet, ownLvl, enemyLvl) {
            let t = 1 + MATH_SLOPE * ownMath;
            const gap = ownMath - enemyMath;
            if (gap >= 6) t *= (1 + MATH_BRACKET);
            else if (gap <= -6) t *= (1 - MATH_BRACKET);
            t *= (1 + RACE_DEF_PCT * ownRD);
            if (hasAllThree(ownFleet)) t *= (1 + PLEVEL_SURV_SLOPE * Math.max(0, ownLvl - enemyLvl));
            return t;
        }

        const enemyCVtoDef = cvOf(atkFleet);
        const enemyCVtoAtk = cvOf(defFleet) + sbCv;
        // Starbase toughness is excluded from the denominator when a fleet is ALSO
        // defending (confirmed: the fleet's own survivors match toughOf(fleet) alone,
        // and the starbase's survival fraction matches that SAME lossFrac). But a
        // starbase defending with no fleet at all has nothing else to use, so it falls
        // back to its own toughness (att+2*def, att=def=floor(cv/2)) — without this,
        // toughOf([0,0,0])=0 makes a lone starbase take zero losses regardless of the
        // attacker, which is not what the calculator does.
        const defTough = defFleet.some(n => n > 0) ? toughOf(defFleet) : (sbLvl > 0 ? sbHalf(sbLvl) * 3 : 0);
        const atkTough = toughOf(atkFleet);

        const defMult = toughnessMult(def.math, atk.math, def.rd, defFleet, def.lvl, atk.lvl);
        const atkMult = toughnessMult(atk.math, def.math, atk.rd, atkFleet, atk.lvl, def.lvl);

        const fracDefKilled = defTough > 0 ? Math.min(1, enemyCVtoDef / defTough) / defMult : 0;
        const fracAtkKilled = atkTough > 0 ? Math.min(1, enemyCVtoAtk / atkTough) / atkMult : 0;

        // A race-defense or mathematics malus can push an already-large (post-min(1,·))
        // loss fraction up to or past 1 — landing at EXACTLY 1 counts as an overshoot
        // here too, not just past it: five otherwise-identical mathematics-bracket
        // observations (a diff-6-vs-0 malus exactly cancelling the 0.75 base ratio for a
        // mirror fleet) all showed 1 survivor, never 0, even though the raw formula lands
        // on exactly 0. A loss fraction that lands STRICTLY UNDER 1 naturally is left
        // alone and CAN legitimately reach exactly 0 — confirmed by scanning every
        // single-type, non-deterministic fixture harvested (0 counterexamples).
        const applyLoss = (fleet, frac) => fleet.map(n => {
            if (n <= 0) return 0;
            const raw = n * (1 - frac);
            return raw <= 0 ? 1 : raw;
        });

        let survDef = applyLoss(defFleet, fracDefKilled);
        let survAtk = applyLoss(atkFleet, fracAtkKilled);
        let survSB = sbLvl > 0 ? Math.max(0, 1 - fracDefKilled) : 0;

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
    //   * MIXED_FLEET_EXTRA_PP covers the one identified remaining gap: a side fielding
    //     2-3 ship types fits noticeably worse than a pure duel (mean ~0.3pp, worst
    //     observed 5.8pp in a 1673-case realistic dataset) because the CV/attack blend
    //     weight is pair-specific for pure duels but falls back to one flat constant for
    //     a real mix — see the file header. Widen the band rather than claim precision
    //     the data doesn't support.
    //
    // The OLD caveats here (starbase alongside a fleet, a 6+ mathematics gap) are GONE:
    // both are now modelled exactly (mean ~0.06pp and ~0.00pp respectively across the
    // harvested data) rather than approximated, so they no longer need extra margin.
    //
    // src/utils/battle-calc.test.js asserts BASE_ERROR_PP is not smaller than the worst
    // error the fixtures actually show, so the stated confidence can never drift below
    // the measured one.
    const BASE_ERROR_PP = 1.0;
    const MIXED_FLEET_EXTRA_PP = 5.0;

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
            PHYS_SLOPE, PHYS_BRACKET,
            PLEVEL_WIN_K, PLEVEL_SURV_SLOPE,
            MATH_SLOPE, MATH_BRACKET, LN_CAP
        }
    };
});
