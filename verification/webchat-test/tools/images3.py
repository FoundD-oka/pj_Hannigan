import json, sys, base64, os
# extract the LAST image of each computer_batch/screenshot tool_result that follows a `type` action, to crop later
src, outdir, prefix = sys.argv[1:4]
names = {}; n = 0
for line in open(src, encoding='utf-8'):
    try: o = json.loads(line)
    except: continue
    c = (o.get('message') or {}).get('content')
    if not isinstance(c, list): continue
    for b in c:
        if b.get('type') == 'tool_use': names[b['id']] = (b.get('name'), json.dumps(b.get('input'), ensure_ascii=False))
        if b.get('type') == 'tool_result':
            name, inp = names.get(b.get('tool_use_id'), ('?', ''))
            if name != 'mcp__computer-use__computer_batch' or '"type"' not in inp: continue
            imgs = [p for p in (b.get('content') or []) if isinstance(p, dict) and p.get('type') == 'image']
            if not imgs: continue
            n += 1
            typed = [a.get('text') for a in json.loads(inp)['actions'] if a.get('action') == 'type']
            p = os.path.join(outdir, f"{prefix}-after-type-{n:02d}.jpg")
            open(p, 'wb').write(base64.b64decode(imgs[-1]['source']['data']))
            print(o['timestamp'], os.path.basename(p), typed)
