#!/usr/bin/env bash
# =============================================================================
# AgenticOS — Update Image Versions in Compose Files
#
# Updates all alexejsailer/agenticos-* image tags in the deployment compose
# files to a specific version. Run this after promoting images to Docker Hub.
#
# In docker-compose.hub-only.yml: ALL images get the new version tag.
# In docker-compose.yml (hybrid): Only core images (node, master, gui) get
#   the new version tag; open-source services keep :latest (built locally).
#
# Usage:
#   ./scripts/update-versions.sh <version>
#   ./scripts/update-versions.sh 1.3.0
#
# Or reads from ../../ci/VERSION if no argument given.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HUB_ONLY="${DEPLOY_DIR}/docker-compose.hub-only.yml"
HYBRID="${DEPLOY_DIR}/docker-compose.yml"

ALL_SERVICES=(node master executor gateway gui cli chat blobstore vault)
CORE_SERVICES=(node master gui)

# --- Parse version ---
VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  # Try to read from ci/VERSION
  VERSION_FILE="$(cd "$DEPLOY_DIR/../.." 2>/dev/null && pwd)/ci/VERSION"
  if [[ -f "$VERSION_FILE" ]]; then
    VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")
  else
    echo "Usage: $0 <version>"
    echo "  Or create ci/VERSION file in the project root"
    exit 1
  fi
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be semver (e.g., 1.2.0), got: $VERSION" >&2
  exit 1
fi

echo "Updating compose files to version ${VERSION}"
echo ""

# --- Update hub-only (all services) ---
if [[ -f "$HUB_ONLY" ]]; then
  for svc in "${ALL_SERVICES[@]}"; do
    # Match alexejsailer/agenticos-{svc}:{any-tag} and replace tag
    sed -i '' "s|alexejsailer/agenticos-${svc}:[a-zA-Z0-9._-]*|alexejsailer/agenticos-${svc}:${VERSION}|g" "$HUB_ONLY"
  done
  echo "  Updated docker-compose.hub-only.yml (all services → ${VERSION})"
else
  echo "  Warning: docker-compose.hub-only.yml not found"
fi

# --- Update hybrid (core services only) ---
if [[ -f "$HYBRID" ]]; then
  for svc in "${CORE_SERVICES[@]}"; do
    sed -i '' "s|alexejsailer/agenticos-${svc}:[a-zA-Z0-9._-]*|alexejsailer/agenticos-${svc}:${VERSION}|g" "$HYBRID"
  done
  echo "  Updated docker-compose.yml (core: node, master, gui → ${VERSION})"
else
  echo "  Warning: docker-compose.yml not found"
fi

echo ""
echo "Done. Commit the updated compose files to agentic-nets."
