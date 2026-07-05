#!/usr/bin/env bash
#
# Start the latest OpenCode wired to an AgenticNetOS backend + MCP.
#
# No fork, no branding — this just downloads/uses upstream OpenCode and drops in an
# opencode.json that registers the `agenticnets` MCP server (stdio) pointed at your
# gateway. OpenCode then has the full AgenticNetOS tool surface (query/build nets,
# tool-nets, hub, and invoke_agent to drive the platform agents) alongside its own
# coding tools.
#
# Usage:
#   AGENTICOS_MODELS=my-memory ./start.sh
#
# Config (env):
#   AGENTICOS_MODELS            REQUIRED. Model allowlist (comma-separated); first = default.
#   AGENTICOS_GATEWAY_URL       Gateway base URL. Default http://localhost:8083
#   AGENTICOS_ADMIN_SECRET      Gateway client secret (rw). Or use *_SECRET_FILE.
#   AGENTICOS_GATEWAY_SECRET_FILE  Path to the gateway admin-secret file (preferred; keeps
#                               the secret out of opencode.json). Auto-detected if unset.
#   AGENTICOS_MODE              rw | readonly. Default rw.
#   AGENTICOS_SESSION           Session name for MCP-created nets. Default opencode.
#   OPENCODE_MODEL              Optional. Set OpenCode's model, e.g. anthropic/claude-sonnet-5.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"   # agentic-nets/

# ---- config with defaults ----
: "${AGENTICOS_GATEWAY_URL:=http://localhost:8083}"
: "${AGENTICOS_MODE:=rw}"
: "${AGENTICOS_SESSION:=opencode}"
if [ -z "${AGENTICOS_MODELS:-}" ]; then
  echo "ERROR: set AGENTICOS_MODELS to your model allowlist, e.g. AGENTICOS_MODELS=my-memory" >&2
  exit 1
fi

# ---- locate a gateway secret (file preferred, keeps it out of the JSON) ----
secret_file="${AGENTICOS_GATEWAY_SECRET_FILE:-}"
if [ -z "$secret_file" ] && [ -z "${AGENTICOS_ADMIN_SECRET:-}" ]; then
  for candidate in \
    "$repo_root/agentic-net-gateway/data/jwt/admin-secret" \
    "$repo_root/deployment/data/gateway/jwt/admin-secret" \
    "$HOME/.agenticos/gateway/admin-secret"; do
    if [ -f "$candidate" ]; then secret_file="$candidate"; break; fi
  done
fi
if [ -z "$secret_file" ] && [ -z "${AGENTICOS_ADMIN_SECRET:-}" ]; then
  echo "ERROR: no gateway secret. Set AGENTICOS_ADMIN_SECRET or AGENTICOS_GATEWAY_SECRET_FILE," >&2
  echo "       or run from a repo where the gateway wrote data/jwt/admin-secret." >&2
  exit 1
fi

# ---- ensure OpenCode is installed ----
if ! command -v opencode >/dev/null 2>&1; then
  echo "==> OpenCode not found; installing the latest release from opencode.ai ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://opencode.ai/install | bash
  else
    echo "ERROR: curl is required to install OpenCode. Install OpenCode manually:" >&2
    echo "       https://opencode.ai/docs/  (or: npm i -g opencode-ai)" >&2
    exit 1
  fi
  # The installer typically drops the binary in ~/.opencode/bin or ~/.local/bin.
  export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
fi
command -v opencode >/dev/null 2>&1 || { echo "ERROR: opencode still not on PATH after install." >&2; exit 1; }
echo "==> OpenCode: $(command -v opencode)"

# ---- resolve the MCP launch command: local build if present, else npx ----
mcp_dir="$repo_root/agentic-net-mcp"
mcp_entry="$mcp_dir/dist/bin/agenticnets-mcp.js"
if [ -d "$mcp_dir" ]; then
  if [ ! -f "$mcp_entry" ]; then
    echo "==> Building the agenticnets MCP server (one-time) ..."
    ( cd "$mcp_dir" && npm install --silent && npx tsup )
  fi
  mcp_cmd_json="[\"node\", \"$mcp_entry\"]"
else
  # Standalone (script copied out of the repo): use the published package.
  mcp_cmd_json="[\"npx\", \"-y\", \"@agenticnets/mcp\"]"
fi

# ---- render opencode.json from the template ----
work="${OPENCODE_WORKDIR:-$PWD}"
out="$work/opencode.json"
tmpl="$here/opencode.template.json"

# Build the environment block (only include the secret vars that are set).
env_lines="        \"AGENTICOS_GATEWAY_URL\": \"$AGENTICOS_GATEWAY_URL\",
        \"AGENTICOS_MODELS\": \"$AGENTICOS_MODELS\",
        \"AGENTICOS_MODE\": \"$AGENTICOS_MODE\",
        \"AGENTICOS_SESSION\": \"$AGENTICOS_SESSION\""
if [ -n "${secret_file:-}" ]; then
  env_lines="$env_lines,
        \"AGENTICOS_GATEWAY_SECRET_FILE\": \"$secret_file\""
elif [ -n "${AGENTICOS_ADMIN_SECRET:-}" ]; then
  env_lines="$env_lines,
        \"AGENTICOS_ADMIN_SECRET\": \"$AGENTICOS_ADMIN_SECRET\""
fi

model_line=""
if [ -n "${OPENCODE_MODEL:-}" ]; then
  model_line="  \"model\": \"$OPENCODE_MODEL\","
fi

# Write the config (template is a reference; we render directly for portability).
cat > "$out" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
$model_line
  "instructions": ["$here/AGENTS.md"],
  "mcp": {
    "agenticnets": {
      "type": "local",
      "command": $mcp_cmd_json,
      "environment": {
$env_lines
      },
      "enabled": true
    }
  }
}
JSON

echo "==> Wrote $out"
echo "==> Gateway: $AGENTICOS_GATEWAY_URL | models: $AGENTICOS_MODELS | mode: $AGENTICOS_MODE"
echo "==> Launching OpenCode with the agenticnets MCP server ..."
cd "$work"
exec opencode "$@"
