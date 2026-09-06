"""Follow-up round targeting the two open items from results.md:
  1. Both-sides player level (1-30) interaction -- prior data only ever swept
     ONE side's player level with the other fixed; the two tested cases with
     both sides large (15 vs 30) showed a bigger residual (~2.7pp) than the
     one-sided fits (~0.01pp), so this round grids PL_atk x PL_def properly.
  2. Physics/Mathematics generalization across 15-40 (prior fits used base
     level 35 only) and a second fleet composition/CV for the player-level
     survivor formula (previously fit to exactly one fleet shape).
All fleets here have three ship types on both sides, per the request.
"""
import random

FIELDS = ["a_de","a_cr","a_bs","d_de","d_cr","d_bs","d_sb",
          "a_ph","a_ma","a_pl","a_ra","a_rd",
          "d_ph","d_ma","d_pl","d_ra","d_rd","allied"]

def C(**kw):
    c = dict.fromkeys(FIELDS, 0); c["allied"] = False; c.update(kw); return c

cases = []
def add(block, purpose, c): cases.append((block, purpose, c))

SH = {'de': (2,1,3), 'cr': (8,16,24), 'bs': (36,24,60)}

def split(total_cv, fd, fc, fb):
    n_de = round(total_cv*fd/SH['de'][2])
    n_cr = round(total_cv*fc/SH['cr'][2])
    n_bs = round(total_cv*fb/SH['bs'][2])
    return n_de, n_cr, n_bs

PRESETS = {
    'balanced': (0.34, 0.33, 0.33),
    'de-heavy': (0.60, 0.25, 0.15),
    'bs-heavy': (0.15, 0.25, 0.60),
    'cr-heavy': (0.20, 0.60, 0.20),
}

def fleet3(total_cv, preset):
    fd, fc, fb = PRESETS[preset]
    de, cr, bs = split(total_cv, fd, fc, fb)
    return max(de,1), max(cr,1), max(bs,1)

BASE_CV = 100_000
de0, cr0, bs0 = fleet3(BASE_CV, 'balanced')

PL_GRID = [1, 3, 5, 8, 11, 14, 17, 20, 23, 26, 30]

# ── G1. Full PL_atk x PL_def grid, 3-type both sides, fixed mid science ────
for pa in PL_GRID:
    for pd in PL_GRID:
        add("G1-plgrid-mid", f"aPL={pa} dPL={pd}, ph=ma=25 both sides",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
              a_ph=25, a_ma=25, d_ph=25, d_ma=25, a_pl=pa, d_pl=pd))

# ── G2. Same grid, but at LOW science (15, the claimed gate threshold) and
#        HIGH science (40) -- checks whether the PL-vs-PL interaction shape
#        depends on the science level it's evaluated at. ───────────────────
PL_GRID_COARSE = [1, 5, 10, 15, 20, 25, 30]
for sci in (15, 40):
    for pa in PL_GRID_COARSE:
        for pd in PL_GRID_COARSE:
            add(f"G2-plgrid-sci{sci}", f"aPL={pa} dPL={pd}, ph=ma={sci} both sides",
                C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
                  a_ph=sci, a_ma=sci, d_ph=sci, d_ma=sci, a_pl=pa, d_pl=pd))

# ── G3. PL difference at FIXED sum (does only PL_atk-PL_def matter, or does
#        the total/absolute level matter too, mirroring the race-attack
#        finding that diff alone wasn't sufficient there)? ─────────────────
for diff in range(-29, 30, 2):
    for sci in (20, 30):
        pa = max(1, min(30, 15 + diff))
        pd = max(1, min(30, 15))
        if pa - pd != diff:  # clamp changed the diff at the edges; skip those
            continue
        add("G3-pldiff-fixed-base", f"PLdiff={diff} (aPL={pa},dPL={pd}) sci={sci}",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
              a_ph=sci, a_ma=sci, d_ph=sci, d_ma=sci, a_pl=pa, d_pl=pd))
        pa2, pd2 = min(30, 5+max(diff,0)), min(30, 5+max(-diff,0))
        add("G3-pldiff-fixed-base", f"PLdiff={diff} (aPL={pa2},dPL={pd2}) sci={sci}",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
              a_ph=sci, a_ma=sci, d_ph=sci, d_ma=sci, a_pl=pa2, d_pl=pd2))

# ── H1. Physics diff sweep at multiple absolute bases (15,20,25,30,35,40),
#        3-type fleets both sides, PL fixed open (15/15) -- generalizes the
#        physics slope/bracket fit beyond the single base=35 tested before. ─
for base in (15, 20, 25, 30, 35, 40):
    for diff in range(-12, 13, 2):
        aph = base + diff
        if aph < 0 or aph > 100: continue
        add("H1-physics-base-sweep", f"physics base={base} diff={diff}",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
              a_ph=aph, d_ph=base, a_ma=25, d_ma=25, a_pl=15, d_pl=15))

# ── H2. Mathematics diff sweep at multiple absolute bases -- same idea,
#        checks the survivor-side math bracket generalizes across 15-40. ────
for base in (15, 20, 25, 30, 35, 40):
    for diff in range(-12, 13, 2):
        ama = base + diff
        if ama < 0 or ama > 100: continue
        add("H2-math-base-sweep", f"math base={base} diff={diff}",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
              a_ma=ama, d_ma=base, a_ph=25, d_ph=25, a_pl=15, d_pl=15))

# ── J1. Second/third fleet composition, PL 1-30 one-sided sweep (defender
#        fixed at pl=1) -- generalizes the player-level SURVIVOR formula
#        (previously fit to exactly the 'balanced' 100k-CV composition). ────
for preset in ('de-heavy', 'cr-heavy', 'bs-heavy'):
    for cv in (60_000, 150_000):
        ade, acr, abs_ = fleet3(cv, preset)
        dde, dcr, dbs = fleet3(cv, 'balanced')
        for pl in range(1, 31):
            add(f"J1-plsurv-{preset}", f"aPL={pl}, preset={preset}, CV={cv}",
                C(a_de=ade, a_cr=acr, a_bs=abs_, d_de=dde, d_cr=dcr, d_bs=dbs,
                  a_ma=25, a_ph=25, d_ma=25, d_ph=25, a_pl=pl, d_pl=1))

# ── K1. Three-way interaction: PL diff x physics diff x math diff, modest
#        grid, 3-type both sides -- checks the log-additive combination
#        holds when all three vary together, not just pairwise. ────────────
random.seed(4242)
for _ in range(120):
    add("K1-triple-interaction", "PL x physics x math, all varying",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=de0, d_cr=cr0, d_bs=bs0,
          a_pl=random.randint(1,30), d_pl=random.randint(1,30),
          a_ph=random.randint(15,40), d_ph=random.randint(15,40),
          a_ma=random.randint(15,40), d_ma=random.randint(15,40)))

if __name__ == "__main__":
    from collections import Counter
    print("TOTAL:", len(cases))
    for k, v in sorted(Counter(b for b,_,_ in cases).items()):
        print(f"  {k:26s} {v}")
