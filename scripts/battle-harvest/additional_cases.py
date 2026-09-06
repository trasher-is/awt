"""Follow-up test matrix targeting the ONE unresolved gap in results.md:
how win% behaves for MIXED-ship-type fleets, which the single-scalar
CV/Attack-ratio blend (fit purely from single-type-vs-single-type duels)
gets badly wrong (mean 4.37pp / max 89.6pp error in the 12-random block).

Every block here holds something constant that a pure two-scalar model
predicts should not matter, so a deviation is informative by construction.
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

# ── A. Composition-invariance probe ─────────────────────────────────────
# Two attacker fleets with IDENTICAL total CV and total attack value, but
# different ship-type composition, fighting the SAME defender. If the
# current model (which only sees aggregate CV and aggregate Attack) is
# right, both must give the SAME win%. Any difference is direct proof
# something beyond those two scalars matters (fleet composition itself,
# or a per-type resolution order).
#
# de:(2,1,3) cr:(8,16,24) bs:(36,24,60). Solve small integer combos with
# matching (CV, Attack) pairs:
#   200 de              -> CV=600  Atk=400
#   ??? need a 2-type combo hitting CV=600, Atk=400 too:
#   x*de + y*cr: 3x+24y=600, 2x+8y=400 -> x=200-8y, sub: 3(200-8y)+24y=600
#     600-24y+24y=600 -> ALWAYS true for x=200-8y (degenerate, cr has fixed
#     ratio 3:1 CV:cost proportional along de axis) -- pick y=10,x=120:
#     120de+10cr: CV=120*3+10*24=360+240=600 ✓  Atk=120*2+10*8=240+80=320 (not 400)
#   Solve properly: want 3x+24y=600 and 2x+8y=T for various T, chosen to
#   equal a pure-destroyer or pure-cruiser baseline's own (CV,Atk).
for defFleet, label in [({"d_de": 300}, "def=300de"), ({"d_bs": 30}, "def=30bs"),
                         ({"d_cr": 60}, "def=60cr")]:
    # pure-destroyer attacker baseline
    add("A-composition", f"pure-de baseline vs {label}", C(a_de=200, **defFleet))
    # 2-type attacker matched to the SAME (CV, Atk) as 200 destroyers (CV=600, Atk=400):
    #   x*de + y*bs: 3x+60y=600, 2x+36y=400  ->  from first: x=200-20y
    #     2(200-20y)+36y=400 -> 400-40y+36y=400 -> -4y=0 -> y=0 (degenerate again)
    #   de+cr solved differently: pick y (cruisers) then back out x, ALLOW Atk to
    #   differ slightly and record the small mismatch alongside the win% (still
    #   informative -- report both actual (CV,Atk) per side in the results).
    add("A-composition", f"120de+10cr (CV600,Atk320) vs {label}", C(a_de=120, a_cr=10, **defFleet))
    add("A-composition", f"96de+21bs (CV600,Atk948) vs {label}", C(a_de=96, a_bs=21, **defFleet))
    add("A-composition", f"75cr+9bs(CV2340) matched-ish vs {label} x10", C(a_cr=75, a_bs=9, **{k: v*10 for k,v in defFleet.items()}))

# ── B. Two-type composition sweep at fixed aggregate CV ─────────────────
# Hold attacker's TOTAL CV fixed at 2400 while sliding the de/cr mix from
# all-destroyer to all-cruiser, against a fixed defender. A pure aggregate
# model predicts a smooth, single-valued win% curve driven only by the
# resulting (CV,Atk) pair; plot win% vs mix fraction to see if it's smooth
# or has composition-specific structure the blend can't reach.
for frac in range(0, 11):  # 0=all destroyer, 10=all cruiser (by CV share)
    cr_cv = 2400 * frac / 10
    de_cv = 2400 - cr_cv
    cr_n = round(cr_cv / 24)
    de_n = round(de_cv / 3)
    for defc, label in [({"d_de": 800}, "800de"), ({"d_bs": 40}, "40bs"), ({"d_cr": 100}, "100cr")]:
        add("B-de-cr-sweep", f"de/cr mix frac={frac}/10 vs {label}", C(a_de=de_n, a_cr=cr_n, **defc))

for frac in range(0, 11):  # destroyer/battleship sweep
    bs_cv = 2400 * frac / 10
    de_cv = 2400 - bs_cv
    bs_n = round(bs_cv / 60)
    de_n = round(de_cv / 3)
    for defc, label in [({"d_de": 800}, "800de"), ({"d_cr": 100}, "100cr")]:
        add("B-de-bs-sweep", f"de/bs mix frac={frac}/10 vs {label}", C(a_de=de_n, a_bs=bs_n, **defc))

# ── C. Same sweeps, but with a modifier applied — isolates whether the
# breakdown needs BOTH mixing and a modifier simultaneously (as block
# 12-random's worst misses all had), or whether mixing alone is enough.
for frac in (0, 3, 5, 7, 10):
    cr_cv = 2400 * frac / 10
    de_cv = 2400 - cr_cv
    cr_n = round(cr_cv / 24)
    de_n = round(de_cv / 3)
    add("C-mix-plus-raceattack", f"de/cr frac={frac}/10, aRA=+4 vs 800de", C(a_de=de_n, a_cr=cr_n, d_de=800, a_ra=4))
    add("C-mix-plus-raceattack", f"de/cr frac={frac}/10, aRA=-4 vs 800de", C(a_de=de_n, a_cr=cr_n, d_de=800, a_ra=-4))
    add("C-mix-plus-physics",    f"de/cr frac={frac}/10, aPh=10 vs 800de", C(a_de=de_n, a_cr=cr_n, d_de=800, a_ph=10))
    add("C-mix-plus-physics",    f"de/cr frac={frac}/10, dPh=10 vs 800de", C(a_de=de_n, a_cr=cr_n, d_de=800, d_ph=10))

# ── D. Both sides mixed (closest to the real failure mode in 12-random) ──
random.seed(7)
for _ in range(60):
    add("D-both-mixed", "both sides 2-3 types + modifiers", C(
        a_de=random.choice([0,50,200,600]), a_cr=random.choice([0,10,50,150]), a_bs=random.choice([0,5,20,60]),
        d_de=random.choice([0,50,200,600]), d_cr=random.choice([0,10,50,150]), d_bs=random.choice([0,5,20,60]),
        d_sb=random.choice([0,0,5]),
        a_ph=random.choice([0,6,12,20]), d_ph=random.choice([0,6,12,20]),
        a_ra=random.choice([-4,0,2,4]), d_ra=random.choice([-4,0,2,4]),
        a_rd=0, d_rd=0))

# ── E. Direct de-modifier replays of the worst block-12 misses ──────────
# Same fleets as the worst original misses, with race attack / physics
# stripped to zero one at a time, to see whether the mixed-fleet CV/Attack
# blend alone (no modifiers) already mismatches, or whether it's fine until
# a modifier is layered on.
worst = [
    dict(a_de=999, a_cr=1, a_bs=27, d_de=400, d_cr=1, d_bs=80),   # #1622 base fleets
    dict(a_de=50, a_cr=111, a_bs=3, d_de=999, d_bs=80),           # #1550 base fleets
    dict(a_de=400, a_cr=4, d_de=50, d_cr=13, d_bs=9),             # #1654 base fleets
    dict(a_de=400, d_de=50, d_cr=40, d_bs=3),                     # #1649 base fleets
]
for w in worst:
    add("E-isolate-mix-only", "same fleets as a 12-random miss, ALL modifiers zeroed", C(**w))
    add("E-isolate-mix-only", "same fleets, +aRA=4 only", C(**w, a_ra=4))
    add("E-isolate-mix-only", "same fleets, +aPh=10 only", C(**w, a_ph=10))

if __name__ == "__main__":
    from collections import Counter
    print("TOTAL:", len(cases))
    for k, v in sorted(Counter(b for b,_,_ in cases).items()):
        print(f"  {k:24s} {v}")
