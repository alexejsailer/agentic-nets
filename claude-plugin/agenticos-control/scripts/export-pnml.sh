#!/usr/bin/env bash
# export-pnml.sh <modelId> <sessionId> <netId> [outPath] [--xml]
#   Default: designtime JSON export (places/transitions/arcs with x/y) -> <outPath or ./<netId>.net.json>
#   --xml  : PNML XML via /api/petrinet/{modelId}/{netId}/pnml     -> <outPath or ./<netId>.pnml>
# Output is written to the USER's path (cwd by default), never inside the plugin.
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

MODEL="${1:-}"; SESSION="${2:-}"; NET="${3:-}"; OUT="${4:-}"; FMT="json"
for a in "$@"; do [ "$a" = "--xml" ] && FMT="xml"; done
[ -n "$MODEL" ] && [ -n "$SESSION" ] && [ -n "$NET" ] || {
  echo "usage: export-pnml.sh <modelId> <sessionId> <netId> [outPath] [--xml]"; exit 2; }
[ "${OUT:-}" = "--xml" ] && OUT=""

if [ "$FMT" = xml ]; then
  [ -n "$OUT" ] || OUT="./${NET}.pnml"
  anos_master GET "/api/petrinet/${MODEL}/${NET}/pnml" > "$OUT"
else
  [ -n "$OUT" ] || OUT="./${NET}.net.json"
  anos_master GET "/api/designtime/nets/${NET}/export?modelId=${MODEL}&sessionId=${SESSION}" \
    | python3 -m json.tool > "$OUT" 2>/dev/null \
    || anos_master GET "/api/designtime/nets/${NET}/export?modelId=${MODEL}&sessionId=${SESSION}" > "$OUT"
fi

if [ -s "$OUT" ]; then
  echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, format=$FMT)"
  echo "tip: render the JSON export to a diagram with a small matplotlib/graphviz script (see references/diagram-export.md)."
else
  echo "export produced no output (check modelId/sessionId/netId and reachability with: anos.sh preflight)"; exit 1
fi
