#!/usr/bin/env bash
# forge-run.sh <modelId> "<intent>" [--poll-seconds N] [--max-polls M]
#   Starts a Forge (tool-builder persona) run: it designs/builds/smoke-tests a tool-net from a
#   natural-language intent. Enqueues the run, then polls the collapsed run feed to done/failed.
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

MODEL="${1:-${AGENTICOS_MODEL:-}}"; INTENT="${2:-}"; POLL=8; MAXP=60
shift 2 2>/dev/null || true
while [ $# -gt 0 ]; do case "$1" in --poll-seconds) POLL="$2"; shift 2;; --max-polls) MAXP="$2"; shift 2;; *) shift;; esac; done
[ -n "$MODEL" ] && [ -n "$INTENT" ] || { echo 'usage: forge-run.sh <modelId> "<intent>" [--poll-seconds N] [--max-polls M]'; exit 2; }

BODY="$(python3 -c 'import sys,json; print(json.dumps({"prompt":sys.argv[1]}))' "$INTENT")"
echo "starting Forge run on '$MODEL' ..."
START="$(anos_master POST "/api/forge/${MODEL}/runs" "$BODY")"; echo "$START" | head -c 300; echo
REQ="$(printf '%s' "$START" | sed -n 's/.*"requestId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

for i in $(seq 1 "$MAXP"); do
  sleep "$POLL"
  FEED="$(anos_master GET "/api/forge/${MODEL}/runs")"
  ST="$(printf '%s' "$FEED" | python3 -c '
import sys,json
req=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: print("unknown"); sys.exit(0)
runs=d if isinstance(d,list) else d.get("runs",[d])
r=None
for x in (runs if isinstance(runs,list) else [runs]):
    if not req or x.get("requestId")==req: r=x
if not r and runs: r=runs[-1] if isinstance(runs,list) else runs
print((r or {}).get("status","unknown"))
' "$REQ")"
  echo "  [poll $i] status=$ST"
  case "$ST" in
    done|failed|error|cancelled) echo "== final =="; printf '%s' "$FEED" | python3 -m json.tool 2>/dev/null | tail -40 || printf '%s' "$FEED"; exit 0 ;;
  esac
done
echo "(still running after $MAXP polls; check later with: anos.sh master GET /api/forge/${MODEL}/runs)"
