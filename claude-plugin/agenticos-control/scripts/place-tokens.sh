#!/usr/bin/env bash
# place-tokens.sh <get|count|post|delete> <modelId> <place> [jsonData | tokenId]
#   get    <model> <place>                 read tokens (size 400)
#   count  <model> <place>                 just the count
#   post   <model> <place> '<jsonData>'    create a token {name:auto, data:<jsonData>}
#   delete <model> <place> <tokenId>       delete one token
# Token surgery (delete) is a WRITE; double-check the place/id first.
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

OP="${1:-}"; MODEL="${2:-${AGENTICOS_MODEL:-}}"; PLACE="${3:-}"; ARG="${4:-}"
[ -n "$OP" ] && [ -n "$MODEL" ] && [ -n "$PLACE" ] || {
  echo "usage: place-tokens.sh <get|count|post|delete> <modelId> <place> [jsonData|tokenId]"; exit 2; }

case "$OP" in
  get)
    anos_master GET "/api/runtime/places/${PLACE}/tokens?modelId=${MODEL}&size=400" \
      | python3 -m json.tool 2>/dev/null || echo "(no tokens / unreadable)"
    ;;
  count)
    anos_master GET "/api/runtime/places/${PLACE}/tokens?modelId=${MODEL}&size=400" \
      | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); t=d.get("tokens",d) if isinstance(d,dict) else d; print(len(t) if isinstance(t,list) else 0)
except: print("?")'
    ;;
  post)
    [ -n "$ARG" ] || { echo "post needs a JSON data payload"; exit 2; }
    BODY="$(python3 -c 'import sys,json,time
data=sys.argv[1]
try: data=json.loads(data)
except Exception: pass
print(json.dumps({"name":"anos-%d"%int(time.time()*1000),"data":data}))' "$ARG")"
    anos_master POST "/api/runtime/places/${PLACE}/tokens?modelId=${MODEL}" "$BODY" | python3 -m json.tool 2>/dev/null || echo "(post failed)"
    ;;
  delete)
    [ -n "$ARG" ] || { echo "delete needs a tokenId"; exit 2; }
    anos_master DELETE "/api/runtime/places/${PLACE}/tokens/${ARG}?modelId=${MODEL}" ; echo "(deleted ${ARG})"
    ;;
  *) echo "unknown op: $OP"; exit 2 ;;
esac
