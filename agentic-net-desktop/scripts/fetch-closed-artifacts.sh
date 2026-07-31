#!/usr/bin/env bash
# Populate closed-artifacts/ (agentic-net-node.jar, agentic-net-master.jar, gui/)
# for the desktop bundle. Two sources:
#
#   1. The private core/ source tree, when this checkout sits inside the
#      maintainer workspace (../../core exists).
#   2. The published Docker Hub images (public clone) — the same closed-source
#      binaries every deployment runs, governed by PROPRIETARY-EULA.md.
#
# Usage: fetch-closed-artifacts.sh [image-tag]      (default tag: latest)
#   AGENTICOS_CLOSED_FROM=images   force the image path even when core/ exists
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(dirname "$SCRIPT_DIR")"
NETS_DIR="$(dirname "$MODULE_DIR")"
WORKSPACE="$(dirname "$NETS_DIR")"
CLOSED_DIR="${AGENTICOS_CLOSED_DIR:-$MODULE_DIR/closed-artifacts}"
TAG="${1:-latest}"

log() { printf '\033[1;33m[closed-artifacts]\033[0m %s\n' "$*"; }
mkdir -p "$CLOSED_DIR"

if [ -d "$WORKSPACE/core/agentic-net-node" ] && [ "${AGENTICOS_CLOSED_FROM:-source}" != "images" ]; then
  log "building from private source tree ($WORKSPACE/core)"
  (cd "$WORKSPACE/core/agentic-net-node"   && ./mvnw -q clean package -DskipTests)
  (cd "$WORKSPACE/core/agentic-net-master" && ./mvnw -q clean package -DskipTests)
  (cd "$WORKSPACE/core/agentic-net-gui" && { [ -d node_modules ] || npm install; } \
    && npm run build -- --configuration production)
  cp "$WORKSPACE/core/agentic-net-node/target/agentic-net-node-"*.jar     "$CLOSED_DIR/agentic-net-node.jar"
  cp "$WORKSPACE/core/agentic-net-master/target/agentic-net-master-"*.jar "$CLOSED_DIR/agentic-net-master.jar"
  rm -rf "$CLOSED_DIR/gui"
  mkdir -p "$CLOSED_DIR/gui"
  cp -R "$WORKSPACE/core/agentic-net-gui/dist/agentic-net-gui/browser/." "$CLOSED_DIR/gui/"
else
  command -v docker >/dev/null || { echo "docker is required to pull the closed images" >&2; exit 1; }
  for svc in node master; do
    log "extracting alexejsailer/agenticnetos-$svc:$TAG"
    docker pull -q "alexejsailer/agenticnetos-$svc:$TAG" >/dev/null
    cid=$(docker create "alexejsailer/agenticnetos-$svc:$TAG")
    docker cp -q "$cid:/app/app.jar" "$CLOSED_DIR/agentic-net-$svc.jar"
    docker rm "$cid" >/dev/null
  done
  log "extracting alexejsailer/agenticnetos-gui:$TAG"
  docker pull -q "alexejsailer/agenticnetos-gui:$TAG" >/dev/null
  cid=$(docker create "alexejsailer/agenticnetos-gui:$TAG")
  rm -rf "$CLOSED_DIR/gui"
  docker cp -q "$cid:/usr/share/nginx/html" "$CLOSED_DIR/gui"
  docker rm "$cid" >/dev/null
fi

log "ready: $(ls "$CLOSED_DIR")"
