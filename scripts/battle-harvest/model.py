"""Reverse-engineered astrowars.games battle calculator model.
Fitted against scripts/battle-harvest/results.jsonl (1760 live observations, 2026-09-06),
mixed_results.jsonl (1002 observations, realistic-scale mixed fleets), and
pl_science_results.jsonl (735 observations, two-sided player level + physics/math 15-40).
"""
import math

SHIP = {  # (attack, defense, cv)
    'de': (2, 1, 3),
    'cr': (8, 16, 24),
    'bs': (36, 24, 60),
}

# --- fitted constants -------------------------------------------------
P_CV_WEIGHT   = 0.813     # fallback weight for MIXED fleets (2-3 types on a side)
# Pure single-type-vs-single-type duels fit this weight EXACTLY per pair
# (<0.05pp max error each, vs ~1pp with one global constant) -- confirmed via
# a dense 90-point destroyer-vs-battleship sweep after the global constant
# showed a systematic ~1pp residual specific to that pairing that neither
# reweighting nor adding a defense-ratio term could close. n stays constant
# (~1.79-1.81) across all three pairs -- only the CV-vs-attack-value blend
# weight genuinely depends on which two ship types are fighting.
PAIR_CV_WEIGHT = {
    frozenset(('de', 'cr')): 0.807,
    frozenset(('bs', 'de')): 0.760,
    frozenset(('bs', 'cr')): 0.816,
}
N_EXP         = 1.805     # saturation exponent
RACE_ATK_PCT  = 0.08      # confirmed exact from game-rules.md (6.0.0-beta)
RACE_DEF_PCT  = 0.12      # confirmed exact from game-rules.md (6.0.0-beta)
PHYS_SLOPE    = 0.01491   # fitted, per physics level below the bracket
PHYS_BRACKET  = math.log(1.25)  # fitted 0.2235, ~= ln(1.25); triggers at |Ph diff| >= 6
PLEVEL_WIN_K  = 0.00995   # fitted: ln(1+k*PL) added to lneff, same architecture as race attack
PLEVEL_SURV_SLOPE = 0.01  # fitted exactly: toughness *= (1 + 0.01*max(0, ownPL-enemyPL))
MATH_SLOPE    = 0.0015    # confirmed exact -- applies to OWN ABSOLUTE math level (see survivors())
MATH_BRACKET  = 0.25      # CORRECTED from battle-model.js's 0.125 -> fitted exactly 0.25
LN_CAP        = math.log(1.5)   # the "1.5x" annihilation/certainty threshold


def starbase_cv(level):
    if level <= 0:
        return 0.0
    return round(4 * 1.5 ** level) - 4


def fleet_cv_atk(fleet):
    de, cr, bs = fleet
    return de*SHIP['de'][2] + cr*SHIP['cr'][2] + bs*SHIP['bs'][2]


def fleet_atk_val(fleet):
    de, cr, bs = fleet
    return de*SHIP['de'][0] + cr*SHIP['cr'][0] + bs*SHIP['bs'][0]


def fleet_def_val(fleet):
    de, cr, bs = fleet
    return de*SHIP['de'][1] + cr*SHIP['cr'][1] + bs*SHIP['bs'][1]


def _sat(lneff):
    R = math.exp(min(abs(lneff), LN_CAP))
    x = 2*(R-1)
    top = 1 - 0.5*(1-x)**N_EXP
    return top if lneff >= 0 else 1-top


def _cv_weight(atk_fleet, dfn_fleet, has_starbase):
    """Pair-specific weight for a pure single-type duel with no starbase;
    the global fallback otherwise (mixed fleets, or a starbase changing the
    defender's effective 'type' mix)."""
    SHIPS = ('de', 'cr', 'bs')
    atypes = [t for t, n in zip(SHIPS, atk_fleet) if n > 0]
    dtypes = [t for t, n in zip(SHIPS, dfn_fleet) if n > 0]
    if has_starbase or len(atypes) != 1 or len(dtypes) != 1:
        return P_CV_WEIGHT
    if atypes[0] == dtypes[0]:
        return 0.5  # CV ratio == attack ratio identically; weight is moot
    return PAIR_CV_WEIGHT.get(frozenset((atypes[0], dtypes[0])), P_CV_WEIGHT)


def win_pct(atk, dfn):
    """atk/dfn: dicts with fleet=[D,C,B], physics, raceAttack. dfn also: starbase (level)."""
    aCV = fleet_cv_atk(atk['fleet'])
    dCV = fleet_cv_atk(dfn['fleet']) + starbase_cv(dfn.get('starbase', 0))
    aAtk = fleet_atk_val(atk['fleet'])
    sb = dfn.get('starbase', 0)
    sbAtk = (starbase_cv(sb) / 2) if sb > 0 else 0
    dAtk = fleet_atk_val(dfn['fleet']) + sbAtk

    if aCV == 0 and dCV == 0:
        return 0.0  # confirmed: empty vs empty is 0.00%, not a 50/50 coin flip
    if dCV == 0:
        return 100.0
    if aCV == 0:
        return 0.0

    w = _cv_weight(atk['fleet'], dfn['fleet'], sb > 0)
    lneff = w*math.log(aCV/dCV) + (1-w)*math.log(max(aAtk,1e-9)/max(dAtk,1e-9))

    ara, dra = atk.get('raceAttack', 0), dfn.get('raceAttack', 0)
    lneff += math.log(1+RACE_ATK_PCT*ara) - math.log(1+RACE_ATK_PCT*dra)

    aph, dph = atk.get('physics', 0), dfn.get('physics', 0)
    diff = aph - dph
    lneff += math.log(1+PHYS_SLOPE*aph) - math.log(1+PHYS_SLOPE*dph)
    if diff >= 6: lneff += PHYS_BRACKET
    elif diff <= -6: lneff -= PHYS_BRACKET

    # Player level: ONLY has any effect when a side fields all three ship
    # types (confirmed: with 2 types present it's a flat no-op regardless of
    # player level or science). The "needs Math/Physics >= 15 too" hypothesis
    # this was fit to test was NOT observed -- player level moves win% even
    # at math=10/physics=10 as long as all three ship types are present, and
    # the 14/15/16 boundary shows zero effect on either side of it.
    #
    # IMPORTANT: this is a function of the RAW DIFFERENCE (ownPL - enemyPL)
    # taken as one number, NOT a difference of two independent per-side
    # ln(1+k*PL) terms -- those look similar but are mathematically different
    # functions. A 121-point two-sided grid showed lneff depends on
    # (aPL-dPL) ALONE with essentially zero spread (<0.001 in lneff, i.e.
    # <0.1pp) across every pair of (aPL,dPL) sharing the same difference,
    # regardless of the absolute levels involved. The old per-side-difference
    # form fit each ONE-SIDED sweep (enemy fixed near 0) almost exactly but
    # diverged by up to 2.7pp once both sides had a large, comparable player
    # level -- because ln(1+k*a)-ln(1+k*b) is NOT the same function as
    # ln(1+k*(a-b)) except in the limit of small k. Applying it directly to
    # the raw difference instead drops max error on that same grid from
    # 2.7pp to 0.03pp, using the SAME k already found from the one-sided fit.
    apl, dpl = atk.get('playerLevel', 0), dfn.get('playerLevel', 0)
    aGate, dGate = all(n > 0 for n in atk['fleet']), all(n > 0 for n in dfn['fleet'])
    plDiff = (apl if aGate else 0) - (dpl if dGate else 0)
    if plDiff != 0:
        lneff += math.copysign(math.log(1+PLEVEL_WIN_K*abs(plDiff)), plDiff)

    return 100*_sat(lneff)


def survivors(atk, dfn, win=None):
    """Returns (atkSurvivors[D,C,B], dfnSurvivors[D,C,B,SB]).

    win, if given, is win_pct(atk, dfn): when it lands exactly on the 0/100
    annihilation clip, the LOSING side is wiped to 0 regardless of what the
    CV-ratio loss formula alone would say -- confirmed by aRA=-3/dRA=+4 at
    otherwise-equal CV (attacker survivors 0 at win=0.00 vs 250 at win=0.31
    one race-attack point away). The winner's losses are unaffected and still
    follow the normal formula.

    Own-side "toughness" is a clean multiplicative stack on 1/lossFrac, fitted
    against a 100k-180k CV, 3-ship-type dataset (735 obs, pl_science_results)
    after an earlier fit (additive-in-reciprocal, checked against only one
    fleet shape) turned out to be wrong in a way a second fleet composition
    caught immediately:

      - Mathematics: (1 + MATH_SLOPE*ownMath) -- OWN ABSOLUTE level, not the
        gap to the enemy. The original round's "0.0015/level, diff-based"
        finding was a mislabeling: that test always held the enemy's math at
        0, so "gap" and "own absolute level" were the same number and could
        not be told apart. This round crossed own/enemy math independently
        and found the absolute-level effect present even at a perfectly
        matched (gap=0) math level, scaling with the fleet's own reciprocal
        loss fraction exactly as MATH_SLOPE already predicted.
      - The +-6 bracket IS gap-based (own - enemy math), confirmed via a
        13-level-wide sweep at 6 different absolute bases (15-40): a clean
        1.2498x multiplier at gap>=6, 0.7499x at gap<=-6, both landing on the
        already-known MATH_BRACKET=0.25 applied as a flat +-25%, not as a
        1/1.25 reciprocal.
      - Race defense: (1 + RACE_DEF_PCT*ownRD), own side only, as before.
      - Player level: (1 + PLEVEL_SURV_SLOPE*max(0, ownPL - enemyPL)) --
        ONLY if this side fields all three ship types. Confirmed
        proportional to the fleet's own reciprocal base (not a fixed
        additive constant) across 3 composition presets x 2 CV scales, all
        landing on exactly the same 0.01 ratio; and a pure straight line
        through the origin with NO jump between gap=0 and gap=1 -- an
        earlier one-sided-sweep fit had imagined a "+0.09 jump" that was
        actually the (then-unknown) math absolute-level term leaking in,
        because that sweep held both sides' math equal but nonzero.
      Order between these four multipliers (esp. race-defense/math-bracket
      vs. player-level) is not independently confirmed -- no harvested case
      varies more than one of them at a time away from a shared baseline.
      Order is irrelevant for a pure product, so this only matters if a
      future finding makes one of them non-multiplicative.
    """
    aFleet, dFleet = atk['fleet'], dfn['fleet']
    aCV = fleet_cv_atk(aFleet)
    dCV = fleet_cv_atk(dFleet) + starbase_cv(dfn.get('starbase', 0))

    aMath, dMath = atk.get('mathematics', 0), dfn.get('mathematics', 0)
    aRD, dRD = atk.get('raceDefense', 0), dfn.get('raceDefense', 0)
    apl, dpl = atk.get('playerLevel', 0), dfn.get('playerLevel', 0)

    def toughness(ownMath, enemyMath, ownRD, ownFleet, ownPL, enemyPL):
        t = 1 + MATH_SLOPE*ownMath
        gap = ownMath - enemyMath
        if gap >= 6: t *= (1+MATH_BRACKET)
        elif gap <= -6: t *= (1-MATH_BRACKET)
        t *= (1 + RACE_DEF_PCT*ownRD)
        if all(n > 0 for n in ownFleet):
            t *= (1 + PLEVEL_SURV_SLOPE*max(0, ownPL-enemyPL))
        return t

    sb = dfn.get('starbase', 0)
    aOwnStat = fleet_atk_val(aFleet) + 2*fleet_def_val(aFleet)
    # Starbase toughness is excluded from the denominator when a fleet is ALSO
    # defending, but a lone starbase (no fleet) falls back to its own toughness
    # (att+2*def, att=def=floor(cv/2)) -- otherwise a lone starbase takes zero
    # losses regardless of attacker size, which the calculator does not do.
    dOwnStat = fleet_atk_val(dFleet) + 2*fleet_def_val(dFleet) if any(dFleet) else (starbase_cv(sb)//2)*3

    aLossFrac = min(1.0, dCV / aOwnStat) / toughness(aMath, dMath, aRD, aFleet, apl, dpl) if aOwnStat else 0
    dLossFrac = min(1.0, aCV / dOwnStat) / toughness(dMath, aMath, dRD, dFleet, dpl, apl) if dOwnStat else 0

    def apply(fleet, lossFrac):
        out = []
        for n in fleet:
            if n <= 0:
                out.append(0.0); continue
            raw = n*(1-lossFrac)
            # A malus (race defense / mathematics) can push lossFrac to or past 1 even
            # though the pre-multiplier ratio was itself capped at 1 -- landing on
            # EXACTLY 1 counts too, not just past it: five otherwise-identical
            # mathematics-bracket observations (a diff-6-vs-0 malus exactly cancelling
            # the 0.75 base ratio for a mirror fleet) all showed 1 survivor, never 0,
            # even though the raw formula lands on exactly 0. A lossFrac that lands
            # STRICTLY UNDER 1 naturally is left alone and CAN legitimately reach
            # exactly 0 -- confirmed by scanning every single-type, non-deterministic
            # fixture harvested (0 counterexamples).
            if raw <= 0:
                raw = 1.0
            out.append(raw)
        return out

    aSurv = apply(aFleet, aLossFrac)
    dSurv = apply(dFleet, dLossFrac)
    if win is not None:
        if win >= 100.0:
            dSurv = [0.0 for _ in dSurv]
        elif win <= 0.0:
            aSurv = [0.0 for _ in aSurv]
    return aSurv, dSurv
