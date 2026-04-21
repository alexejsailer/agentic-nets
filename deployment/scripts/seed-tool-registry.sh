#!/bin/sh
# Mirror approved AgenticOS tool images into the local registry used by agents.
#
# Default mode pulls Docker Hub images and retags them into localhost:5001.
# For local development, set AGENTICOS_TOOL_SEED_MODE=build to build from
# ../agentic-net-tools instead.
set -eu

REGISTRY_HOST="${AGENTICOS_TOOL_REGISTRY_HOST:-localhost:${AGENTICNETOS_REGISTRY_PORT:-5001}}"
SOURCE_REGISTRY="${AGENTICOS_TOOL_SOURCE_REGISTRY:-docker.io/alexejsailer}"
VERSION="${AGENTICOS_TOOL_SEED_TAG:-${AGENTICNETOS_VERSION:-latest}}"
FALLBACK_TAG="${AGENTICOS_TOOL_SEED_FALLBACK_TAG:-latest}"
MODE="${AGENTICOS_TOOL_SEED_MODE:-mirror}"
SOURCE_DIR="${AGENTICOS_TOOL_SOURCE_DIR:-../agentic-net-tools}"
TOOLS="${AGENTICOS_TOOL_SEED_IMAGES:-agenticos-tool-echo agenticos-tool-crawler agenticos-tool-rss agenticos-tool-search agenticos-tool-reddit agenticos-tool-secured-api}"

echo "=== AgenticOS Tool Registry Seeder ==="
echo "Registry: ${REGISTRY_HOST}"
echo "Mode:     ${MODE}"
echo "Version:  ${VERSION}"
echo "Tools:    ${TOOLS}"
echo ""

seed_from_hub() {
  tool="$1"
  source_image="${SOURCE_REGISTRY}/${tool}:${VERSION}"
  pulled_image="$source_image"

  echo "--- Mirroring ${tool} ---"
  if ! docker pull "$source_image"; then
    if [ "$FALLBACK_TAG" != "$VERSION" ]; then
      pulled_image="${SOURCE_REGISTRY}/${tool}:${FALLBACK_TAG}"
      echo "Version tag not found, trying fallback: ${pulled_image}"
      docker pull "$pulled_image"
    else
      echo "Failed to pull ${source_image}" >&2
      return 1
    fi
  fi

  docker tag "$pulled_image" "${REGISTRY_HOST}/${tool}:${VERSION}"
  docker tag "$pulled_image" "${REGISTRY_HOST}/${tool}:latest"
  docker push "${REGISTRY_HOST}/${tool}:${VERSION}"
  docker push "${REGISTRY_HOST}/${tool}:latest"
  echo "Seeded ${REGISTRY_HOST}/${tool}:{${VERSION},latest}"
  echo ""
}

seed_from_source() {
  tool="$1"
  context="${SOURCE_DIR}/${tool}"

  echo "--- Building ${tool} ---"
  if [ ! -f "${context}/Dockerfile" ]; then
    echo "Missing Dockerfile: ${context}/Dockerfile" >&2
    return 1
  fi

  docker build \
    -t "${REGISTRY_HOST}/${tool}:${VERSION}" \
    -t "${REGISTRY_HOST}/${tool}:latest" \
    "$context"
  docker push "${REGISTRY_HOST}/${tool}:${VERSION}"
  docker push "${REGISTRY_HOST}/${tool}:latest"
  echo "Seeded ${REGISTRY_HOST}/${tool}:{${VERSION},latest}"
  echo ""
}

for tool in $TOOLS; do
  case "$MODE" in
    mirror) seed_from_hub "$tool" ;;
    build) seed_from_source "$tool" ;;
    *)
      echo "Unsupported AGENTICOS_TOOL_SEED_MODE: ${MODE}" >&2
      echo "Use mirror or build." >&2
      exit 1
      ;;
  esac
done

echo "=== Tool registry ready ==="
echo "Verify: curl http://${REGISTRY_HOST}/v2/_catalog"
