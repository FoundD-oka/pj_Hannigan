import json, sys
# transcript jsonl -> compact tool trace (USER_TEXT / TOOL_USE / TOOL_RESULT / ASSISTANT_TEXT)
for line in open(sys.argv[1], encoding='utf-8'):
    try: o = json.loads(line)
    except: continue
    ts = o.get('timestamp', '')
    m = o.get('message') or {}
    c = m.get('content')
    if isinstance(c, str):
        if o.get('type') == 'user': print(ts, 'USER_TEXT', c[:300].replace('\n', ' '))
        continue
    if not isinstance(c, list): continue
    for b in c:
        t = b.get('type')
        if t == 'text' and o.get('type') == 'user': print(ts, 'USER_TEXT', b['text'][:300].replace('\n', ' '))
        elif t == 'text' and o.get('type') == 'assistant': print(ts, 'ASSISTANT_TEXT', b['text'][:300].replace('\n', ' '))
        elif t == 'tool_use': print(ts, 'TOOL_USE', b.get('name'), json.dumps(b.get('input'), ensure_ascii=False)[:400])
        elif t == 'tool_result':
            r = b.get('content')
            s = json.dumps(r, ensure_ascii=False) if not isinstance(r, str) else r
            print(ts, 'TOOL_RESULT', s[:400].replace('\n', ' '))
