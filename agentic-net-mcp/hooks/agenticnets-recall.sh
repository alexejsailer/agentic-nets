#!/usr/bin/env bash
# agenticnets-recall.sh — Claude Code SessionStart hook.
# Pulls the newest decisions + notes from Agentic-Nets working memory and
# injects them as additionalContext, so every session starts warm.
#
# FAIL-OPEN BY DESIGN: any error, timeout, or missing config exits 0 silently —
# a memory hiccup must never block a coding session. All curls are bounded.
#
# Config: ~/.agenticnets/hooks.env (or $AGENTICNETS_HOOK_ENV) with:
#   AGENTICOS_GATEWAY_URL=http://localhost:8083
#   AGENTICOS_ADMIN_SECRET=...            # or AGENTICOS_GATEWAY_SECRET_FILE=...
#   AGENTICOS_MEMORY_MODEL=claude-memory
set -u
ENV_FILE="${AGENTICNETS_HOOK_ENV:-$HOME/.agenticnets/hooks.env}"
[ -f "$ENV_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$ENV_FILE" 2>/dev/null || exit 0

GATEWAY="${AGENTICOS_GATEWAY_URL:-http://localhost:8083}"
MODEL="${AGENTICOS_MEMORY_MODEL:-claude-memory}"
SECRET="${AGENTICOS_ADMIN_SECRET:-}"
[ -z "$SECRET" ] && [ -n "${AGENTICOS_GATEWAY_SECRET_FILE:-}" ] && SECRET="$(cat "$AGENTICOS_GATEWAY_SECRET_FILE" 2>/dev/null || true)"
[ -z "$SECRET" ] && exit 0

TOKEN="$(curl -sf -m 3 -X POST "$GATEWAY/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=agenticos-admin' \
  --data-urlencode "client_secret=$SECRET" 2>/dev/null |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' 2>/dev/null)" || exit 0
[ -z "$TOKEN" ] && exit 0

fetch_place() {
  curl -sf -m 3 -H "Authorization: Bearer $TOKEN" \
    "$GATEWAY/api/runtime/places/$1/tokens?modelId=$MODEL&size=25" 2>/dev/null
}

DECISIONS_RAW="$(fetch_place p-mem-decisions)" || true
NOTES_RAW="$(fetch_place p-mem-notes)" || true
export DECISIONS_RAW NOTES_RAW

python3 - "$MODEL" <<'PYEOF' 2>/dev/null || exit 0
import json, os, sys

model = sys.argv[1]

def entries(raw, place, limit):
    try:
        data = json.loads(raw or "null") or {}
    except Exception:
        return []
    toks = data.get("tokens") or data.get("results") or []
    out = []
    for t in toks:
        p = t.get("properties") or t.get("data") or {}
        text = p.get("text") or p.get("summary") or p.get("title") or ""
        if not text:
            continue
        out.append((p.get("createdAt") or "", str(text)[:300], place))
    out.sort(reverse=True)
    return out[:limit]

decisions = entries(os.environ.get("DECISIONS_RAW", ""), "decision", 5)
notes = entries(os.environ.get("NOTES_RAW", ""), "note", 5)
items = decisions + notes
if not items:
    sys.exit(0)

lines = [f"Working memory (Agentic-Nets model '{model}' — recall more with the agenticnets MCP tools):"]
for created, text, place in items:
    stamp = created[:10] if created else ""
    lines.append(f"- [{place} {stamp}] {text}")

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n".join(lines),
    }
}))
PYEOF
exit 0
