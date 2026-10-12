import json, sys, base64, os
# extract ONLY images returned by computer-use `zoom` (region-limited) and name them by timestamp
src, outdir, prefix = sys.argv[1:4]
names = {}
n = 0
for line in open(src, encoding='utf-8'):
    try: o = json.loads(line)
    except: continue
    c = (o.get('message') or {}).get('content')
    if not isinstance(c, list): continue
    for b in c:
        if b.get('type') == 'tool_use': names[b['id']] = (b.get('name'), json.dumps(b.get('input'), ensure_ascii=False)[:120])
        if b.get('type') == 'tool_result':
            name, inp = names.get(b.get('tool_use_id'), ('?', ''))
            if name != 'mcp__computer-use__zoom': continue
            for part in (b.get('content') or []):
                if isinstance(part, dict) and part.get('type') == 'image':
                    n += 1
                    p = os.path.join(outdir, f"{prefix}-zoom-{n:02d}-{o['timestamp'].replace(':','').replace('-','')[:15]}.jpg")
                    open(p, 'wb').write(base64.b64decode(part['source']['data']))
                    print(o['timestamp'], os.path.basename(p), inp)
