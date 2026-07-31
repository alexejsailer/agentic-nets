#!/usr/bin/env bash
# Populate closed-artifacts/ (agentic-net-node.jar, agentic-net-master.jar, gui/)
# for the desktop bundle. Three sources, in order of preference:
#
#   source   the private core/ tree — only inside the maintainer workspace
#   release  the standalone binaries attached to the GitHub release
#            (agentic-net-{node,master}-<v>.jar + agentic-net-gui-<v>.zip,
#            verified against the release's SHA256SUMS.txt; no Docker needed)
#   images   extracted from the published Docker Hub images
#
# Default: source when core/ exists; otherwise release with automatic fallback
# to images. Force with AGENTICOS_CLOSED_FROM=source|release|images.
# All closed binaries are governed by ../PROPRIETARY-EULA.md.
#
# Usage: fetch-closed-artifacts.sh [version|latest]     (default: latest)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(dirname "$SCRIPT_DIR")"
NETS_DIR="$(dirname "$MODULE_DIR")"
WORKSPACE="$(dirname "$NETS_DIR")"
CLOSED_DIR="${AGENTICOS_CLOSED_DIR:-$MODULE_DIR/closed-artifacts}"
RELEASE_BASE="${AGENTICOS_RELEASE_BASE:-https://github.com/alexejsailer/agentic-nets/releases/download}"
TAG="${1:-latest}"

log() { printf '\033[1;33m[closed-artifacts]\033[0m %s\n' "$*"; }
mkdir -p "$CLOSED_DIR"

sha256_of() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

fetch_from_source() {
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
}

resolve_release_version() {
  if [ "$TAG" = "latest" ]; then
    curl -fsSL "https://api.github.com/repos/alexejsailer/agentic-nets/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[^"]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1
  else
    echo "${TAG#v}"
  fi
}

fetch_from_release() {
  local ver base tmp expected actual
  ver="$(resolve_release_version)"
  [ -n "$ver" ] || return 1
  base="$RELEASE_BASE/v$ver"
  tmp="$(mktemp -d)"
  log "trying release assets v$ver"
  curl -fsSL "$base/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  for f in "agentic-net-node-$ver.jar" "agentic-net-master-$ver.jar" "agentic-net-gui-$ver.zip"; do
    curl -fsSL "$base/$f" -o "$tmp/$f" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    expected=$(awk -v n="$f" '$NF==n{print $1}' "$tmp/SHA256SUMS.txt")
    actual=$(sha256_of "$tmp/$f")
    [ -n "$expected" ] && [ "$expected" = "$actual" ] \
      || { echo "checksum mismatch for $f — discarding" >&2; rm -rf "$tmp"; return 1; }
  done
  cp "$tmp/agentic-net-node-$ver.jar"   "$CLOSED_DIR/agentic-net-node.jar"
  cp "$tmp/agentic-net-master-$ver.jar" "$CLOSED_DIR/agentic-net-master.jar"
  rm -rf "$CLOSED_DIR/gui"
  mkdir -p "$CLOSED_DIR/gui"
  unzip -q "$tmp/agentic-net-gui-$ver.zip" -d "$CLOSED_DIR/gui"
  rm -rf "$tmp"
  log "release assets v$ver verified"
}

fetch_from_images() {
  command -v docker >/dev/null || { echo "docker is required for the image source" >&2; return 1; }
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
}

MODE="${AGENTICOS_CLOSED_FROM:-auto}"
case "$MODE" in
  source)  fetch_from_source ;;
  release) fetch_from_release || { echo "release assets unavailable for '$TAG'" >&2; exit 1; } ;;
  images)  fetch_from_images ;;
  auto)
    if [ -d "$WORKSPACE/core/agentic-net-node" ]; then
      fetch_from_source
    elif fetch_from_release; then
      :
    else
      log "release assets unavailable — falling back to Docker images"
      fetch_from_images
    fi
    ;;
  *) echo "AGENTICOS_CLOSED_FROM must be source|release|images" >&2; exit 1 ;;
esac

log "ready: $(ls "$CLOSED_DIR" | tr '\n' ' ')"
