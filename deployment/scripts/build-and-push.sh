#!/usr/bin/env bash
# =============================================================================
# AgetnticOS Agentic-Nets — Build & Push Open-Source Images
#
# Builds, tags, and pushes open-source AgetnticOS images to Docker Hub.
# Only includes services whose source is in this repository.
#
# Usage:
#   ./scripts/build-and-push.sh <version> [--dry-run] [--only <service>]
#
# Examples:
#   ./scripts/build-and-push.sh 1.0.0
#   ./scripts/build-and-push.sh 1.0.0 --dry-run
#   ./scripts/build-and-push.sh 1.0.0 --only gateway
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
DOCKERFILES_DIR="$DEPLOY_DIR/dockerfiles"

HUB_PREFIX="alexejsailer/agenticos"

# Image matrix: service -> build_context (relative to REPO_ROOT), dockerfile
declare -A CONTEXTS=(
  [gateway]="agentic-net-gateway"
  [executor]="agentic-net-executor"
  [vault]="agentic-net-vault"
  [cli]="agentic-net-cli"
  [chat]="."
  [blobstore]="sa-blobstore"
)

declare -A DOCKERFILES=(
  [gateway]="Dockerfile.agentic-net-gateway"
  [executor]="Dockerfile.agentic-net-executor"
  [vault]="Dockerfile.agentic-net-vault"
  [cli]="Dockerfile.agentic-net-cli"
  [chat]="Dockerfile.agentic-net-chat"
  [blobstore]="Dockerfile.sa-blobstore"
)

SERVICES=(gateway executor vault cli chat blobstore)

# --- Parse arguments ---
VERSION=""
DRY_RUN=false
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --only)    ONLY="$2"; shift 2 ;;
    -*)        echo "Unknown flag: $1" >&2; exit 1 ;;
    *)         VERSION="$1"; shift ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [--dry-run] [--only <service>]"
  echo "Services: ${SERVICES[*]}"
  exit 1
fi

# Validate --only service
if [[ -n "$ONLY" ]]; then
  valid=false
  for svc in "${SERVICES[@]}"; do
    [[ "$svc" == "$ONLY" ]] && valid=true
  done
  if ! $valid; then
    echo "Error: Unknown service '$ONLY'. Available: ${SERVICES[*]}" >&2
    exit 1
  fi
  SERVICES=("$ONLY")
fi

# --- Pre-flight checks ---
if ! command -v docker &>/dev/null; then
  echo "Error: docker is not installed" >&2
  exit 1
fi

if ! $DRY_RUN; then
  if ! docker info &>/dev/null 2>&1; then
    echo "Error: Docker daemon is not running" >&2
    exit 1
  fi
fi

echo "============================================"
echo "AgetnticOS Agentic-Nets — Build & Push"
echo "  Version:  $VERSION"
echo "  Dry run:  $DRY_RUN"
echo "  Services: ${SERVICES[*]}"
echo "============================================"
echo ""

BUILT=()
FAILED=()

for svc in "${SERVICES[@]}"; do
  image="${HUB_PREFIX}-${svc}"
  context="${REPO_ROOT}/${CONTEXTS[$svc]}"
  dockerfile="${DOCKERFILES_DIR}/${DOCKERFILES[$svc]}"

  echo "--- Building $image ---"
  echo "  Context:    $context"
  echo "  Dockerfile: $dockerfile"
  echo "  Tags:       ${image}:${VERSION}, ${image}:latest"

  if ! docker build \
    -t "${image}:${VERSION}" \
    -t "${image}:latest" \
    -f "$dockerfile" \
    "$context"; then
    echo "  FAILED to build $image" >&2
    FAILED+=("$svc")
    continue
  fi

  BUILT+=("$svc")

  if $DRY_RUN; then
    echo "  [dry-run] Skipping push for $image"
  else
    echo "  Pushing ${image}:${VERSION} ..."
    docker push "${image}:${VERSION}"
    echo "  Pushing ${image}:latest ..."
    docker push "${image}:latest"
  fi

  echo ""
done

# --- Summary ---
echo "============================================"
echo "Build Summary"
echo "============================================"

if [[ ${#BUILT[@]} -gt 0 ]]; then
  echo "  Built:  ${BUILT[*]}"
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "  Failed: ${FAILED[*]}"
fi

if $DRY_RUN; then
  echo ""
  echo "  (Dry run — no images were pushed)"
fi

echo ""

if [[ ${#FAILED[@]} -gt 0 ]]; then
  exit 1
fi

echo "Done."
