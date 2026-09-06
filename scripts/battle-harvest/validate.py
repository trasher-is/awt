import json, math, sys
sys.path.insert(0, '.')
import model

rows = [json.loads(l) for l in open('results.jsonl')]

def F(v):
    try: return float(v)
    except: return None

def build_sides(i):
    atk = {'fleet': [i['a_de'], i['a_cr'], i['a_bs']],
           'physics': i['a_ph'], 'mathematics': i['a_ma'],
           'raceAttack': i['a_ra'], 'raceDefense': i['a_rd']}
    dfn = {'fleet': [i['d_de'], i['d_cr'], i['d_bs']], 'starbase': i['d_sb'],
           'physics': i['d_ph'], 'mathematics': i['d_ma'],
           'raceAttack': i['d_ra'], 'raceDefense': i['d_rd']}
    return atk, dfn

win_errs = []
surv_errs = []   # (abs error in ships, as fraction of fleet size where possible)
per_block_win = {}
per_block_surv = {}
worst_win = []
worst_surv = []

for r in rows:
    i, o = r['in'], r['out']
    atk, dfn = build_sides(i)
    pred_win = model.win_pct(atk, dfn)
    actual_win = F(o['a_win'])
    e = abs(pred_win - actual_win)
    win_errs.append(e)
    per_block_win.setdefault(r['block'], []).append(e)
    worst_win.append((e, r['i'], i, actual_win, pred_win))

    aSurvP, dSurvP = model.survivors(atk, dfn, win=pred_win)
    actualA = [F(o['a_de_surv']), F(o['a_cr_surv']), F(o['a_bs_surv'])]
    actualD = [F(o['d_de_surv']), F(o['d_cr_surv']), F(o['d_bs_surv'])]
    for pv, av, cnt in list(zip(aSurvP, actualA, atk['fleet'])) + list(zip(dSurvP, actualD, dfn['fleet'])):
        if cnt == 0 or av is None: continue
        err = abs(pv - av)
        surv_errs.append(err)
        per_block_surv.setdefault(r['block'], []).append(err)
        if err > 0.5:
            worst_surv.append((err, r['i'], i, av, pv))

win_errs.sort()
surv_errs.sort()
worst_win.sort(reverse=True)
worst_surv.sort(reverse=True)

def pct_within(errs, tol):
    return 100*sum(1 for e in errs if e <= tol)/len(errs)

print(f"=== WIN% : {len(win_errs)} observations ===")
print(f"mean err {sum(win_errs)/len(win_errs):.4f}pp | median {win_errs[len(win_errs)//2]:.4f}pp | max {win_errs[-1]:.4f}pp")
for tol in (0.1,0.5,1.0,2.0,5.0):
    print(f"  within {tol:4.1f}pp: {pct_within(win_errs,tol):6.2f}%")

print(f"\n=== SURVIVORS : {len(surv_errs)} nonzero-fleet observations ===")
print(f"mean err {sum(surv_errs)/len(surv_errs):.4f} ships | median {surv_errs[len(surv_errs)//2]:.4f} | max {surv_errs[-1]:.4f}")
for tol in (0.01,0.1,0.5,1.0,5.0):
    print(f"  within {tol:5.2f} ships: {pct_within(surv_errs,tol):6.2f}%")

print("\n=== worst win% misses ===")
for e,idx,i,act,pred in worst_win[:15]:
    print(f"  #{idx} err={e:6.2f}pp actual={act:6.2f} pred={pred:6.2f}  {[k for k,v in i.items() if v]}")

print("\n=== worst survivor misses (>0.5 ships) ===")
for e,idx,i,act,pred in worst_surv[:15]:
    print(f"  #{idx} err={e:6.2f} actual={act} pred={pred:.2f}  {[k for k,v in i.items() if v]}")

print("\n=== per-block mean win% error (worst 15 blocks) ===")
bl = sorted(((sum(v)/len(v), b, len(v)) for b,v in per_block_win.items()), reverse=True)
for m,b,n in bl[:15]: print(f"  {b:20s} mean={m:7.3f}pp  n={n}")
