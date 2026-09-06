import json, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aw import Client, parse
from cases import cases

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results.jsonl")
done = set()
if os.path.exists(OUT):
    for line in open(OUT):
        try: done.add(json.loads(line)["i"])
        except Exception: pass

cl = Client()
t0 = time.time(); fails = 0
with open(OUT, "a") as f:
    for i, (block, purpose, c) in enumerate(cases):
        if i in done: continue
        try:
            out = parse(cl.post(c))
        except Exception as e:
            fails += 1
            print(f"FAIL {i}: {e}", flush=True)
            if fails > 40: sys.exit("too many failures, aborting")
            continue
        f.write(json.dumps({"i": i, "block": block, "purpose": purpose, "in": c, "out": out}) + "\n")
        if i % 100 == 0:
            f.flush()
            el = time.time() - t0
            print(f"{i}/{len(cases)}  {el:6.1f}s  eta {el/max(i-min(done or {0}),1)*(len(cases)-i):6.0f}s", flush=True)
        time.sleep(0.05)
print(f"DONE in {time.time()-t0:.1f}s, failures={fails}", flush=True)
