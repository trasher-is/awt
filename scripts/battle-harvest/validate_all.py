import json, sys
sys.path.insert(0, '.')
import model

def F(v):
    try: return float(str(v).replace(',',''))
    except: return None

def build(i):
    atk={'fleet':[i['a_de'],i['a_cr'],i['a_bs']],'physics':i['a_ph'],'mathematics':i['a_ma'],
         'raceAttack':i['a_ra'],'raceDefense':i['a_rd'],'playerLevel':i.get('a_pl',0)}
    dfn={'fleet':[i['d_de'],i['d_cr'],i['d_bs']],'starbase':i['d_sb'],'physics':i['d_ph'],'mathematics':i['d_ma'],
         'raceAttack':i['d_ra'],'raceDefense':i['d_rd'],'playerLevel':i.get('d_pl',0)}
    return atk,dfn

for fname in ('results.jsonl', 'mixed_results.jsonl', 'pl_science_results.jsonl'):
    rows=[json.loads(l) for l in open(fname)]
    win_errs=[]
    surv_errs=[]
    perblock_w={}
    perblock_s={}
    for r in rows:
        i,o=r['in'],r['out']
        atk,dfn=build(i)
        pw=model.win_pct(atk,dfn)
        aw=F(o['a_win'])
        e=abs(pw-aw)
        win_errs.append(e)
        perblock_w.setdefault(r['block'],[]).append(e)

        aSurvP,dSurvP=model.survivors(atk,dfn,win=pw)
        actualA=[F(o.get('a_de_surv')),F(o.get('a_cr_surv')),F(o.get('a_bs_surv'))]
        actualD=[F(o.get('d_de_surv')),F(o.get('d_cr_surv')),F(o.get('d_bs_surv'))]
        for pv,av,cnt in list(zip(aSurvP,actualA,atk['fleet']))+list(zip(dSurvP,actualD,dfn['fleet'])):
            if cnt==0 or av is None: continue
            se=abs(pv-av)
            surv_errs.append(se)
            perblock_s.setdefault(r['block'],[]).append(se)
    win_errs.sort(); surv_errs.sort()
    def pct_within(errs,tol): return 100*sum(1 for e in errs if e<=tol)/len(errs)
    print(f"=== {fname}: {len(win_errs)} rows, {len(surv_errs)} survivor obs ===")
    print(f"WIN%   mean {sum(win_errs)/len(win_errs):.4f}pp max {win_errs[-1]:.4f}pp  "
          f"within1pp={pct_within(win_errs,1):.2f}% within2pp={pct_within(win_errs,2):.2f}%")
    print(f"SURV   mean {sum(surv_errs)/len(surv_errs):.4f} max {surv_errs[-1]:.4f}  "
          f"within1={pct_within(surv_errs,1):.2f}% within5={pct_within(surv_errs,5):.2f}% within1pct-of-fleet=n/a")
    bl=sorted(((sum(v)/len(v),b,len(v)) for b,v in perblock_s.items()), reverse=True)
    print("worst survivor blocks:")
    for m,b,n in bl[:8]:
        print(f"  {b:28s} mean={m:9.3f} n={n}")
    print()
