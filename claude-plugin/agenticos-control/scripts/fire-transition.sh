#!/usr/bin/env bash
# fire-transition.sh <modelId> <transitionId> [--no-restart]
#   Manually fires a transition once. fireOnce returns 409 while a transition is RUNNING,
#   so this does STOP -> fireOnce -> START (restoring the running state unless --no-restart).
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

MODEL="${1:-${AGENTICOS_MODEL:-}}"; T="${2:-}"; RESTART=1
[ "${3:-}" = "--no-restart" ] && RESTART=0
[ -n "$MODEL" ] && [ -n "$T" ] || { echo "usage: fire-transition.sh <modelId> <transitionId> [--no-restart]"; exit 2; }
BODY="$(printf '{"modelId":"%s"}' "$MODEL")"

echo "stop  $T ..."; anos_master POST "/api/transitions/${T}/stop"     "$BODY" | head -c 200; echo
sleep 1
echo "fire  $T ..."; RES="$(anos_master POST "/api/transitions/${T}/fireOnce" "$BODY")"; echo "$RES" | head -c 400; echo
if printf '%s' "$RES" | grep -q '"success":false'; then
  echo "!! fireOnce reported failure. If it says 'running state', the STOP did not take effect yet -- retry."
fi
if [ "$RESTART" = 1 ]; then
  sleep 1; echo "start $T ..."; anos_master POST "/api/transitions/${T}/start" "$BODY" | head -c 200; echo
else
  echo "(left stopped; start it later with: anos.sh master POST /api/transitions/${T}/start '${BODY}')"
fi
