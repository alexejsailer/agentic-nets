#!/usr/bin/env bash
# anos.sh - AgenticOS / AgenticNetOS control dispatcher for the agenticos-control plugin.
#
# CLI-first (the `agenticos` binary) with a curl fallback, in either "direct" mode
# (master :8082 / node :8080, no auth) or "gateway" mode (:8083 OAuth2, Bearer JWT).
#
# Use it two ways:
#   * source it   ->  gives you anos_master / anos_node / anos_arcql / anos_events /
#                     anos_cli / anos_preflight functions (token acquired once per process).
#   * run it      ->  anos.sh <preflight|master|node|arcql|events|cli|help> ...
#
# SECURITY: the client secret is read only from env or a *_FILE; the gateway JWT is held
# in-process and never written to disk; neither the secret nor the token is ever printed
# (even with ANOS_DEBUG=1). Callers must never echo them either.

set -uo pipefail

# ---- configuration (reuses the agenticos CLI env var names; adds direct-mode + control vars) ----
ANOS_MODE="${AGENTICOS_MODE:-auto}"                                          # cli | curl | auto
ANOS_AUTH="${AGENTICOS_AUTH:-auto}"                                          # direct | gateway | auto
ANOS_MASTER="${AGENTICOS_MASTER:-http://localhost:8082}"                     # direct master base
ANOS_NODE="${AGENTICOS_NODE:-http://localhost:8080}"                         # direct node base
ANOS_GATEWAY="${AGENTICOS_GATEWAY_URL:-${AGENTICOS_GATEWAY:-http://localhost:8083}}"
ANOS_CLIENT_ID="${AGENTICOS_CLIENT_ID:-agenticos-admin}"
ANOS_TIMEOUT="${AGENTICOS_TIMEOUT:-25}"
_ANOS_TOKEN=""                                                              # memoized JWT (in-process only)

_anos_dbg(){ [ "${ANOS_DEBUG:-0}" = "1" ] && printf '[anos] %s\n' "$*" >&2 || true; }
_anos_err(){ printf 'anos: %s\n' "$*" >&2; }

# ---- secret resolution (never printed) ----
_anos_secret(){
  if [ -n "${AGENTICOS_ADMIN_SECRET:-}" ]; then printf '%s' "$AGENTICOS_ADMIN_SECRET"; return 0; fi
  if [ -n "${AGENTICOS_GATEWAY_SECRET:-}" ]; then printf '%s' "$AGENTICOS_GATEWAY_SECRET"; return 0; fi
  local f="${AGENTICOS_GATEWAY_SECRET_FILE:-}"
  if [ -n "$f" ] && [ -f "$f" ]; then tr -d ' \t\r\n' < "$f"; return 0; fi
  return 1
}
_anos_have_secret(){ _anos_secret >/dev/null 2>&1; }
_anos_have_cli(){ command -v agenticos >/dev/null 2>&1; }

# ---- effective mode / auth ----
_anos_auth(){
  case "$ANOS_AUTH" in
    gateway) echo gateway ;;
    direct)  echo direct ;;
    *)       if _anos_have_secret; then echo gateway; else echo direct; fi ;;
  esac
}
_anos_mode(){
  case "$ANOS_MODE" in
    cli)  echo cli ;;
    curl) echo curl ;;
    *)    if _anos_have_cli; then echo cli; else echo curl; fi ;;
  esac
}

# ---- gateway JWT (client_credentials), memoized in-process ----
_anos_token(){
  [ -n "$_ANOS_TOKEN" ] && { printf '%s' "$_ANOS_TOKEN"; return 0; }
  local secret; secret="$(_anos_secret)" || {
    _anos_err "gateway auth needs a secret (set AGENTICOS_ADMIN_SECRET or AGENTICOS_GATEWAY_SECRET_FILE)"; return 1; }
  local resp
  resp="$(curl -s --max-time "$ANOS_TIMEOUT" -X POST "${ANOS_GATEWAY}/oauth2/token" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode 'grant_type=client_credentials' \
      --data-urlencode "client_id=${ANOS_CLIENT_ID}" \
      --data-urlencode "client_secret=${secret}")" || { _anos_err "token request failed (gateway unreachable?)"; return 1; }
  _ANOS_TOKEN="$(printf '%s' "$resp" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$_ANOS_TOKEN" ] || { _anos_err "no access_token in gateway response (bad secret or client_id?)"; return 1; }
  printf '%s' "$_ANOS_TOKEN"
}

# ---- raw HTTP: anos_master/anos_node <METHOD> <PATH-starting-with-/api...> [JSON-BODY] ----
# master paths keep their /api prefix in both direct and gateway mode (gateway routes master under /api).
anos_master(){
  local method="$1" path="$2" body="${3:-}" auth base
  auth="$(_anos_auth)"
  if [ "$auth" = gateway ]; then
    local tok; tok="$(_anos_token)" || return 1
    base="$ANOS_GATEWAY"
    _anos_curl "$method" "${base}${path}" "$body" -H "Authorization: Bearer ${tok}"
  else
    base="$ANOS_MASTER"
    _anos_curl "$method" "${base}${path}" "$body"
  fi
}
# node paths: direct -> node host; gateway -> master's /api/proxy is preferred (see anos_arcql/anos_events).
anos_node(){
  local method="$1" path="$2" body="${3:-}" auth
  auth="$(_anos_auth)"
  if [ "$auth" = gateway ]; then
    local tok; tok="$(_anos_token)" || return 1
    # gateway exposes node under /node-api (node's own /api/... becomes /node-api/api/...)
    _anos_curl "$method" "${ANOS_GATEWAY}/node-api${path}" "$body" -H "Authorization: Bearer ${tok}"
  else
    _anos_curl "$method" "${ANOS_NODE}${path}" "$body"
  fi
}

# node-backed ops routed THROUGH master's proxy controllers (auth-uniform, no node routing needed)
anos_arcql(){  # anos_arcql <modelId> <arcql-string>
  local model="$1" q="$2"
  anos_master POST "/api/proxy/arcql/${model}/query" "$(printf '{"query":%s}' "$(_anos_json "$q")")"
}
anos_events(){ # anos_events <modelId> <events-json-array-or-object>
  local model="$1" ev="$2"
  anos_master POST "/api/proxy/events/${model}/execute" "$ev"
}

# internal: JSON-encode a scalar string
_anos_json(){ printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${1//\"/\\\"}"; }

# internal: curl wrapper (JSON in/out); extra args after body are passed to curl (e.g. auth header)
_anos_curl(){
  local method="$1" url="$2" body="$3"; shift 3
  local args=(-s --max-time "$ANOS_TIMEOUT" -X "$method" "$url" -H 'Accept: application/json' "$@")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  _anos_dbg "$method $url"
  curl "${args[@]}"
}

# ---- CLI passthrough: run the agenticos binary if present (adds --direct in direct mode) ----
anos_cli(){
  _anos_have_cli || { _anos_err "agenticos CLI not on PATH"; return 127; }
  local flags=()
  [ "$(_anos_auth)" = direct ] && flags+=(--direct)
  _anos_dbg "agenticos ${flags[*]} $*"
  agenticos "${flags[@]}" "$@"
}

# ---- preflight: resolved config + reachability, NO secrets ----
anos_preflight(){
  local mode auth ok
  mode="$(_anos_mode)"; auth="$(_anos_auth)"
  echo "AgenticOS control preflight"
  echo "  mode        : $mode        (AGENTICOS_MODE=$ANOS_MODE; agenticos on PATH: $(_anos_have_cli && echo yes || echo no))"
  echo "  auth        : $auth        (AGENTICOS_AUTH=$ANOS_AUTH; secret present: $(_anos_have_secret && echo yes || echo no))"
  if [ "$auth" = gateway ]; then
    echo "  gateway     : $ANOS_GATEWAY   (client_id=$ANOS_CLIENT_ID)"
    printf '  token       : '; if _anos_token >/dev/null 2>&1; then echo "acquired OK (not shown)"; else echo "FAILED to acquire"; fi
    printf '  master /api : '; ok="$(anos_master GET /api/health 2>/dev/null)"; [ -n "$ok" ] && echo "reachable" || echo "unreachable"
  else
    echo "  master      : $ANOS_MASTER"
    echo "  node        : $ANOS_NODE"
    printf '  master /api : '; ok="$(anos_master GET /api/health 2>/dev/null)"; [ -n "$ok" ] && echo "reachable" || echo "unreachable"
  fi
  echo "  model/session defaults: ${AGENTICOS_MODEL:-<none>} / ${AGENTICOS_SESSION:-<none>}"
}

anos_help(){
  sed -n '2,14p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Usage (run):
  anos.sh preflight
  anos.sh master <METHOD> <PATH> [JSON_BODY]     # e.g. anos.sh master GET '/api/designtime/nets?modelId=m&sessionId=s'
  anos.sh node   <METHOD> <PATH> [JSON_BODY]     # direct-mode node access
  anos.sh arcql  <modelId> '<ARCQL>'             # via master proxy
  anos.sh events <modelId> '<EVENTS_JSON>'       # via master proxy
  anos.sh cli    <args...>                        # run the agenticos binary (adds --direct in direct mode)

Env: AGENTICOS_MODE(cli|curl|auto) AGENTICOS_AUTH(direct|gateway|auto)
     AGENTICOS_MASTER AGENTICOS_NODE AGENTICOS_GATEWAY_URL AGENTICOS_CLIENT_ID
     AGENTICOS_ADMIN_SECRET | AGENTICOS_GATEWAY_SECRET_FILE   AGENTICOS_MODEL AGENTICOS_SESSION
EOF
}

# ---- dispatch when executed (not when sourced) ----
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  cmd="${1:-help}"; shift || true
  case "$cmd" in
    preflight) anos_preflight ;;
    master)    anos_master "$@" ;;
    node)      anos_node "$@" ;;
    arcql)     anos_arcql "$@" ;;
    events)    anos_events "$@" ;;
    cli)       anos_cli "$@" ;;
    help|-h|--help) anos_help ;;
    *) _anos_err "unknown command: $cmd"; anos_help; exit 2 ;;
  esac
fi
