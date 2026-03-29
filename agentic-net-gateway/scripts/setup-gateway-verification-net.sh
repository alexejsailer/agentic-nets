#!/bin/bash
# ============================================================================
# Gateway Multi-Master Routing Verification Net — Setup Script
# ============================================================================
#
# Creates an agentic net in model "agenticdev" / session "dev" that verifies
# the gateway's multi-master routing feature end-to-end:
#
#   Phase 1: Run unit tests (./mvnw test)
#   Phase 2: Register 2 mock masters, verify registration
#   Phase 3: Test explicit, wildcard, discover, executor routing (4 parallel)
#   Phase 4: Deregister masters, verify fallback, produce final verdict
#
# Prerequisites:
#   - agentic-net-node running on localhost:8080
#   - agentic-net-master running on localhost:8082
#   - agentic-net-gateway running on localhost:8083
#   - agentic-net-executor running on localhost:8084
#   - jq installed (brew install jq)
#
# Usage:
#   chmod +x scripts/setup-gateway-verification-net.sh
#   ./scripts/setup-gateway-verification-net.sh
#
# ============================================================================

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

NODE_URL="http://localhost:8080"
MASTER_URL="http://localhost:8082"
GATEWAY_URL="http://localhost:8083"
MODEL_ID="agenticdev"
SESSION_ID="dev"
NET_ID="gateway-routing-verify"
HOST="${MODEL_ID}@localhost:8080"
EXECUTOR_ID="agentic-net-executor-default"
GW_DIR="/Users/alexejsailer/Developer/AgenticNetOS/agentic-nets/agentic-net-gateway"

# Temp file for place UUID storage (bash 3 compatible — no associative arrays)
PLACE_MAP=$(mktemp /tmp/gw-verify-places.XXXXXX)
trap "rm -f $PLACE_MAP" EXIT

# ============================================================================
# Logging helpers
# ============================================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { printf "${BLUE}[INFO]${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}[ OK ]${NC} %s\n" "$1"; }
fail()  { printf "${RED}[FAIL]${NC} %s\n" "$1"; exit 1; }
warn()  { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }

# ============================================================================
# Helper: store / retrieve place UUIDs (bash 3 compatible)
# ============================================================================

set_place() { echo "$1=$2" >> "$PLACE_MAP"; }

get_place() {
  grep "^$1=" "$PLACE_MAP" | tail -1 | cut -d= -f2
}

# ============================================================================
# Helper: register a transition via master RuntimeController
# ============================================================================

register_transition() {
  local tid="$1"
  local agent="${2:-}"
  local inscription="$3"

  local body
  if [ -n "$agent" ]; then
    body=$(jq -n \
      --arg tid "$tid" \
      --arg agent "$agent" \
      --argjson insc "$inscription" \
      '{transitionId:$tid, assignedAgent:$agent, autoStart:false, inscription:$insc}')
  else
    body=$(jq -n \
      --arg tid "$tid" \
      --argjson insc "$inscription" \
      '{transitionId:$tid, autoStart:false, inscription:$insc}')
  fi

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${MASTER_URL}/api/runtime/transitions?modelId=${MODEL_ID}" \
    -H "Content-Type: application/json" \
    -d "$body")

  if [ "$http_code" = "201" ] || [ "$http_code" = "200" ]; then
    ok "  $tid"
  elif [ "$http_code" = "409" ]; then
    # Already exists — update inscription to pick up new place UUIDs
    local update_code
    update_code=$(curl -s -o /dev/null -w "%{http_code}" \
      -X PUT "${MASTER_URL}/api/runtime/transitions/${tid}/inscription?modelId=${MODEL_ID}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --argjson insc "$inscription" '{inscription:$insc}')")
    ok "  $tid (updated, HTTP $update_code)"
  else
    warn "  $tid (HTTP $http_code — will retry via node)"
    local node_body
    node_body=$(jq -n --argjson insc "$inscription" --arg tid "$tid" \
      '{transitionId:$tid, autoStart:true, inscription:$insc}')
    curl -s -o /dev/null \
      -X POST "${NODE_URL}/api/transitions" \
      -H "Content-Type: application/json" \
      -d "$node_body" 2>/dev/null && ok "  $tid (via node fallback)" || warn "  $tid fallback also failed"
  fi
}

# ============================================================================
# Helper: create a place node (idempotent)
# ============================================================================

create_place() {
  local name="$1"
  local parent="${2:-root}"

  # Check if place already exists (idempotent re-run)
  local existing
  existing=$(curl -s "${NODE_URL}/api/models/${MODEL_ID}/children?parentId=${parent}" | \
    jq -r ".[] | select(.name==\"$name\") | .id" 2>/dev/null | head -1)

  if [ -n "$existing" ]; then
    set_place "$name" "$existing"
    return
  fi

  # Create new place
  local uuid
  uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')

  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${NODE_URL}/api/models/${MODEL_ID}/nodes" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$uuid" --arg n "$name" --arg p "$parent" '{parentId:$p,name:$n,id:$id}')" >/dev/null

  set_place "$name" "$uuid"
}

# ============================================================================
# Helper: seed a token (create leaf + set properties via Events API)
# ============================================================================

seed_token() {
  local place_name="$1"
  local token_name="$2"
  local properties_json="$3"  # JSON object of key:value pairs

  local place_id
  place_id=$(get_place "$place_name")
  local token_id
  token_id=$(uuidgen | tr '[:upper:]' '[:lower:]')

  # Delete existing tokens (clean re-run) via Events API
  curl -s "${NODE_URL}/api/models/${MODEL_ID}/children?parentId=${place_id}" | \
    jq -r '.[] | "\(.id)|\(.name)"' 2>/dev/null | while IFS='|' read -r eid ename; do
      curl -sf -X POST "${NODE_URL}/api/events/execute/${MODEL_ID}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg parent "$place_id" --arg id "$eid" --arg name "$ename" \
          '{events: [{eventType: "deleteLeaf", parentId: $parent, id: $id, name: $name}]}')" >/dev/null 2>&1 || true
    done

  # Create token leaf
  curl -sf -X POST "${NODE_URL}/api/models/${MODEL_ID}/leaves" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$token_id" --arg parent "$place_id" --arg n "$token_name" \
      '{parentId:$parent, name:$n, id:$id}')" >/dev/null

  # Set properties via Events API
  local events="[]"
  events=$(echo "$properties_json" | jq -c --arg parent "$place_id" --arg token "$token_id" --arg n "$token_name" '
    [to_entries[] | {
      eventType: "updateProperty",
      parentId: $parent,
      id: $token,
      name: $n,
      properties: { key: .key, value: (.value | tostring) }
    }]
  ')

  curl -sf -X POST "${NODE_URL}/api/events/execute/${MODEL_ID}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --argjson evts "$events" '{events: $evts}')" >/dev/null

  ok "  $place_name ← $token_name"
}

# ============================================================================
# Step 0: Prerequisites
# ============================================================================

echo ""
echo "============================================"
echo "  Gateway Routing Verification Net — Setup"
echo "============================================"
echo ""

info "Checking prerequisites..."
command -v jq &>/dev/null || fail "jq is required (brew install jq)"
curl -sf "${NODE_URL}/actuator/health" >/dev/null 2>&1 || fail "agentic-net-node not running on ${NODE_URL}"
curl -sf "${MASTER_URL}/api/health" >/dev/null 2>&1 || fail "agentic-net-master not running on ${MASTER_URL}"
curl -sf "${GATEWAY_URL}/actuator/health" >/dev/null 2>&1 || fail "agentic-net-gateway not running on ${GATEWAY_URL}"
ok "All services healthy"

# ============================================================================
# Step 1: Ensure model exists (idempotent)
# ============================================================================

info "Ensuring model: ${MODEL_ID}"
MODEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${NODE_URL}/api/admin/models/${MODEL_ID}")
if [ "$MODEL_STATUS" = "200" ]; then
  ok "Model already exists"
else
  curl -sf -X POST "${NODE_URL}/api/admin/models" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$MODEL_ID" '{modelId:$id, name:"AgenticDev"}')" >/dev/null
  ok "Model created"
fi

# ============================================================================
# Step 2: Ensure workspace/places structure
# ============================================================================

info "Ensuring workspace structure..."

# Check/create workspace
WORKSPACE_ID=$(curl -s "${NODE_URL}/api/models/${MODEL_ID}/children?parentId=root" | \
  jq -r '.[] | select(.name=="workspace") | .id' 2>/dev/null | head -1)

if [ -z "$WORKSPACE_ID" ]; then
  WORKSPACE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  curl -sf -X POST "${NODE_URL}/api/models/${MODEL_ID}/nodes" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$WORKSPACE_ID" '{parentId:"root",name:"workspace",id:$id}')" >/dev/null
  ok "Workspace created"
else
  ok "Workspace exists ($WORKSPACE_ID)"
fi

# Check/create places container
PLACES_ID=$(curl -s "${NODE_URL}/api/models/${MODEL_ID}/children?parentId=${WORKSPACE_ID}" | \
  jq -r '.[] | select(.name=="places") | .id' 2>/dev/null | head -1)

if [ -z "$PLACES_ID" ]; then
  PLACES_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  curl -sf -X POST "${NODE_URL}/api/models/${MODEL_ID}/nodes" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$PLACES_ID" --arg parent "$WORKSPACE_ID" '{parentId:$parent,name:"places",id:$id}')" >/dev/null
  ok "Places container created"
else
  ok "Places container exists ($PLACES_ID)"
fi

# ============================================================================
# Step 3: Create 21 places
# ============================================================================

info "Creating 23 places..."

for name in \
  p-context \
  p-unit-test-cmd p-unit-test-result p-unit-test-verdict \
  p-cleanup-cmd p-cleanup-result \
  p-register-cmd p-register-result p-register-verdict \
  p-explicit-cmd p-explicit-result \
  p-wildcard-cmd p-wildcard-result \
  p-discover-cmd p-discover-result \
  p-executor-cmd p-executor-result \
  p-routing-verdict \
  p-deregister-cmd p-deregister-result \
  p-final-verdict \
  p-bootstrap-context p-bootstrap-result; do
  create_place "$name" "$PLACES_ID"
done
ok "Created/verified 23 places"

# ============================================================================
# Step 3b: Stop existing transitions (clean re-run)
# ============================================================================

info "Stopping existing transitions (if any)..."
for tid in t-run-unit-tests t-verify-unit-tests t-cleanup t-register t-verify-reg \
           t-test-explicit t-test-wildcard t-test-discover t-test-executor \
           t-verify-routing t-deregister t-final-verdict t-bootstrap; do
  curl -s -o /dev/null -X POST "${MASTER_URL}/api/runtime/transitions/${tid}/stop?modelId=${MODEL_ID}" 2>/dev/null || true
done
ok "Existing transitions stopped"

# ============================================================================
# Step 3c: Clear all tokens from all places (clean re-run)
# ============================================================================

info "Clearing stale tokens from all places..."
for pname in \
  p-context \
  p-unit-test-cmd p-unit-test-result p-unit-test-verdict \
  p-cleanup-cmd p-cleanup-result \
  p-register-cmd p-register-result p-register-verdict \
  p-explicit-cmd p-explicit-result \
  p-wildcard-cmd p-wildcard-result \
  p-discover-cmd p-discover-result \
  p-executor-cmd p-executor-result \
  p-routing-verdict \
  p-deregister-cmd p-deregister-result \
  p-final-verdict \
  p-bootstrap-context p-bootstrap-result; do
  local_pid=$(get_place "$pname")
  if [ -n "$local_pid" ]; then
    # Get all leaf IDs and names, then delete via Events API
    curl -s "${NODE_URL}/api/models/${MODEL_ID}/children?parentId=${local_pid}" | \
      jq -r '.[] | "\(.id)|\(.name)"' 2>/dev/null | while IFS='|' read -r leaf_id leaf_name; do
        curl -sf -X POST "${NODE_URL}/api/events/execute/${MODEL_ID}" \
          -H "Content-Type: application/json" \
          -d "$(jq -n --arg parent "$local_pid" --arg id "$leaf_id" --arg name "$leaf_name" \
            '{events: [{eventType: "deleteLeaf", parentId: $parent, id: $id, name: $name}]}')" >/dev/null 2>&1 || true
      done
  fi
done
ok "Stale tokens cleared"

# ============================================================================
# Step 4: Register 12 transitions
# ============================================================================

info "Registering 13 transitions..."

# ---------- T1: t-run-unit-tests (command) ----------
register_transition "t-run-unit-tests" "$EXECUTOR_ID" "$(jq -n \
  --arg pin  "$(get_place p-unit-test-cmd)" \
  --arg pout "$(get_place p-unit-test-result)" \
  --arg host "$HOST" \
  '{
    id: "t-run-unit-tests",
    kind: "command",
    presets: {
      input: { placeId: $pin, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 120000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T2: t-verify-unit-tests (agent) ----------
register_transition "t-verify-unit-tests" "" "$(jq -n \
  --arg pin  "$(get_place p-unit-test-result)" \
  --arg pctx "$(get_place p-context)" \
  --arg pout "$(get_place p-unit-test-verdict)" \
  --arg host "$HOST" \
  --arg model "$MODEL_ID" \
  '{
    id: "t-verify-unit-tests",
    kind: "agent",
    presets: {
      result:  { placeId: $pin,  host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      context: { placeId: $pctx, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false, optional: true }
    },
    postsets: {
      verdict: { placeId: $pout, host: $host }
    },
    action: {
      type: "agent",
      nl: "Analyze the Maven test output in ${result}. Check for BUILD SUCCESS. Count tests run, failures, errors, skipped. Output JSON: {\"phase\":\"unit-tests\", \"status\":\"PASSED\" or \"FAILED\", \"testsRun\":N, \"failures\":N, \"errors\":N, \"summary\":\"...\"}",
      modelId: $model,
      role: "r",
      maxIterations: 5
    },
    emit: [{ to: "verdict", from: "@response" }],
    mode: "SINGLE"
  }')"

# ---------- T3: t-cleanup (command) ----------
register_transition "t-cleanup" "$EXECUTOR_ID" "$(jq -n \
  --arg pin  "$(get_place p-cleanup-cmd)" \
  --arg pout "$(get_place p-cleanup-result)" \
  --arg host "$HOST" \
  '{
    id: "t-cleanup",
    kind: "command",
    presets: {
      input: { placeId: $pin, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 15000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T4: t-register (command, guarded by p-cleanup-result) ----------
register_transition "t-register" "$EXECUTOR_ID" "$(jq -n \
  --arg pin    "$(get_place p-register-cmd)" \
  --arg pguard "$(get_place p-cleanup-result)" \
  --arg pout   "$(get_place p-register-result)" \
  --arg host   "$HOST" \
  '{
    id: "t-register",
    kind: "command",
    presets: {
      input: { placeId: $pin,    host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      guard: { placeId: $pguard, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 30000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T5: t-verify-reg (agent) ----------
register_transition "t-verify-reg" "" "$(jq -n \
  --arg pin  "$(get_place p-register-result)" \
  --arg pctx "$(get_place p-context)" \
  --arg pout "$(get_place p-register-verdict)" \
  --arg host "$HOST" \
  --arg model "$MODEL_ID" \
  '{
    id: "t-verify-reg",
    kind: "agent",
    presets: {
      result:  { placeId: $pin,  host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      context: { placeId: $pctx, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false, optional: true }
    },
    postsets: {
      verdict: { placeId: $pout, host: $host }
    },
    action: {
      type: "agent",
      nl: "Analyze the registration output in ${result}. Verify: 1) test-master-1 registered with status:registered, 2) test-master-2 registered with status:registered, 3) master list shows both, 4) heartbeat returned status:ok. Output JSON: {\"phase\":\"registration\", \"status\":\"PASSED\" or \"FAILED\", \"master1Registered\":bool, \"master2Registered\":bool, \"heartbeatOk\":bool, \"summary\":\"...\"}",
      modelId: $model,
      role: "r",
      maxIterations: 5
    },
    emit: [{ to: "verdict", from: "@response" }],
    mode: "SINGLE"
  }')"

# ---------- T6: t-test-explicit (command, guarded by p-register-verdict) ----------
register_transition "t-test-explicit" "$EXECUTOR_ID" "$(jq -n \
  --arg pin    "$(get_place p-explicit-cmd)" \
  --arg pguard "$(get_place p-register-verdict)" \
  --arg pout   "$(get_place p-explicit-result)" \
  --arg host   "$HOST" \
  '{
    id: "t-test-explicit",
    kind: "command",
    presets: {
      input: { placeId: $pin,    host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      guard: { placeId: $pguard, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 30000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T7: t-test-wildcard (command, guarded by p-register-verdict) ----------
register_transition "t-test-wildcard" "$EXECUTOR_ID" "$(jq -n \
  --arg pin    "$(get_place p-wildcard-cmd)" \
  --arg pguard "$(get_place p-register-verdict)" \
  --arg pout   "$(get_place p-wildcard-result)" \
  --arg host   "$HOST" \
  '{
    id: "t-test-wildcard",
    kind: "command",
    presets: {
      input: { placeId: $pin,    host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      guard: { placeId: $pguard, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 30000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T8: t-test-discover (command, guarded by p-register-verdict) ----------
register_transition "t-test-discover" "$EXECUTOR_ID" "$(jq -n \
  --arg pin    "$(get_place p-discover-cmd)" \
  --arg pguard "$(get_place p-register-verdict)" \
  --arg pout   "$(get_place p-discover-result)" \
  --arg host   "$HOST" \
  '{
    id: "t-test-discover",
    kind: "command",
    presets: {
      input: { placeId: $pin,    host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      guard: { placeId: $pguard, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 30000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T9: t-test-executor (command, guarded by p-register-verdict) ----------
register_transition "t-test-executor" "$EXECUTOR_ID" "$(jq -n \
  --arg pin    "$(get_place p-executor-cmd)" \
  --arg pguard "$(get_place p-register-verdict)" \
  --arg pout   "$(get_place p-executor-result)" \
  --arg host   "$HOST" \
  '{
    id: "t-test-executor",
    kind: "command",
    presets: {
      input: { placeId: $pin,    host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      guard: { placeId: $pguard, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 30000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T10: t-verify-routing (agent) ----------
register_transition "t-verify-routing" "" "$(jq -n \
  --arg p1   "$(get_place p-explicit-result)" \
  --arg p2   "$(get_place p-wildcard-result)" \
  --arg p3   "$(get_place p-discover-result)" \
  --arg p4   "$(get_place p-executor-result)" \
  --arg pctx "$(get_place p-context)" \
  --arg pout "$(get_place p-routing-verdict)" \
  --arg host "$HOST" \
  --arg model "$MODEL_ID" \
  '{
    id: "t-verify-routing",
    kind: "agent",
    presets: {
      explicit:  { placeId: $p1,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      wildcard:  { placeId: $p2,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      discover:  { placeId: $p3,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      executor:  { placeId: $p4,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      context:   { placeId: $pctx, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false, optional: true }
    },
    postsets: {
      verdict: { placeId: $pout, host: $host }
    },
    action: {
      type: "agent",
      nl: "Analyze all 4 routing test outputs. Check: 1) ${explicit}: model-a and model-b 502 errors reference localhost:19001 (test-master-1). 2) ${wildcard}: model-unknown 502 references localhost:19002 (test-master-2). 3) ${discover}: fan-out attempted to both masters. 4) ${executor}: no-modelId fans out, with-modelId routes to single. Output JSON: {\"phase\":\"routing\", \"status\":\"PASSED\" or \"FAILED\", \"explicitOk\":bool, \"wildcardOk\":bool, \"discoverOk\":bool, \"executorOk\":bool, \"summary\":\"...\"}",
      modelId: $model,
      role: "r",
      maxIterations: 5
    },
    emit: [{ to: "verdict", from: "@response" }],
    mode: "SINGLE"
  }')"

# ---------- T11: t-deregister (command, guarded by p-routing-verdict) ----------
register_transition "t-deregister" "$EXECUTOR_ID" "$(jq -n \
  --arg pin    "$(get_place p-deregister-cmd)" \
  --arg pguard "$(get_place p-routing-verdict)" \
  --arg pout   "$(get_place p-deregister-result)" \
  --arg host   "$HOST" \
  '{
    id: "t-deregister",
    kind: "command",
    presets: {
      input: { placeId: $pin,    host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      guard: { placeId: $pguard, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      output: { placeId: $pout, host: $host }
    },
    action: {
      type: "command",
      inputPlace: "input",
      dispatch: [{ executor: "bash", channel: "default" }],
      await: "ALL",
      timeoutMs: 30000
    },
    emit: [{ to: "output", from: "@result", when: "success" }],
    mode: "SINGLE"
  }')"

# ---------- T12: t-final-verdict (agent) ----------
register_transition "t-final-verdict" "" "$(jq -n \
  --arg p1   "$(get_place p-unit-test-verdict)" \
  --arg p2   "$(get_place p-routing-verdict)" \
  --arg p3   "$(get_place p-deregister-result)" \
  --arg pctx "$(get_place p-context)" \
  --arg pout "$(get_place p-final-verdict)" \
  --arg host "$HOST" \
  --arg model "$MODEL_ID" \
  '{
    id: "t-final-verdict",
    kind: "agent",
    presets: {
      unitTests:    { placeId: $p1,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      routing:      { placeId: $p2,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      deregister:   { placeId: $p3,   host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: true },
      context:      { placeId: $pctx, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false, optional: true }
    },
    postsets: {
      verdict: { placeId: $pout, host: $host }
    },
    action: {
      type: "agent",
      nl: "Produce the final verification verdict. Inputs: ${unitTests} (unit test verdict), ${routing} (routing verdict), ${deregister} (deregistration output — verify masters removed, model-a falls back to seed). Output JSON: {\"overall\":\"PASSED\" or \"FAILED\", \"phases\":{\"unitTests\":\"PASSED/FAILED\", \"registration\":\"PASSED/FAILED\", \"routing\":\"PASSED/FAILED\", \"deregistration\":\"PASSED/FAILED\"}, \"summary\":\"...\"}",
      modelId: $model,
      role: "r",
      maxIterations: 5
    },
    emit: [{ to: "verdict", from: "@response" }],
    mode: "SINGLE"
  }')"

# ---------- T13: t-bootstrap (agent — creates 9 initial tokens on demand) ----------
register_transition "t-bootstrap" "" "$(jq -n \
  --arg pctx "$(get_place p-bootstrap-context)" \
  --arg pout "$(get_place p-bootstrap-result)" \
  --arg host "$HOST" \
  --arg model "$MODEL_ID" \
  '{
    id: "t-bootstrap",
    kind: "agent",
    presets: {
      context: { placeId: $pctx, host: $host, arcql: "FROM $ LIMIT 1", take: "FIRST", consume: false }
    },
    postsets: {
      result: { placeId: $pout, host: $host }
    },
    action: {
      type: "agent",
      nl: "You are a bootstrap agent for the gateway-routing-verify net. Your job is to create 9 initial command tokens in the correct places.\n\nRead the token definitions from ${context}. The context token has a \"definitions\" property containing a JSON array. Each entry has:\n- \"placePath\": the target place path (e.g., \"/root/workspace/places/p-unit-test-cmd\")\n- \"tokenName\": name for the new token\n- \"tokenData\": the exact properties to set on the token\n\nFor each definition:\n1. Use the CREATE_TOKEN tool with placePath, tokenName, and tokenData from the definition\n2. Track which tokens succeeded and which failed\n\nAfter creating all tokens, report a summary JSON:\n{\"status\": \"SUCCESS\" or \"FAILED\", \"created\": N, \"failed\": N, \"details\": [\"p-unit-test-cmd: OK\", ...]}",
      modelId: $model,
      role: "rw",
      maxIterations: 20
    },
    emit: [{ to: "result", from: "@response" }],
    mode: "SINGLE"
  }')"

ok "All 13 transitions registered"

# ============================================================================
# Step 5: Seed 9 initial tokens
# ============================================================================

info "Seeding 9 initial tokens..."

# --- Token 1: p-context (shared knowledge, never consumed) ---
CONTEXT_JSON=$(cat <<'CTXEOF'
{
  "type": "gateway-verification-context",
  "gatewayUrl": "http://localhost:8083",
  "architecture": {
    "registrationApi": {
      "register": "POST /internal/masters/register {masterId, url, models}",
      "heartbeat": "POST /internal/masters/heartbeat {masterId}",
      "deregister": "DELETE /internal/masters/{masterId}",
      "list": "GET /internal/masters"
    },
    "proxyRouting": {
      "modelIdExtraction": "1. Query param modelId, 2. JSON body modelId, 3. null fallback",
      "explicitRouting": "modelToMaster map for explicit model declarations",
      "wildcardRouting": "round-robin across masters with models=['*']",
      "fanOutEndpoints": ["/api/transitions/discover (always)", "/api/executors (when no modelId)"]
    },
    "testMasters": {
      "test-master-1": {"url": "http://localhost:19001", "models": ["model-a", "model-b"]},
      "test-master-2": {"url": "http://localhost:19002", "models": ["*"]}
    },
    "expected502Behavior": "When proxy target is unreachable, gateway returns 502 with error JSON containing master URL",
    "seedMaster": "Auto-registered from gateway.master-url config with models=['*'], seed=true, never evicted"
  },
  "passCriteria": {
    "unitTests": "All mvn tests pass (BUILD SUCCESS in output)",
    "registration": "Both masters register with status:registered, list shows them, heartbeat returns ok",
    "explicitRouting": "model-a and model-b 502 errors reference localhost:19001",
    "wildcardRouting": "model-unknown 502 error references localhost:19002",
    "discoverFanout": "Gateway attempts both masters (aggregation attempt)",
    "executorFanout": "No-modelId fans out to all, with-modelId goes to single master",
    "deregistration": "After DELETE, masters disappear from list, model-a falls back to seed master"
  }
}
CTXEOF
)

seed_token "p-context" "context" "$CONTEXT_JSON"

# --- Token 2: p-unit-test-cmd ---
seed_token "p-unit-test-cmd" "cmd-unit-tests" "$(jq -n \
  --arg cmd "cd ${GW_DIR} && ./mvnw test 2>&1 | tail -80" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-unit-tests",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 120000 },
    expect: "text"
  }')"

# --- Token 3: p-cleanup-cmd ---
seed_token "p-cleanup-cmd" "cmd-cleanup" "$(jq -n \
  --arg cmd "curl -s -X DELETE http://localhost:8083/internal/masters/test-master-1 2>/dev/null; curl -s -X DELETE http://localhost:8083/internal/masters/test-master-2 2>/dev/null; echo '=== Current masters ===' && curl -s http://localhost:8083/internal/masters | jq ." \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-cleanup",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 15000 },
    expect: "text"
  }')"

# --- Token 4: p-register-cmd ---
REGISTER_CMD=$(cat <<'REGEOF'
echo '=== Registering test-master-1 (model-a, model-b) ===' && \
curl -s -X POST http://localhost:8083/internal/masters/register \
  -H 'Content-Type: application/json' \
  -d '{"masterId":"test-master-1","url":"http://localhost:19001","models":["model-a","model-b"]}' | jq . && \
echo '=== Registering test-master-2 (wildcard) ===' && \
curl -s -X POST http://localhost:8083/internal/masters/register \
  -H 'Content-Type: application/json' \
  -d '{"masterId":"test-master-2","url":"http://localhost:19002","models":["*"]}' | jq . && \
echo '=== Listing all masters ===' && \
curl -s http://localhost:8083/internal/masters | jq . && \
echo '=== Heartbeat test-master-1 ===' && \
curl -s -X POST http://localhost:8083/internal/masters/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"masterId":"test-master-1"}' | jq .
REGEOF
)
seed_token "p-register-cmd" "cmd-register" "$(jq -n \
  --arg cmd "$REGISTER_CMD" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-register-masters",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 30000 },
    expect: "text"
  }')"

# --- Token 5: p-explicit-cmd ---
EXPLICIT_CMD=$(cat <<'EXPEOF'
ADMIN_SECRET=$(cat /Users/alexejsailer/Developer/AgenticNetOS/agentic-nets/agentic-net-gateway/data/jwt/admin-secret 2>/dev/null || echo '') && \
if [ -z "$ADMIN_SECRET" ]; then echo 'SKIP: No admin secret found'; exit 0; fi && \
TOKEN=$(curl -s -X POST http://localhost:8083/oauth2/token \
  -d "grant_type=client_credentials&client_id=agenticos-admin&client_secret=${ADMIN_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' | jq -r '.access_token') && \
echo '=== Test: model-a -> test-master-1 (expect 502 with localhost:19001) ===' && \
curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8083/api/transitions/poll?modelId=model-a&executorId=test-exec' && \
echo '' && \
echo '=== Test: model-b -> test-master-1 ===' && \
curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8083/api/transitions/poll?modelId=model-b&executorId=test-exec'
EXPEOF
)
seed_token "p-explicit-cmd" "cmd-explicit" "$(jq -n \
  --arg cmd "$EXPLICIT_CMD" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-explicit-routing",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 30000 },
    expect: "text"
  }')"

# --- Token 6: p-wildcard-cmd ---
WILDCARD_CMD=$(cat <<'WLDEOF'
ADMIN_SECRET=$(cat /Users/alexejsailer/Developer/AgenticNetOS/agentic-nets/agentic-net-gateway/data/jwt/admin-secret 2>/dev/null || echo '') && \
if [ -z "$ADMIN_SECRET" ]; then echo 'SKIP: No admin secret'; exit 0; fi && \
TOKEN=$(curl -s -X POST http://localhost:8083/oauth2/token \
  -d "grant_type=client_credentials&client_id=agenticos-admin&client_secret=${ADMIN_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' | jq -r '.access_token') && \
echo '=== Test: model-unknown -> wildcard master (expect 502 with localhost:19002) ===' && \
curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8083/api/transitions/poll?modelId=model-unknown&executorId=test-exec'
WLDEOF
)
seed_token "p-wildcard-cmd" "cmd-wildcard" "$(jq -n \
  --arg cmd "$WILDCARD_CMD" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-wildcard-routing",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 30000 },
    expect: "text"
  }')"

# --- Token 7: p-discover-cmd ---
DISCOVER_CMD=$(cat <<'DSCEOF'
ADMIN_SECRET=$(cat /Users/alexejsailer/Developer/AgenticNetOS/agentic-nets/agentic-net-gateway/data/jwt/admin-secret 2>/dev/null || echo '') && \
if [ -z "$ADMIN_SECRET" ]; then echo 'SKIP: No admin secret'; exit 0; fi && \
TOKEN=$(curl -s -X POST http://localhost:8083/oauth2/token \
  -d "grant_type=client_credentials&client_id=agenticos-admin&client_secret=${ADMIN_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' | jq -r '.access_token') && \
echo '=== Test: discover fan-out to all masters ===' && \
curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8083/api/transitions/discover?executorId=test-exec&allowedModels=*'
DSCEOF
)
seed_token "p-discover-cmd" "cmd-discover" "$(jq -n \
  --arg cmd "$DISCOVER_CMD" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-discover-fanout",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 30000 },
    expect: "text"
  }')"

# --- Token 8: p-executor-cmd ---
EXECUTOR_CMD=$(cat <<'EXECEOF'
ADMIN_SECRET=$(cat /Users/alexejsailer/Developer/AgenticNetOS/agentic-nets/agentic-net-gateway/data/jwt/admin-secret 2>/dev/null || echo '') && \
if [ -z "$ADMIN_SECRET" ]; then echo 'SKIP: No admin secret'; exit 0; fi && \
TOKEN=$(curl -s -X POST http://localhost:8083/oauth2/token \
  -d "grant_type=client_credentials&client_id=agenticos-admin&client_secret=${ADMIN_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' | jq -r '.access_token') && \
echo '=== Test: executor list fan-out (no modelId) ===' && \
curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8083/api/executors?activeOnly=true' && \
echo '' && \
echo '=== Test: executor list WITH modelId (single master) ===' && \
curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8083/api/executors?activeOnly=true&modelId=model-a'
EXECEOF
)
seed_token "p-executor-cmd" "cmd-executor" "$(jq -n \
  --arg cmd "$EXECUTOR_CMD" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-executor-fanout",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 30000 },
    expect: "text"
  }')"

# --- Token 9: p-deregister-cmd ---
DEREGISTER_CMD=$(cat <<'DEREGEOF'
echo '=== Deregistering test-master-1 ===' && \
curl -s -X DELETE http://localhost:8083/internal/masters/test-master-1 | jq . && \
echo '=== Deregistering test-master-2 ===' && \
curl -s -X DELETE http://localhost:8083/internal/masters/test-master-2 | jq . && \
echo '=== Masters after deregistration ===' && \
curl -s http://localhost:8083/internal/masters | jq . && \
ADMIN_SECRET=$(cat /Users/alexejsailer/Developer/AgenticNetOS/agentic-nets/agentic-net-gateway/data/jwt/admin-secret 2>/dev/null || echo '') && \
if [ -n "$ADMIN_SECRET" ]; then \
  TOKEN=$(curl -s -X POST http://localhost:8083/oauth2/token \
    -d "grant_type=client_credentials&client_id=agenticos-admin&client_secret=${ADMIN_SECRET}" \
    -H 'Content-Type: application/x-www-form-urlencoded' | jq -r '.access_token') && \
  echo '=== model-a after deregistration (should fall back to seed master) ===' && \
  curl -s -w '\nHTTP_CODE:%{http_code}' -H "Authorization: Bearer $TOKEN" \
    'http://localhost:8083/api/transitions/poll?modelId=model-a&executorId=test-exec'; \
fi
DEREGEOF
)
seed_token "p-deregister-cmd" "cmd-deregister" "$(jq -n \
  --arg cmd "$DEREGISTER_CMD" \
  --arg wd "$GW_DIR" \
  '{
    kind: "command",
    id: "cmd-deregister",
    executor: "bash",
    command: "exec",
    args: { command: $cmd, workingDir: $wd, timeoutMs: 30000 },
    expect: "text"
  }')"

ok "All 9 tokens seeded"

# --- Bootstrap context token: p-bootstrap-context (all 9 definitions in one token) ---
info "Seeding bootstrap context token..."

BOOTSTRAP_DEFS=$(jq -n \
  --arg gw_dir "$GW_DIR" \
  --arg ctx_json "$CONTEXT_JSON" \
  --arg register_cmd "$REGISTER_CMD" \
  --arg explicit_cmd "$EXPLICIT_CMD" \
  --arg wildcard_cmd "$WILDCARD_CMD" \
  --arg discover_cmd "$DISCOVER_CMD" \
  --arg executor_cmd "$EXECUTOR_CMD" \
  --arg deregister_cmd "$DEREGISTER_CMD" \
  '{
    definitions: [
      {
        placePath: "/root/workspace/places/p-context",
        tokenName: "context",
        tokenData: ($ctx_json | fromjson)
      },
      {
        placePath: "/root/workspace/places/p-unit-test-cmd",
        tokenName: "cmd-unit-tests",
        tokenData: {
          kind: "command",
          id: "cmd-unit-tests",
          executor: "bash",
          command: "exec",
          args: { command: ("cd " + $gw_dir + " && ./mvnw test 2>&1 | tail -80"), workingDir: $gw_dir, timeoutMs: 120000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-cleanup-cmd",
        tokenName: "cmd-cleanup",
        tokenData: {
          kind: "command",
          id: "cmd-cleanup",
          executor: "bash",
          command: "exec",
          args: { command: "curl -s -X DELETE http://localhost:8083/internal/masters/test-master-1 2>/dev/null; curl -s -X DELETE http://localhost:8083/internal/masters/test-master-2 2>/dev/null; echo '\''=== Current masters ==='\'' && curl -s http://localhost:8083/internal/masters | jq .", workingDir: $gw_dir, timeoutMs: 15000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-register-cmd",
        tokenName: "cmd-register",
        tokenData: {
          kind: "command",
          id: "cmd-register-masters",
          executor: "bash",
          command: "exec",
          args: { command: $register_cmd, workingDir: $gw_dir, timeoutMs: 30000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-explicit-cmd",
        tokenName: "cmd-explicit",
        tokenData: {
          kind: "command",
          id: "cmd-explicit-routing",
          executor: "bash",
          command: "exec",
          args: { command: $explicit_cmd, workingDir: $gw_dir, timeoutMs: 30000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-wildcard-cmd",
        tokenName: "cmd-wildcard",
        tokenData: {
          kind: "command",
          id: "cmd-wildcard-routing",
          executor: "bash",
          command: "exec",
          args: { command: $wildcard_cmd, workingDir: $gw_dir, timeoutMs: 30000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-discover-cmd",
        tokenName: "cmd-discover",
        tokenData: {
          kind: "command",
          id: "cmd-discover-fanout",
          executor: "bash",
          command: "exec",
          args: { command: $discover_cmd, workingDir: $gw_dir, timeoutMs: 30000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-executor-cmd",
        tokenName: "cmd-executor",
        tokenData: {
          kind: "command",
          id: "cmd-executor-fanout",
          executor: "bash",
          command: "exec",
          args: { command: $executor_cmd, workingDir: $gw_dir, timeoutMs: 30000 },
          expect: "text"
        }
      },
      {
        placePath: "/root/workspace/places/p-deregister-cmd",
        tokenName: "cmd-deregister",
        tokenData: {
          kind: "command",
          id: "cmd-deregister",
          executor: "bash",
          command: "exec",
          args: { command: $deregister_cmd, workingDir: $gw_dir, timeoutMs: 30000 },
          expect: "text"
        }
      }
    ]
  }')

seed_token "p-bootstrap-context" "bootstrap-definitions" "$BOOTSTRAP_DEFS"
ok "Bootstrap context token seeded"

# ============================================================================
# Step 6: Create PNML for GUI via Designtime API (session-scoped)
# ============================================================================

info "Creating PNML for GUI visualization (session: ${SESSION_ID})..."

# Create net container via Designtime API (session-scoped)
NET_CREATE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${MASTER_URL}/api/designtime/nets" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg modelId "$MODEL_ID" \
    --arg sessionId "$SESSION_ID" \
    --arg netId "$NET_ID" \
    --arg name "Gateway Routing Verification" \
    '{modelId:$modelId, sessionId:$sessionId, netId:$netId, name:$name}')")

if [ "$NET_CREATE_STATUS" = "200" ] || [ "$NET_CREATE_STATUS" = "201" ]; then
  ok "Net container created in session ${SESSION_ID}"
elif [ "$NET_CREATE_STATUS" = "409" ]; then
  warn "Net container already exists in session ${SESSION_ID}"
else
  warn "Net container creation returned HTTP $NET_CREATE_STATUS (non-fatal)"
fi

# Build batch request with places, transitions, and arcs
BATCH_JSON=$(jq -n \
  --arg modelId "$MODEL_ID" \
  --arg sessionId "$SESSION_ID" \
  '{
    modelId: $modelId,
    sessionId: $sessionId,
    places: [
      {placeId:"p-context",          label:"p-context",          x:400, y:50,   tokens:1},
      {placeId:"p-unit-test-cmd",    label:"p-unit-test-cmd",    x:100, y:150,  tokens:1},
      {placeId:"p-unit-test-result", label:"p-unit-test-result", x:100, y:250,  tokens:0},
      {placeId:"p-unit-test-verdict",label:"p-unit-test-verdict",x:100, y:350,  tokens:0},
      {placeId:"p-cleanup-cmd",      label:"p-cleanup-cmd",      x:300, y:150,  tokens:1},
      {placeId:"p-cleanup-result",   label:"p-cleanup-result",   x:300, y:250,  tokens:0},
      {placeId:"p-register-cmd",     label:"p-register-cmd",     x:300, y:350,  tokens:1},
      {placeId:"p-register-result",  label:"p-register-result",  x:300, y:450,  tokens:0},
      {placeId:"p-register-verdict", label:"p-register-verdict", x:300, y:550,  tokens:0},
      {placeId:"p-explicit-cmd",     label:"p-explicit-cmd",     x:500, y:150,  tokens:1},
      {placeId:"p-explicit-result",  label:"p-explicit-result",  x:500, y:250,  tokens:0},
      {placeId:"p-wildcard-cmd",     label:"p-wildcard-cmd",     x:500, y:350,  tokens:1},
      {placeId:"p-wildcard-result",  label:"p-wildcard-result",  x:500, y:450,  tokens:0},
      {placeId:"p-discover-cmd",     label:"p-discover-cmd",     x:500, y:550,  tokens:1},
      {placeId:"p-discover-result",  label:"p-discover-result",  x:500, y:650,  tokens:0},
      {placeId:"p-executor-cmd",     label:"p-executor-cmd",     x:500, y:750,  tokens:1},
      {placeId:"p-executor-result",  label:"p-executor-result",  x:500, y:850,  tokens:0},
      {placeId:"p-routing-verdict",  label:"p-routing-verdict",  x:500, y:950,  tokens:0},
      {placeId:"p-deregister-cmd",   label:"p-deregister-cmd",   x:700, y:150,  tokens:1},
      {placeId:"p-deregister-result",label:"p-deregister-result",x:700, y:250,  tokens:0},
      {placeId:"p-final-verdict",    label:"p-final-verdict",    x:700, y:450,  tokens:0},
      {placeId:"p-bootstrap-context",label:"p-bootstrap-context",x:100, y:500,  tokens:1},
      {placeId:"p-bootstrap-result", label:"p-bootstrap-result", x:100, y:700,  tokens:0}
    ],
    transitions: [
      {transitionId:"t-run-unit-tests",    label:"t-run-unit-tests",    x:100, y:200},
      {transitionId:"t-verify-unit-tests", label:"t-verify-unit-tests", x:100, y:300},
      {transitionId:"t-cleanup",           label:"t-cleanup",           x:300, y:200},
      {transitionId:"t-register",          label:"t-register",          x:300, y:400},
      {transitionId:"t-verify-reg",        label:"t-verify-reg",        x:300, y:500},
      {transitionId:"t-test-explicit",     label:"t-test-explicit",     x:500, y:200},
      {transitionId:"t-test-wildcard",     label:"t-test-wildcard",     x:500, y:400},
      {transitionId:"t-test-discover",     label:"t-test-discover",     x:500, y:600},
      {transitionId:"t-test-executor",     label:"t-test-executor",     x:500, y:800},
      {transitionId:"t-verify-routing",    label:"t-verify-routing",    x:500, y:950},
      {transitionId:"t-deregister",        label:"t-deregister",        x:700, y:200},
      {transitionId:"t-final-verdict",     label:"t-final-verdict",     x:700, y:350},
      {transitionId:"t-bootstrap",         label:"t-bootstrap",         x:100, y:600}
    ],
    arcs: [
      {arcId:"a-1",  sourceId:"p-unit-test-cmd",     targetId:"t-run-unit-tests"},
      {arcId:"a-2",  sourceId:"t-run-unit-tests",    targetId:"p-unit-test-result"},
      {arcId:"a-3",  sourceId:"p-unit-test-result",  targetId:"t-verify-unit-tests"},
      {arcId:"a-4",  sourceId:"p-context",           targetId:"t-verify-unit-tests"},
      {arcId:"a-5",  sourceId:"t-verify-unit-tests", targetId:"p-unit-test-verdict"},
      {arcId:"a-6",  sourceId:"p-cleanup-cmd",       targetId:"t-cleanup"},
      {arcId:"a-7",  sourceId:"t-cleanup",           targetId:"p-cleanup-result"},
      {arcId:"a-8",  sourceId:"p-register-cmd",      targetId:"t-register"},
      {arcId:"a-9",  sourceId:"p-cleanup-result",    targetId:"t-register"},
      {arcId:"a-10", sourceId:"t-register",          targetId:"p-register-result"},
      {arcId:"a-11", sourceId:"p-register-result",   targetId:"t-verify-reg"},
      {arcId:"a-12", sourceId:"p-context",           targetId:"t-verify-reg"},
      {arcId:"a-13", sourceId:"t-verify-reg",        targetId:"p-register-verdict"},
      {arcId:"a-14", sourceId:"p-explicit-cmd",      targetId:"t-test-explicit"},
      {arcId:"a-15", sourceId:"p-register-verdict",  targetId:"t-test-explicit"},
      {arcId:"a-16", sourceId:"t-test-explicit",     targetId:"p-explicit-result"},
      {arcId:"a-17", sourceId:"p-wildcard-cmd",      targetId:"t-test-wildcard"},
      {arcId:"a-18", sourceId:"p-register-verdict",  targetId:"t-test-wildcard"},
      {arcId:"a-19", sourceId:"t-test-wildcard",     targetId:"p-wildcard-result"},
      {arcId:"a-20", sourceId:"p-discover-cmd",      targetId:"t-test-discover"},
      {arcId:"a-21", sourceId:"p-register-verdict",  targetId:"t-test-discover"},
      {arcId:"a-22", sourceId:"t-test-discover",     targetId:"p-discover-result"},
      {arcId:"a-23", sourceId:"p-executor-cmd",      targetId:"t-test-executor"},
      {arcId:"a-24", sourceId:"p-register-verdict",  targetId:"t-test-executor"},
      {arcId:"a-25", sourceId:"t-test-executor",     targetId:"p-executor-result"},
      {arcId:"a-26", sourceId:"p-explicit-result",   targetId:"t-verify-routing"},
      {arcId:"a-27", sourceId:"p-wildcard-result",   targetId:"t-verify-routing"},
      {arcId:"a-28", sourceId:"p-discover-result",   targetId:"t-verify-routing"},
      {arcId:"a-29", sourceId:"p-executor-result",   targetId:"t-verify-routing"},
      {arcId:"a-30", sourceId:"p-context",           targetId:"t-verify-routing"},
      {arcId:"a-31", sourceId:"t-verify-routing",    targetId:"p-routing-verdict"},
      {arcId:"a-32", sourceId:"p-deregister-cmd",    targetId:"t-deregister"},
      {arcId:"a-33", sourceId:"p-routing-verdict",   targetId:"t-deregister"},
      {arcId:"a-34", sourceId:"t-deregister",        targetId:"p-deregister-result"},
      {arcId:"a-35", sourceId:"p-unit-test-verdict",  targetId:"t-final-verdict"},
      {arcId:"a-36", sourceId:"p-routing-verdict",    targetId:"t-final-verdict"},
      {arcId:"a-37", sourceId:"p-deregister-result",  targetId:"t-final-verdict"},
      {arcId:"a-38", sourceId:"p-context",            targetId:"t-final-verdict"},
      {arcId:"a-39", sourceId:"t-final-verdict",      targetId:"p-final-verdict"},
      {arcId:"a-40", sourceId:"p-bootstrap-context",   targetId:"t-bootstrap"},
      {arcId:"a-41", sourceId:"t-bootstrap",            targetId:"p-bootstrap-result"}
    ]
  }')

BATCH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${MASTER_URL}/api/designtime/nets/${NET_ID}/batch" \
  -H "Content-Type: application/json" \
  -d "$BATCH_JSON")

if [ "$BATCH_STATUS" = "200" ] || [ "$BATCH_STATUS" = "201" ]; then
  ok "PNML batch created (23 places, 13 transitions, 41 arcs) in session ${SESSION_ID}"
else
  warn "PNML batch returned HTTP $BATCH_STATUS (non-fatal — net still works without GUI)"
fi

# ============================================================================
# Step 7: Start all transitions
# ============================================================================

info "Starting all transitions..."

for tid in \
  t-run-unit-tests t-verify-unit-tests \
  t-cleanup t-register t-verify-reg \
  t-test-explicit t-test-wildcard t-test-discover t-test-executor \
  t-verify-routing \
  t-deregister t-final-verdict \
  t-bootstrap; do

  start_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${MASTER_URL}/api/runtime/transitions/${tid}/start?modelId=${MODEL_ID}" \
    -H "Content-Type: application/json" 2>/dev/null || echo "000")

  if [ "$start_code" = "200" ] || [ "$start_code" = "201" ]; then
    ok "  Started: $tid"
  else
    warn "  Could not start: $tid (HTTP $start_code)"
  fi
done

ok "Transition startup complete"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "============================================"
echo "  Setup Complete"
echo "============================================"
echo ""
info "Model:       ${MODEL_ID}"
info "Session:     ${SESSION_ID}"
info "Net:         ${NET_ID}"
info "Places:      23"
info "Transitions: 13"
info "Tokens:      10 (9 command + 1 bootstrap context)"
echo ""
info "Place UUIDs:"
while IFS='=' read -r name uuid; do
  printf "  %-25s %s\n" "$name" "$uuid"
done < "$PLACE_MAP"
echo ""
info "Monitor commands:"
echo ""
echo "  # List all transitions"
echo "  curl -s '${MASTER_URL}/api/runtime/transitions?modelId=${MODEL_ID}' | jq '.'"
echo ""
echo "  # Check final verdict"
echo "  curl -s '${NODE_URL}/api/models/${MODEL_ID}/children?parentId=$(get_place p-final-verdict)' | jq '.'"
echo ""
echo "  # Check unit test verdict"
echo "  curl -s '${NODE_URL}/api/models/${MODEL_ID}/children?parentId=$(get_place p-unit-test-verdict)' | jq '.'"
echo ""
echo "  # Check routing verdict"
echo "  curl -s '${NODE_URL}/api/models/${MODEL_ID}/children?parentId=$(get_place p-routing-verdict)' | jq '.'"
echo ""
echo "  # GUI: Open http://localhost:4200 → model agenticdev → session dev"
echo ""
echo "  # Cleanup (delete entire model)"
echo "  curl -X DELETE '${NODE_URL}/api/admin/models/${MODEL_ID}'"
echo ""
