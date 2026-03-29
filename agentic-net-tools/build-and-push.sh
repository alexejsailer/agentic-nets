#!/bin/bash
# Build all AgenticNetOS tool images and push to the local registry.
#
# Usage:
#   ./build-and-push.sh                    # Build + push all tools
#   ./build-and-push.sh agenticos-tool-echo   # Build + push specific tool
#   REGISTRY=localhost:5001 ./build-and-push.sh

set -euo pipefail

REGISTRY="${REGISTRY:-localhost:5001}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

build_and_push() {
    local dir="$1"
    local name="$(basename "$dir")"

    if [ ! -f "$dir/Dockerfile" ]; then
        echo "  Skipping $name (no Dockerfile)"
        return
    fi

    # Extract version from Dockerfile label or default to "latest"
    local version
    version=$(grep -oP 'LABEL org.opencontainers.image.version="\K[^"]+' "$dir/Dockerfile" 2>/dev/null || echo "latest")

    echo "Building $name:$version..."
    docker build -t "$REGISTRY/$name:$version" -t "$REGISTRY/$name:latest" "$dir"

    echo "Pushing $REGISTRY/$name:$version..."
    docker push "$REGISTRY/$name:$version"
    docker push "$REGISTRY/$name:latest"

    echo "  Done: $REGISTRY/$name:$version"
}

echo "=== AgenticNetOS Tool Image Builder ==="
echo "Registry: $REGISTRY"
echo ""

if [ $# -gt 0 ]; then
    # Build specific tool
    target="$1"
    if [ -d "$SCRIPT_DIR/$target" ]; then
        build_and_push "$SCRIPT_DIR/$target"
    else
        echo "Error: Tool directory '$target' not found"
        exit 1
    fi
else
    # Build all tools
    for dir in "$SCRIPT_DIR"/agenticos-tool-*/; do
        [ -d "$dir" ] && build_and_push "$dir"
    done
fi

echo ""
echo "=== All done ==="
echo "Verify: curl http://$REGISTRY/v2/_catalog"
