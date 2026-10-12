import json, sys, time
# waitpr.py <events.jsonl> <after_seq> <kind> [timeout]  -> prints the first matching event (json) after seq
path, after, kind = sys.argv[1], int(sys.argv[2]), sys.argv[3]
timeout = float(sys.argv[4]) if len(sys.argv) > 4 else 90
t0 = time.time()
while time.time() - t0 < timeout:
    for line in open(path, encoding='utf-8'):
        try: e = json.loads(line)
        except: continue
        if e['seq'] > after and e['kind'] == kind:
            print(json.dumps(e, ensure_ascii=False)); sys.exit(0)
    time.sleep(1.5)
print('TIMEOUT'); sys.exit(1)
