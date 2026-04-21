#!/bin/bash
# Build all AgenticNetOS tool images and push to the local registry.
#
# Usage:
#   ./build-and-push.sh                         # Build + push all tools using Dockerfile label version
#   ./build-and-push.sh --tag 2.1.8             # Build + push all tools with release tag
#   ./build-and-push.sh agenticos-tool-echo     # Build + push specific tool
#   ./build-and-push.sh --tag 2.1.8 agenticos-tool-echo
#   REGISTRY=localhost:5001 ./build-and-push.sh

set -euo pipefail

REGISTRY="${REGISTRY:-localhost:5001}"
VERSION="${VERSION:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag|--version)
            VERSION="$2"
            shift 2
            ;;
        -*)
            echo "Unknown flag: $1" >&2
            exit 1
            ;;
        *)
            if [[ "$1" =~ ^[0-9]+(\.[0-9]+)*([._-][A-Za-z0-9]+)?$ && -z "$VERSION" && -z "$TARGET" ]]; then
                VERSION="$1"
            else
                TARGET="$1"
            fi
            shift
            ;;
    esac
done

build_and_push() {
    local dir="$1"
    local name="$(basename "$dir")"

    if [ ! -f "$dir/Dockerfile" ]; then
        echo "  Skipping $name (no Dockerfile)"
        return
    fi

    # Extract version from Dockerfile label or default to "latest"
    local label_version
    label_version=$(sed -n 's/^LABEL org\.opencontainers\.image\.version="\([^"]*\)".*/\1/p' "$dir/Dockerfile" | head -n 1)
    label_version="${label_version:-latest}"
    local image_version="${VERSION:-$label_version}"

    echo "Building $name:$image_version..."
    docker build -t "$REGISTRY/$name:$image_version" -t "$REGISTRY/$name:latest" "$dir"

    echo "Pushing $REGISTRY/$name:$image_version..."
    docker push "$REGISTRY/$name:$image_version"
    docker push "$REGISTRY/$name:latest"

    echo "  Done: $REGISTRY/$name:$image_version"
}

echo "=== AgenticNetOS Tool Image Builder ==="
echo "Registry: $REGISTRY"
echo "Version:  ${VERSION:-Dockerfile labels}"
echo ""

if [ -n "$TARGET" ]; then
    # Build specific tool
    if [ -d "$SCRIPT_DIR/$TARGET" ]; then
        build_and_push "$SCRIPT_DIR/$TARGET"
    else
        echo "Error: Tool directory '$TARGET' not found"
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
