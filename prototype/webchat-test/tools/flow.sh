# source this: provides send/verdict/lastseq/waitpr helpers (printf-safe)
S=${S:-$(mktemp -d /tmp/chcu.XXXX)}
E=$HOME/.claude/channels/webchat-test/events.jsonl
TK=$(cat $HOME/.claude/channels/webchat-test/token)
CONV=${CONV:-conv-r1012b}
verdict() { curl -s http://127.0.0.1:8790/api/verdict -H "Authorization: Bearer $TK" -H 'content-type: application/json' -H 'x-client-id: verifier-curl' -d "{\"request_id\":\"$1\",\"behavior\":\"$2\"}"; printf ' [%s %s at %s]\n' "$2" "$1" "$(date +%T)"; }
send() { python3 -I -c "import json,sys;print(json.dumps({'conv_id':'$CONV','msg_id':sys.argv[1],'text':sys.argv[2]},ensure_ascii=False))" "$1" "$2" > $S/send.json; curl -s http://127.0.0.1:8790/api/send -H "Authorization: Bearer $TK" -H 'content-type: application/json' -H 'x-client-id: verifier-curl' --data-binary @$S/send.json; printf ' [sent %s at %s]\n' "$1" "$(date +%T)"; }
lastseq() { tail -1 $E | python3 -I -c 'import sys,json;print(json.loads(sys.stdin.read())["seq"])'; }
# waitpr <after_seq> <kind> [timeout] -> writes event json to $S/last_event.json, prints summary
waitpr() { python3 -I $S/tools/waitpr.py $E $1 $2 ${3:-120} > $S/last_event.json; python3 -I -c "
import json
try:
    e=json.load(open('$S/last_event.json'))
    print(e['seq'],e['ts'],e['kind'],e.get('request_id',''),e.get('tool_name',''),(e.get('text') or e.get('input_preview') or '')[:${4:-300}].replace(chr(10),' / '))
except Exception as ex: print('TIMEOUT/parse error', ex)
"; }
ev_field() { python3 -I -c "import json;print(json.load(open('$S/last_event.json')).get('$1',''))"; }
# allow_reply <after_seq>: wait for next permission_request, allow it, wait for assistant_reply
allow_reply() { waitpr $1 permission_request ${2:-150} 200; RID=$(ev_field request_id); SEQ=$(ev_field seq); [ -n "$RID" ] && verdict $RID allow && waitpr $SEQ assistant_reply 60 ${3:-400}; }
