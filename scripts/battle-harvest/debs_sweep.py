"""Dense destroyer-vs-battleship duel sweep, no modifiers, to characterize the
~1pp residual the CV/attack-value blend (P_CV_WEIGHT=0.813) shows specifically
for this ship pairing -- reweighting and adding a defense-ratio term both
failed to close it, so this collects a much denser set of ratios to see the
actual shape of the residual.
"""
FIELDS = ["a_de","a_cr","a_bs","d_de","d_cr","d_bs","d_sb",
          "a_ph","a_ma","a_pl","a_ra","a_rd",
          "d_ph","d_ma","d_pl","d_ra","d_rd","allied"]
def C(**kw):
    c = dict.fromkeys(FIELDS, 0); c["allied"] = False; c.update(kw); return c

cases = []
def add(block, purpose, c): cases.append((block, purpose, c))

# ratio = a_de(attacker) / bs(defender count), sweeping widely in both directions
RATIOS = [0.05,0.1,0.15,0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.625,0.65,0.667,
          0.7,0.75,0.8,0.833,0.9,0.95,1.0,1.05,1.1,1.15,1.2,1.25,1.3,1.35,1.4,
          1.45,1.5,1.6,1.7,1.8,1.9,2.0,2.5,3.0,4.0,5.0,7.5,10.0,15.0,20.0]
BS_BASE = 10000
for r in RATIOS:
    ade = round(BS_BASE * 60/3 * r)   # scale by CV ratio: 1bs=60cv=20de-equivalent-CV
    add("debs-atk-de", f"ratio={r}", C(a_de=ade, d_bs=BS_BASE))
    add("debs-def-de", f"ratio={r}", C(a_bs=BS_BASE, d_de=ade))

if __name__ == "__main__":
    print(len(cases))
