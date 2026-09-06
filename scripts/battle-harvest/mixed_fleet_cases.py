"""1000-case follow-up matrix, scoped by the user's own game-mechanics pointers:

1. Allied flag: already confirmed no effect (results.md) -- not re-tested here.
2. Player level ("autogrowth"/combat bonus?) is claimed to only activate when a
   fleet fields ALL THREE ship types AND the science levels are high enough to
   legitimately build them: Mathematics >= 15 unlocks cruisers, Physics >= 15
   unlocks battleships. If a fleet carries CR/BS but the input science is below
   that gate, player level is claimed to have no effect. The original dataset
   only ever tested player level on pure-destroyer fleets, so it could not have
   seen this -- this file is built to test the claim directly, including the
   exact 14/15/16 boundary on each science.
3. Realistic end-game fleets run 100k-150k total CV, biggest observed ~180k CV.
   Everything in the original 1760-row dataset topped out at CV ~13k (starbase
   level 20) or a handful of contrived 1,000,000-ship overflow probes -- nothing
   in the realistic 50k-180k range was ever sampled for MIXED fleets specifically.

Also requested: physics/mathematics in the 30-40 range, and player level 1-30.
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
    """Ship counts for a fleet at `total_cv` split by CV-share (fd+fc+fb=1)."""
    n_de = round(total_cv*fd/SH['de'][2])
    n_cr = round(total_cv*fc/SH['cr'][2])
    n_bs = round(total_cv*fb/SH['bs'][2])
    return n_de, n_cr, n_bs

PRESETS = {
    'balanced':   (0.34, 0.33, 0.33),
    'de-heavy':   (0.60, 0.25, 0.15),
    'bs-heavy':   (0.15, 0.25, 0.60),
    'cr-heavy':   (0.20, 0.60, 0.20),
    'de-bs-only': (0.50, 0.00, 0.50),  # still needs a token cruiser to count as "all three" in block P1
}

def fleet3(total_cv, preset, min_cr=1, min_bs=1):
    fd, fc, fb = PRESETS[preset]
    de, cr, bs = split(total_cv, fd, fc, fb)
    return max(de, 0), max(cr, min_cr), max(bs, min_bs)

# ── P1. Player-level activation gate: does it need ALL THREE types AND
#        Math>=15 (cruisers) AND Physics>=15 (battleships)? ─────────────────
BASE_CV = 100_000
de0, cr0, bs0 = fleet3(BASE_CV, 'balanced')
def_de, def_cr, def_bs = fleet3(BASE_CV, 'balanced')  # identical mirror defender

science_conditions = [
    ("both-below-15",  10, 10),
    ("math-below-only", 10, 20),   # math<15 (cruisers "shouldn't" exist), physics ok
    ("phys-below-only", 20, 10),   # physics<15 (battleships "shouldn't" exist), math ok
    ("both-above-15",  20, 20),
]
for cond, math_lvl, phys_lvl in science_conditions:
    for pl in (1, 5, 10, 15, 20, 25, 30):
        add("P1-gate-3type", f"3-type fleet, {cond}, aPL={pl}",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
              a_ph=phys_lvl, a_ma=math_lvl, d_ph=phys_lvl, d_ma=math_lvl, a_pl=pl))

# same grid but only TWO ship types present (no battleships) -- player level
# should never activate here regardless of science, since "all three" isn't met
de2, cr2, _ = fleet3(BASE_CV, 'balanced')
for cond, math_lvl, phys_lvl in science_conditions:
    for pl in (1, 15, 30):
        add("P1-gate-2type", f"2-type (no BS) fleet, {cond}, aPL={pl}",
            C(a_de=de2, a_cr=cr2, d_de=de2, d_cr=cr2,
              a_ph=phys_lvl, a_ma=math_lvl, d_ph=phys_lvl, d_ma=math_lvl, a_pl=pl))

# single-type sanity replay at realistic scale (should still show zero effect)
for pl in (1, 15, 30):
    add("P1-gate-1type", f"pure destroyer, aPL={pl}",
        C(a_de=33333, d_de=33333, a_ma=30, a_ph=30, a_pl=pl))

# ── P2. Exact 14/15/16 boundary on each science, crossed independently ──────
for math_lvl in (13, 14, 15, 16, 17):
    for phys_lvl in (13, 14, 15, 16, 17):
        for pl in (1, 30):
            add("P2-boundary", f"math={math_lvl} phys={phys_lvl} aPL={pl}",
                C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
                  a_ma=math_lvl, a_ph=phys_lvl, d_ma=math_lvl, d_ph=phys_lvl, a_pl=pl))

# ── P3. Player level 1-30 fine sweep, once the gate is confirmed open
#        (both sciences well above 15), attacker only then both sides ───────
for pl in range(1, 31):
    add("P3-plevel-sweep-att", f"aPL={pl}, gate open",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ma=35, a_ph=35, d_ma=35, d_ph=35, a_pl=pl))
for pl in range(1, 31):
    add("P3-plevel-sweep-both", f"both PL={pl}, gate open",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ma=35, a_ph=35, d_ma=35, d_ph=35, a_pl=pl, d_pl=pl))

# ── R1. Realistic-scale mixed-fleet duels: CV 50k-180k, math/phys 30-40,
#        player level 1-30, race mods, starbase -- the bulk of this round,
#        aimed at refitting the mixed-fleet blend at the scale that matters. ──
random.seed(2026)
CV_TARGETS = [50_000, 80_000, 100_000, 120_000, 150_000, 180_000]
PRESET_NAMES = list(PRESETS.keys())
for _ in range(560):
    aCV = random.choice(CV_TARGETS)
    dCV = random.choice(CV_TARGETS)
    aPreset = random.choice(PRESET_NAMES)
    dPreset = random.choice(PRESET_NAMES)
    ade, acr, abs_ = fleet3(aCV, aPreset)
    dde, dcr, dbs = fleet3(dCV, dPreset)
    add("R1-realistic-random", f"aCV~{aCV} dCV~{dCV} presets {aPreset}/{dPreset}", C(
        a_de=ade, a_cr=acr, a_bs=abs_,
        d_de=dde, d_cr=dcr, d_bs=dbs,
        d_sb=random.choice([0, 10, 14, 16, 18, 20]),
        a_ph=random.randint(30, 40), a_ma=random.randint(30, 40),
        d_ph=random.randint(30, 40), d_ma=random.randint(30, 40),
        a_pl=random.randint(1, 30), d_pl=random.randint(1, 30),
        a_ra=random.randint(-4, 4), a_rd=random.randint(-4, 4),
        d_ra=random.randint(-4, 4), d_rd=random.randint(-4, 4),
    ))

# ── R2. Composition-invariance at realistic scale: matched (CV, Attack) via
#        different 3-type splits, same defender, all with math/phys 30-40. ──
for target_cv in (60_000, 100_000, 150_000):
    dde, dcr, dbs = fleet3(target_cv, 'balanced')
    for preset in PRESET_NAMES:
        ade, acr, abs_ = fleet3(target_cv, preset)
        add("R2-composition-invariance", f"aCV~{target_cv} preset={preset} vs balanced defender",
            C(a_de=ade, a_cr=acr, a_bs=abs_, d_de=dde, d_cr=dcr, d_bs=dbs,
              a_ma=35, a_ph=35, d_ma=35, d_ph=35, a_pl=15, d_pl=15))

# ── R3. Physics / Mathematics dose-response at 30-40 absolute levels and
#        large diffs (up to +/-40), using 3-type fleets with the player-level
#        gate open, at realistic scale -- checks whether the +6-level bracket
#        (found at small scale) repeats, plateaus, or behaves differently
#        this far out. ─────────────────────────────────────────────────────
for aph in range(0, 41, 2):
    add("R3-physics-highrange", f"aPh={aph}, dPh=0, 3-type realistic",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ph=aph, a_ma=35, d_ma=35, a_pl=15, d_pl=15))
for ama in range(0, 41, 2):
    add("R3-math-highrange", f"aMa={ama}, dMa=0, 3-type realistic",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ma=ama, a_ph=35, d_ph=35, a_pl=15, d_pl=15))
for diff in range(-40, 41, 4):
    base = 35
    aph = base + diff if base + diff >= 0 else 0
    add("R3-physics-diff-wide", f"physics diff={diff} around lvl35",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ph=aph, d_ph=base, a_ma=35, d_ma=35, a_pl=15, d_pl=15))
    ama = base + diff if base + diff >= 0 else 0
    add("R3-math-diff-wide", f"math diff={diff} around lvl35",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ma=ama, d_ma=base, a_ph=35, d_ph=35, a_pl=15, d_pl=15))

if __name__ == "__main__":
    from collections import Counter
    print("TOTAL:", len(cases))
    for k, v in sorted(Counter(b for b,_,_ in cases).items()):
        print(f"  {k:26s} {v}")

# ── P4. Player-level x science-gate x realistic scale, both sides varying
#        independently (does the ATTACKER'S gate/level depend on the
#        DEFENDER'S science, or only its own?) ──────────────────────────────
for pl_a in (1, 15, 30):
    for pl_d in (1, 15, 30):
        add("P4-plevel-cross", f"aPL={pl_a} dPL={pl_d}, gate open both sides",
            C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
              a_ma=35, a_ph=35, d_ma=35, d_ph=35, a_pl=pl_a, d_pl=pl_d))

for pl_a in (1, 15, 30):
    # attacker gate open, defender gate CLOSED (defender math/phys=10 despite
    # having cr/bs) -- does defender's own player level still do nothing while
    # attacker's works, in the same fight?
    add("P4-plevel-asymmetric-gate", f"aPL={pl_a} gate open, defender gate closed",
        C(a_de=de0, a_cr=cr0, a_bs=bs0, d_de=def_de, d_cr=def_cr, d_bs=def_bs,
          a_ma=35, a_ph=35, d_ma=10, d_ph=10, a_pl=pl_a, d_pl=15))

# ── R4. More composition-invariance, this time varying which TWO of the
#        three presets are compared, at more scale points and with the
#        player-level gate open (matches the realistic conditions the user
#        actually cares about). ─────────────────────────────────────────────
for target_cv in (70_000, 90_000, 110_000, 130_000, 170_000):
    dde, dcr, dbs = fleet3(target_cv, 'balanced')
    for preset in ('de-heavy', 'bs-heavy', 'cr-heavy'):
        ade, acr, abs_ = fleet3(target_cv, preset)
        add("R4-composition-invariance-2", f"aCV~{target_cv} preset={preset} vs balanced, gate open",
            C(a_de=ade, a_cr=acr, a_bs=abs_, d_de=dde, d_cr=dcr, d_bs=dbs,
              a_ma=35, a_ph=35, d_ma=35, d_ph=35, a_pl=15, d_pl=15,
              a_ra=2, d_ra=-2))

# ── R5. Realistic asymmetric mismatches near the 1.5x threshold, at full
#        scale, all 3 types + player level + high science -- checks whether
#        the certainty-clip / saturation curve found at toy scale still
#        holds exactly at 100k+ CV with the player-level bonus active. ──────
random.seed(99)
for ratio in (0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6):
    baseCV = 100_000
    dCV = baseCV
    aCV = round(baseCV*ratio)
    preset = random.choice(PRESET_NAMES)
    ade, acr, abs_ = fleet3(aCV, preset)
    dde, dcr, dbs = fleet3(dCV, 'balanced')
    add("R5-threshold-at-scale", f"ratio={ratio} at 100k CV, preset={preset}, gate open",
        C(a_de=ade, a_cr=acr, a_bs=abs_, d_de=dde, d_cr=dcr, d_bs=dbs,
          a_ma=35, a_ph=35, d_ma=35, d_ph=35, a_pl=15, d_pl=15))

# ── R6. Fill: more fully-random realistic scenarios (same shape as R1) to
#        round the matrix out to ~1000 and give the eventual refit a larger,
#        less structured hold-out set. ──────────────────────────────────────
for _ in range(150):
    aCV = random.choice(CV_TARGETS)
    dCV = random.choice(CV_TARGETS)
    aPreset = random.choice(PRESET_NAMES)
    dPreset = random.choice(PRESET_NAMES)
    ade, acr, abs_ = fleet3(aCV, aPreset)
    dde, dcr, dbs = fleet3(dCV, dPreset)
    add("R6-realistic-random-2", f"aCV~{aCV} dCV~{dCV} presets {aPreset}/{dPreset}", C(
        a_de=ade, a_cr=acr, a_bs=abs_,
        d_de=dde, d_cr=dcr, d_bs=dbs,
        d_sb=random.choice([0, 12, 15, 17, 19, 20]),
        a_ph=random.randint(30, 40), a_ma=random.randint(30, 40),
        d_ph=random.randint(30, 40), d_ma=random.randint(30, 40),
        a_pl=random.randint(1, 30), d_pl=random.randint(1, 30),
        a_ra=random.randint(-4, 4), a_rd=random.randint(-4, 4),
        d_ra=random.randint(-4, 4), d_rd=random.randint(-4, 4),
    ))
