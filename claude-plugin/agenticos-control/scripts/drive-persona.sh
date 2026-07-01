#!/usr/bin/env bash
# drive-persona.sh <persona> <modelId> "<prompt>" [sessionId]
#   persona: 'universal' (the Universal Assistant), 'genesis', 'operator', 'builder', or any personaId.
#   Drives the persona's agent loop and streams its reply. Prefers the `agenticos` CLI when present
#   (nicer streaming); otherwise consumes the master's SSE agent-stream via curl.
set -uo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$SD/anos.sh"

PERSONA="${1:-}"; MODEL="${2:-${AGENTICOS_MODEL:-}}"; PROMPT="${3:-}"; SESSION="${4:-${AGENTICOS_SESSION:-}}"
[ -n "$PERSONA" ] && [ -n "$MODEL" ] && [ -n "$PROMPT" ] || {
  echo 'usage: drive-persona.sh <universal|genesis|operator|builder|personaId> <modelId> "<prompt>" [sessionId]'; exit 2; }

# CLI-first: use `agenticos persona` if the binary is present (best-effort; falls through to curl on error).
if _anos_have_cli; then
  if anos_cli persona "$PERSONA" --model "$MODEL" ${SESSION:+--session "$SESSION"} "$PROMPT" 2>/dev/null; then exit 0; fi
  _anos_dbg "CLI persona path unavailable; falling back to curl SSE"
fi

# curl SSE fallback
if [ "$PERSONA" = universal ]; then BASE="/api/assistant/universal/${MODEL}"; else BASE="/api/assistant/p/${PERSONA}/${MODEL}"; fi

START="$(anos_master POST "${BASE}/chat/start${SESSION:+?sessionId=$SESSION}" '{}')"
CONV="$(printf '%s' "$START" | sed -n 's/.*"conversationId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$CONV" ] || { echo "could not start a conversation with persona '$PERSONA' on '$MODEL':"; echo "$START" | head -c 300; exit 1; }
echo "(conversation $CONV; streaming ...)"

ENCPROMPT="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$PROMPT")"
# resolve auth for a raw streaming curl (anos_master is request/response; SSE needs -N)
AUTHHDR=(); if [ "$(_anos_auth)" = gateway ]; then TOK="$(_anos_token)" || exit 1; AUTHHDR=(-H "Authorization: Bearer ${TOK}"); BASEURL="$ANOS_GATEWAY"; else BASEURL="$ANOS_MASTER"; fi

curl -sN --max-time 300 "${AUTHHDR[@]}" -H 'Accept: text/event-stream' \
  "${BASEURL}${BASE}/chat/${CONV}/agent-stream?message=${ENCPROMPT}" | python3 -c '
import sys,json
for line in sys.stdin:
    line=line.rstrip("\n")
    if not line.startswith("data:"): continue
    payload=line[5:].strip()
    if not payload or payload=="[DONE]": continue
    try: ev=json.loads(payload)
    except Exception: print(payload); continue
    t=ev.get("type","")
    if t in ("text","token","message"): sys.stdout.write(ev.get("text") or ev.get("content") or ev.get("delta") or ""); sys.stdout.flush()
    elif t=="thinking": pass
    elif t=="tool_call": print("\n  [tool] %s %s"%(ev.get("tool",ev.get("name","")), json.dumps(ev.get("args",ev.get("input",{})))[:120]))
    elif t=="tool_result": print("  [result] %s"%(json.dumps(ev.get("result",ev.get("output","")))[:120]))
    elif t in ("completion","done","error"):
        if ev.get("text") or ev.get("message"): print("\n"+(ev.get("text") or ev.get("message")))
print()
' || { echo; echo "(SSE stream ended; if empty, the persona may need a live LLM provider configured on master)"; }
