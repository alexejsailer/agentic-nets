#!/usr/bin/env bash
# net-inspect.sh <modelId> [sessionId] [netId]
#   No sessionId : show every transition in the model (id, status, ready/firing, error, schedule).
#   + sessionId  : also list the designtime nets in that session.
#   + netId      : also export that net and summarise places (with live token counts) + transitions + arcs.
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

MODEL="${1:-${AGENTICOS_MODEL:-}}"; SESSION="${2:-}"; NET="${3:-}"
[ -n "$MODEL" ] || { echo "usage: net-inspect.sh <modelId> [sessionId] [netId]"; exit 2; }

echo "== transitions in model '$MODEL' =="
anos_master GET "/api/models/${MODEL}/execution/status" | python3 -c '
import sys,json
try: d=json.load(sys.stdin)
except Exception as e: print("  (could not read execution status:",e,")"); sys.exit(0)
ts=d.get("transitions",[]) if isinstance(d,dict) else []
if not ts: print("  (none)"); sys.exit(0)
print("  %-38s %-9s %-3s %-4s %s" % ("transition","status","rdy","fire","error"))
for t in sorted(ts,key=lambda x:x.get("transitionId","")):
    sch=t.get("schedule") or {}
    tag=("  every %ss"%(sch.get("intervalMs",0)//1000)) if sch.get("type")=="interval" else ""
    print("  %-38s %-9s %-3s %-4s %s%s" % (str(t.get("transitionId","?"))[:38], str(t.get("status"))[:9], str(t.get("ready"))[:3], str(t.get("firing"))[:4], str(t.get("error") or "")[:40], tag))
'

[ -n "$SESSION" ] || { echo; echo "(pass a sessionId to list its nets; + a netId to expand a net)"; exit 0; }

echo; echo "== designtime nets in session '$SESSION' =="
anos_master GET "/api/designtime/nets?modelId=${MODEL}&sessionId=${SESSION}" | python3 -c '
import sys,json
d=json.load(sys.stdin); nets=d.get("nets",{})
ids=list(nets.keys()) if isinstance(nets,dict) else [n.get("netId",n.get("id")) for n in nets]
print("  totalNets:",d.get("totalNets",len(ids)))
for i in ids: print("   -",i)
'

[ -n "$NET" ] || exit 0

echo; echo "== net '$NET' structure =="
EXPORT="$(anos_master GET "/api/designtime/nets/${NET}/export?modelId=${MODEL}&sessionId=${SESSION}")"
echo "$EXPORT" | python3 -c '
import sys,json
d=json.load(sys.stdin); net=d.get("net",d)
P=net.get("places",{}); T=net.get("transitions",{}); A=net.get("arcs",{})
print(f"  places={len(P)} transitions={len(T)} arcs={len(A)}")
print("  PLACES:", ", ".join(sorted(P.keys()))[:1000])
print("  TRANSITIONS:", ", ".join(sorted(T.keys()))[:1000])
' 2>/dev/null || echo "  (export unavailable)"

# live token counts per place (best-effort; capped for large nets)
echo; echo "== live token counts (top places) =="
echo "$EXPORT" | python3 -c '
import sys,json
d=json.load(sys.stdin); net=d.get("net",d)
print("\n".join(list(net.get("places",{}).keys())))
' 2>/dev/null | head -60 | while read -r p; do
  [ -n "$p" ] || continue
  c="$(anos_master GET "/api/runtime/places/${p}/tokens?modelId=${MODEL}&size=400" 2>/dev/null | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); t=d.get("tokens",d) if isinstance(d,dict) else d; print(len(t) if isinstance(t,list) else 0)
except: print("?")' 2>/dev/null)"
  [ "${c:-0}" != "0" ] && printf '  %-40s %s\n' "$p" "$c"
done
echo "  (places with 0 tokens omitted)"
