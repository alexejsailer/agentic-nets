#!/usr/bin/env bash
# =============================================================================
# AgenticNetOS — Update Image Versions in Compose Files
#
# Updates deployment defaults to a specific version. Run this after promoting
# images to Docker Hub.
#
# In docker-compose*.yml: AGENTICNETOS_VERSION defaults get the new version tag.
# In .env.template: AGENTICNETOS_VERSION gets the same version.
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

COMPOSE_FILES=(
  "${DEPLOY_DIR}/docker-compose.yml"
  "${DEPLOY_DIR}/docker-compose.hub-only.yml"
  "${DEPLOY_DIR}/docker-compose.hub-only.no-monitoring.yml"
)
ENV_TEMPLATE="${DEPLOY_DIR}/.env.template"

ALL_SERVICES=(node master executor gateway gui cli chat blobstore vault)

sed_in_place() {
  local expr="$1"
  local file="$2"
  if sed --version >/dev/null 2>&1; then
    sed -i "$expr" "$file"
  else
    sed -i '' "$expr" "$file"
  fi
}

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

# --- Update compose files ---
for compose_file in "${COMPOSE_FILES[@]}"; do
  if [[ -f "$compose_file" ]]; then
    # Current compose files use image: alexejsailer/agenticnetos-foo:${AGENTICNETOS_VERSION:-X.Y.Z}
    sed_in_place "s|AGENTICNETOS_VERSION:-[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*|AGENTICNETOS_VERSION:-${VERSION}|g" "$compose_file"

    # Fallback for static tags that may appear in future compose files. Skip
    # version-variable lines; otherwise this would turn
    # repo:${AGENTICNETOS_VERSION:-X.Y.Z} into repo:VERSION${...}.
    for svc in "${ALL_SERVICES[@]}"; do
      sed_in_place "/AGENTICNETOS_VERSION/!s|alexejsailer/agenticnetos-${svc}:[a-zA-Z0-9._-]*|alexejsailer/agenticnetos-${svc}:${VERSION}|g" "$compose_file"
    done
    echo "  Updated $(basename "$compose_file")"
  else
    echo "  Warning: $(basename "$compose_file") not found"
  fi
done

# --- Update env template ---
if [[ -f "$ENV_TEMPLATE" ]]; then
  sed_in_place "s|^AGENTICNETOS_VERSION=.*|AGENTICNETOS_VERSION=${VERSION}|" "$ENV_TEMPLATE"
  echo "  Updated .env.template"
else
  echo "  Warning: .env.template not found"
fi

echo ""
echo "Done. Commit the updated deployment defaults to agentic-nets."
