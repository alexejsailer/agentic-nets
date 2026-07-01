#!/usr/bin/env bash
# diagnose.sh <modelId> <transitionId>
#   Prints the transition's live execution state (status / ready / firing / error / schedule /
#   deployedAt) from the model execution status, plus recent event-line activity mentioning it.
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

MODEL="${1:-${AGENTICOS_MODEL:-}}"; T="${2:-}"
[ -n "$MODEL" ] && [ -n "$T" ] || { echo "usage: diagnose.sh <modelId> <transitionId>"; exit 2; }

echo "== execution state: $T =="
anos_master GET "/api/models/${MODEL}/execution/status" | python3 -c '
import sys,json
tid=sys.argv[1]
d=json.load(sys.stdin); ts=d.get("transitions",[]) if isinstance(d,dict) else []
hit=[t for t in ts if t.get("transitionId")==tid]
if not hit: print("  transition not found in model (id typo? wrong model?)"); sys.exit(0)
print(json.dumps(hit[0],indent=2))
' "$T"

echo; echo "== recent event-line entries mentioning $T =="
anos_master GET "/api/event-line/${MODEL}?limit=200" 2>/dev/null | python3 -c '
import sys,json
tid=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: print("  (event-line unavailable in this mode)"); sys.exit(0)
evs=d if isinstance(d,list) else d.get("events", d.get("entries", []))
hits=[e for e in evs if tid in json.dumps(e)][-12:]
if not hits: print("  (no recent events mention this transition)")
for e in hits:
    print("  ", json.dumps(e)[:200])
' "$T" || echo "  (event-line unavailable)"

echo; echo "tip: also try  anos.sh master POST /api/dryrun/transitions/${T} '{\"modelId\":\"${MODEL}\"}'  to dry-run its binding."
