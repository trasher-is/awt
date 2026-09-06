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

for fname in ('results.jsonl', 'mixed_results.jsonl'):
    rows=[json.loads(l) for l in open(fname)]
    win_errs=[]
    perblock={}
    for r in rows:
        i,o=r['in'],r['out']
        atk,dfn=build(i)
        pw=model.win_pct(atk,dfn)
        aw=F(o['a_win'])
        e=abs(pw-aw)
        win_errs.append(e)
        perblock.setdefault(r['block'],[]).append(e)
    win_errs.sort()
    def pct_within(errs,tol): return 100*sum(1 for e in errs if e<=tol)/len(errs)
    print(f"=== {fname}: {len(win_errs)} rows ===")
    print(f"mean {sum(win_errs)/len(win_errs):.4f}pp median {win_errs[len(win_errs)//2]:.4f}pp max {win_errs[-1]:.4f}pp")
    for tol in (0.1,0.5,1,2,5):
        print(f"  within {tol:4.1f}pp: {pct_within(win_errs,tol):6.2f}%")
    print("worst blocks:")
    bl=sorted(((sum(v)/len(v),b,len(v)) for b,v in perblock.items()), reverse=True)
    for m,b,n in bl[:10]:
        print(f"  {b:28s} mean={m:7.3f}pp n={n}")
    print()
