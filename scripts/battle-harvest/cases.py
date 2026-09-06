"""Test matrix for reverse-engineering the astrowars.games battle calculator.

Field semantics confirmed against the live form:
  Defender[0..3] = destroyer, cruiser, battleship, STARBASE LEVEL (0-20, 2 decimals)
  Attacker[0..2] = destroyer, cruiser, battleship  (Attacker[3] starbase is hidden/unused)
  *PhysicLevel 0-100, *MathLevel 0-100, *PlayerLevel 0-200
  *RaceModAttack -4..+4, *RaceModDefence -4..+4, IsAllied bool
"""
import random, json

FIELDS = ["a_de","a_cr","a_bs","d_de","d_cr","d_bs","d_sb",
          "a_ph","a_ma","a_pl","a_ra","a_rd",
          "d_ph","d_ma","d_pl","d_ra","d_rd","allied"]

def C(**kw):
    c = dict.fromkeys(FIELDS, 0); c["allied"] = False; c.update(kw); return c

cases = []
def add(block, purpose, c): cases.append((block, purpose, c))

# ── 1. same-type grids: force-ratio curve, free of ship-mix confounds ────────
SIZES = [1,2,3,5,10,20,50,100,250,1000]
for t,name in (("de","destroyer"),("cr","cruiser"),("bs","battleship")):
    for a in SIZES:
        for d in SIZES:
            add(f"1-{t}v{t}", f"force-ratio curve, {name} mirror", C(**{f"a_{t}":a, f"d_{t}":d}))

# ── 2. cross-type duels: does win% weigh attack power, not just CV? ─────────
XS = [1,3,10,40,150]
for ta in ("de","cr","bs"):
    for td in ("de","cr","bs"):
        if ta == td: continue
        for a in XS:
            for d in XS:
                add(f"2-{ta}v{td}", "attack-power vs CV separation", C(**{f"a_{ta}":a, f"d_{td}":d}))

# ── 3. starbase alone (level -> CV curve, and the annihilation shortcut) ────
for lvl in range(0,21):
    for a in (10,100,1000):
        add("3-sb-alone", "starbase level->CV, no defending fleet", C(a_de=a, d_sb=lvl))
for lvl in [round(x*0.25,2) for x in range(0,17)]:
    add("3-sb-frac", "fractional starbase level", C(a_de=100, d_sb=lvl))

# ── 4. starbase ALONGSIDE a fleet — flagged known-approximate in the docs ───
for lvl in (0,3,6,9,12,15):
    for dfleet in ({"d_de":50}, {"d_cr":20}, {"d_bs":10}):
        for afleet in ({"a_de":100}, {"a_de":1000}, {"a_bs":50}):
            add("4-sb-plus-fleet", "starbase + fleet (known-approximate)",
                C(d_sb=lvl, **dfleet, **afleet))

# ── 5. physics: full 0..12 difference grid across the +/-6 bracket ─────────
for ap in range(0,13):
    for dp in range(0,13):
        add("5-phys-grid", "physics bracket, both sides 0-12", C(a_de=1000, d_de=1000, a_ph=ap, d_ph=dp))
for v in range(0,101,10):
    add("5-phys-hi-att", "physics far above the bracket, attacker", C(a_de=1000, d_de=1000, a_ph=v))
    add("5-phys-hi-def", "physics far above the bracket, defender", C(a_de=1000, d_de=1000, d_ph=v))

# ── 6. mathematics: same grid — drives SURVIVORS, currently 0 fixtures ─────
for am in range(0,13):
    for dm in range(0,13):
        add("6-math-grid", "mathematics bracket, both sides 0-12", C(a_de=1000, d_de=1000, a_ma=am, d_ma=dm))
for v in range(0,101,10):
    add("6-math-hi-att", "mathematics far above the bracket, attacker", C(a_de=1000, d_de=1000, a_ma=v))
    add("6-math-hi-def", "mathematics far above the bracket, defender", C(a_de=1000, d_de=1000, d_ma=v))

# ── 7. RACE ATTACK 9x9 — 8%/point since 6.0.0-beta; model still fit at 7% ──
for ra in range(-4,5):
    for rd in range(-4,5):
        add("7-raceatk-1v1", "race attack grid @ equal force", C(a_de=1000, d_de=1000, a_ra=ra, d_ra=rd))
        add("7-raceatk-2v1", "race attack grid @ 2:1 force",   C(a_de=1000, d_de=500,  a_ra=ra, d_ra=rd))

# ── 8. RACE DEFENCE 9x9 — 12%/point since 6.0.0-beta; survivors only ───────
for ra in range(-4,5):
    for rd in range(-4,5):
        add("8-racedef-1v1", "race defence grid @ equal force", C(a_de=1000, d_de=1000, a_rd=ra, d_rd=rd))
for rd in range(-4,5):
    for mix in ({"a_bs":50,"d_bs":50}, {"a_cr":100,"d_cr":100}, {"a_de":1000,"d_bs":50}):
        add("8-racedef-mix", "race defence across ship types", C(a_rd=rd, **mix))
        add("8-racedef-mix", "race defence across ship types", C(d_rd=rd, **mix))

# ── 9. race attack x race defence on the same side (interaction) ───────────
for ra in range(-4,5):
    for rd in range(-4,5):
        add("9-race-interaction", "attack x defence picks, same side", C(a_bs=50, d_bs=50, a_ra=ra, a_rd=rd))

# ── 10. player level 0..200 ────────────────────────────────────────────────
for v in range(0,201,10):
    add("10-plevel-att", "player level, attacker", C(a_de=1000, d_de=1000, a_pl=v))
    add("10-plevel-def", "player level, defender", C(a_de=1000, d_de=1000, d_pl=v))
for a in (0,40,80,120,160,200):
    for d in (0,40,80,120,160,200):
        add("10-plevel-grid", "player level grid", C(a_de=1000, d_de=1000, a_pl=a, d_pl=d))

# ── 11. allied flag, matched on/off pairs ──────────────────────────────────
random.seed(1001)
for _ in range(40):
    base = C(a_de=random.choice([10,50,100,300,1000]), a_cr=random.choice([0,5,20]),
             a_bs=random.choice([0,3,15]),  d_de=random.choice([10,50,100,300,1000]),
             d_cr=random.choice([0,5,20]),  d_bs=random.choice([0,3,15]),
             d_sb=random.choice([0,4,9]))
    off = dict(base); off["allied"] = False
    on  = dict(base); on["allied"]  = True
    add("11-allied-off", "allied flag A/B pair", off)
    add("11-allied-on",  "allied flag A/B pair", on)

# ── 12. randomised full-space fleets: fit + hold-out validation ────────────
random.seed(42)
for _ in range(220):
    add("12-random", "full-space random sample", C(
        a_de=random.choice([0,1,5,17,50,123,400,999]),
        a_cr=random.choice([0,1,4,13,40,111]),
        a_bs=random.choice([0,1,3,9,27,80]),
        d_de=random.choice([0,1,5,17,50,123,400,999]),
        d_cr=random.choice([0,1,4,13,40,111]),
        d_bs=random.choice([0,1,3,9,27,80]),
        d_sb=random.choice([0,0,2,7,11,15]),
        a_ph=random.randint(0,40), a_ma=random.randint(0,40), a_pl=random.randint(0,200),
        d_ph=random.randint(0,40), d_ma=random.randint(0,40), d_pl=random.randint(0,200),
        a_ra=random.randint(-4,4), a_rd=random.randint(-4,4),
        d_ra=random.randint(-4,4), d_rd=random.randint(-4,4),
        allied=random.random() < 0.25))

# ── 13. edge cases and CV boundary probes ──────────────────────────────────
for c, why in [
    (C(), "empty vs empty"),
    (C(a_de=1), "1 ship vs nothing"), (C(d_de=1), "nothing vs 1 ship"),
    (C(a_de=1,d_de=1), "1v1 destroyer"), (C(a_cr=1,d_cr=1), "1v1 cruiser"),
    (C(a_bs=1,d_bs=1), "1v1 battleship"),
    (C(a_de=1,d_bs=1), "1 destroyer vs 1 battleship"),
    (C(a_bs=1,d_de=1), "1 battleship vs 1 destroyer"),
    (C(a_de=3,d_de=3), "<4 ships: winner can still lose everything"),
    (C(a_de=2,d_de=1), "<4 ships asymmetric"),
    (C(a_de=7,d_cr=1), "CV 24 boundary, below"), (C(a_de=8,d_cr=1), "CV 24 boundary, exact"),
    (C(a_de=9,d_cr=1), "CV 24 boundary, above"),
    (C(a_de=19,d_bs=1), "CV 60 boundary, below"), (C(a_de=20,d_bs=1), "CV 60 boundary, exact"),
    (C(a_de=21,d_bs=1), "CV 60 boundary, above"),
    (C(a_cr=2,d_bs=1), "cruiser/battleship CV boundary"),
    (C(a_cr=3,d_bs=1), "cruiser/battleship CV boundary"),
    (C(a_de=1000,d_cr=125), "documented 72.66% reference case"),
    (C(a_cr=125,d_de=1000), "documented reference case, swapped"),
    (C(a_de=1000,d_de=1500), "1.5x force deficit"),
    (C(a_de=1000,d_de=1500,a_ph=6), "can stats overturn 1.5x?"),
    (C(a_de=1000,d_de=1500,a_ra=4), "can race attack overturn 1.5x?"),
    (C(a_de=1000,d_cr=188), "1.5x deficit, mixed types"),
    (C(a_de=1000000), "overflow probe, attacker"),
    (C(a_de=1000000,d_de=1000000), "overflow probe, both"),
    (C(a_de=100,d_de=100,a_ph=100,a_ma=100,a_pl=200,a_ra=4,a_rd=4), "attacker maxed"),
    (C(a_de=100,d_de=100,d_ph=100,d_ma=100,d_pl=200,d_ra=4,d_rd=4), "defender maxed"),
    (C(a_de=100,d_de=100,a_ra=4,d_ra=-4), "race attack, max spread"),
    (C(a_de=100,d_de=100,a_rd=4,d_rd=-4), "race defence, max spread"),
    (C(a_de=100,d_de=100,a_ph=100,d_ph=100), "physics maxed, equal"),
    (C(a_de=100,d_de=100,a_ma=100,d_ma=100), "mathematics maxed, equal"),
    (C(a_de=100,d_de=100,a_pl=200,d_pl=200), "player level maxed, equal"),
    (C(d_sb=20), "starbase 20 vs nothing"),
    (C(a_de=1,d_sb=20), "1 destroyer vs starbase 20"),
    (C(a_de=1,d_sb=0.01), "smallest fractional starbase"),
    (C(a_de=1,a_cr=1,a_bs=1,d_de=1,d_cr=1,d_bs=1,d_sb=1), "one of everything"),
    (C(a_de=100,d_de=100,allied=True), "allied, equal"),
]:
    add("13-edge", why, c)

if __name__ == "__main__":
    from collections import Counter
    print("TOTAL:", len(cases))
    for k,v in sorted(Counter(b for b,_,_ in cases).items()): print(f"  {k:22s} {v}")
    seen = {json.dumps(c, sort_keys=True) for _,_,c in cases}
    print("unique input rows:", len(seen))
