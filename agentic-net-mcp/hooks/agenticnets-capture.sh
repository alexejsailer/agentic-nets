#!/usr/bin/env bash
# agenticnets-capture.sh — Claude Code SessionEnd hook.
# Distills the ended session into ONE raw capture token in p-mem-inbox
# (first user ask + last assistant outcome + cwd/branch). The working-memory
# distiller turns it into a durable note on its next tick. Zero LLM here.
#
# FAIL-OPEN: any error exits 0 silently. Bounded curls. Never blocks exit.
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

# Hook stdin: {"transcript_path": "...", "cwd": "...", ...}
# Read it into a variable FIRST — `python3 -` takes its program from stdin, so
# the hook payload must travel via the environment, not the exhausted pipe.
HOOK_JSON="$(cat 2>/dev/null || true)"
[ -z "$HOOK_JSON" ] && exit 0
export HOOK_JSON

PAYLOAD="$(python3 - <<'PYEOF' 2>/dev/null
import json, os, sys

try:
    hook = json.loads(os.environ["HOOK_JSON"])
except Exception:
    sys.exit(1)

transcript = hook.get("transcript_path") or ""
cwd = hook.get("cwd") or ""
first_user, last_assistant = "", ""

def text_of(message):
    content = (message or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""

try:
    with open(transcript, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except Exception:
                continue
            kind = entry.get("type")
            if kind == "user" and not first_user:
                t = text_of(entry.get("message"))
                # Skip harness noise (command wrappers, tool results)
                if t and not t.startswith("<"):
                    first_user = t
            elif kind == "assistant":
                t = text_of(entry.get("message"))
                if t:
                    last_assistant = t
except Exception:
    pass

if not first_user and not last_assistant:
    sys.exit(1)

branch = ""
try:
    import subprocess
    branch = subprocess.run(
        ["git", "-C", cwd or ".", "branch", "--show-current"],
        capture_output=True, text=True, timeout=2,
    ).stdout.strip()
except Exception:
    pass

where = cwd + (f" ({branch})" if branch else "")
text = (
    f"Claude Code session in {where}. "
    f"Asked: {first_user[:700]} "
    f"Outcome: {last_assistant[:900]}"
)
# The master TokenCreateRequest DTO wraps the properties under "data".
print(json.dumps({"data": {"kind": "memory", "text": text, "source": "cc-hook", "tags": "[\"cc-session\"]"}}))
PYEOF
)" || exit 0
[ -z "$PAYLOAD" ] && exit 0

TOKEN="$(curl -sf -m 3 -X POST "$GATEWAY/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=agenticos-admin' \
  --data-urlencode "client_secret=$SECRET" 2>/dev/null |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' 2>/dev/null)" || exit 0
[ -z "$TOKEN" ] && exit 0

curl -sf -m 4 -X POST "$GATEWAY/api/runtime/places/p-mem-inbox/tokens?modelId=$MODEL" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1 || true
exit 0
