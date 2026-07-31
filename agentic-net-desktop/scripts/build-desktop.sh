#!/usr/bin/env bash
# Build the self-contained AgenticNetOS Desktop app image for macOS (and optionally a .dmg).
# For a one-command clone-and-build on any OS use build.sh; for Linux cross-builds from
# macOS see package-desktop-linux.sh (Docker-based — jpackage cannot cross-build).
#
# Closed components (node, master, gui) come via fetch-closed-artifacts.sh: built from
# ../core when this checkout sits in the maintainer workspace, otherwise extracted from
# the published Docker Hub images.
#
# Layout produced under dist/ (override the dist dir with AGENTICOS_DESKTOP_DIST so a
# release build never wipes a dist/ the running app was launched from):
#   dist/app/                jpackage input: launcher.jar, services/*.jar, gui/, mcp/, node-runtime/
#   dist/runtime/            jlink'd Java runtime shared by launcher + all Java services
#   dist/out/AgenticNetOS.app                        (--type app-image, default)
#   dist/out/AgenticNetOS-<v>-macos-<arch>.dmg       (with --dmg) + SHA256SUMS.txt
#
# Usage: build-desktop.sh [version] [--skip-builds] [--dmg]
#   version       app version (default: ci/VERSION in the workspace, else newest git tag)
#   --skip-builds reuse existing jars / gui dist / mcp dist / closed artifacts
#   --dmg         also produce the .dmg installer (EULA embedded as license agreement)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(dirname "$SCRIPT_DIR")"                 # agentic-nets/agentic-net-desktop
NETS_DIR="$(dirname "$MODULE_DIR")"                   # agentic-nets/
DIST="${AGENTICOS_DESKTOP_DIST:-$MODULE_DIR/dist}"

source "$SCRIPT_DIR/lib-assemble.sh"

VERSION="$(default_version)"
SKIP_BUILDS=false
MAKE_DMG=false
for arg in "$@"; do
  case "$arg" in
    --skip-builds) SKIP_BUILDS=true ;;
    --dmg)         MAKE_DMG=true ;;
    *)             VERSION="$arg" ;;
  esac
done

log() { printf '\n\033[1;34m[desktop-build]\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Build open components + fetch closed artifacts
# ---------------------------------------------------------------------------
if ! $SKIP_BUILDS; then
  log "Building open components"
  build_open_components
  log "Fetching closed artifacts"
  "$SCRIPT_DIR/fetch-closed-artifacts.sh" "$VERSION"
fi

# ---------------------------------------------------------------------------
# 2. Assemble the jpackage input dir (macOS Node runtime)
# ---------------------------------------------------------------------------
log "Assembling app dir"
case "$(uname -m)" in
  arm64)  NODE_PLATFORM="darwin-arm64" ;;
  x86_64) NODE_PLATFORM="darwin-x64" ;;
  *) echo "Unsupported mac arch $(uname -m)" >&2; exit 1 ;;
esac
assemble_app_dir "$DIST/app" "$NODE_PLATFORM" "$DIST/cache"

# ---------------------------------------------------------------------------
# 3. jlink runtime (shared by launcher + all Java services)
# ---------------------------------------------------------------------------
log "Building jlink runtime"
rm -rf "$DIST/runtime"
jlink \
  --add-modules "$JLINK_MODULES" \
  --output "$DIST/runtime" \
  --no-header-files --no-man-pages --compress zip-6

# ---------------------------------------------------------------------------
# 4. jpackage (Developer ID signing activates when the identity is configured)
# ---------------------------------------------------------------------------
MAC_SIGN_ARGS=()
if [ -n "${AGENTICOS_MAC_SIGN_IDENTITY:-}" ]; then
  MAC_SIGN_ARGS=(--mac-sign --mac-signing-key-user-name "$AGENTICOS_MAC_SIGN_IDENTITY")
  log "Code signing as: $AGENTICOS_MAC_SIGN_IDENTITY"
else
  log "AGENTICOS_MAC_SIGN_IDENTITY not set — building UNSIGNED (Gatekeeper will warn users)"
fi

log "Packaging app image v$VERSION"
rm -rf "$DIST/out"
jpackage \
  --type app-image \
  --name "AgenticNetOS" \
  --app-version "$VERSION" \
  --vendor "Alexej Sailer" \
  --input "$DIST/app" \
  --runtime-image "$DIST/runtime" \
  --main-jar launcher.jar \
  --main-class com.sailer.agenticos.desktop.Main \
  --java-options "-Dagenticos.desktop.version=$VERSION" \
  ${MAC_SIGN_ARGS[@]+"${MAC_SIGN_ARGS[@]}"} \
  --dest "$DIST/out"

if $MAKE_DMG; then
  log "Packaging dmg"
  jpackage \
    --type dmg \
    --name "AgenticNetOS" \
    --app-version "$VERSION" \
    --vendor "Alexej Sailer" \
    --mac-package-identifier com.sailer.agenticos.desktop \
    --license-file "$NETS_DIR/PROPRIETARY-EULA.md" \
    --input "$DIST/app" \
    --runtime-image "$DIST/runtime" \
    --main-jar launcher.jar \
    --main-class com.sailer.agenticos.desktop.Main \
    --java-options "-Dagenticos.desktop.version=$VERSION" \
    ${MAC_SIGN_ARGS[@]+"${MAC_SIGN_ARGS[@]}"} \
    --dest "$DIST/out"

  ARCH="$(uname -m | sed 's/x86_64/x64/')"
  ARTIFACT="AgenticNetOS-$VERSION-macos-$ARCH.dmg"
  mv "$DIST/out/AgenticNetOS-$VERSION.dmg" "$DIST/out/$ARTIFACT"

  # Notarize + staple BEFORE checksumming — stapling modifies the dmg.
  # One-time setup: xcrun notarytool store-credentials <profile> --apple-id … --team-id …
  if [ -n "${AGENTICOS_NOTARY_PROFILE:-}" ]; then
    log "Notarizing $ARTIFACT"
    xcrun notarytool submit "$DIST/out/$ARTIFACT" \
      --keychain-profile "$AGENTICOS_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DIST/out/$ARTIFACT"
    log "Notarized and stapled"
  else
    log "AGENTICOS_NOTARY_PROFILE not set — dmg NOT notarized"
  fi

  (cd "$DIST/out" && shasum -a 256 "$ARTIFACT" > SHA256SUMS.txt)
  log "Release artifact: $DIST/out/$ARTIFACT"
fi

log "Done:"
du -sh "$DIST/out"/* 2>/dev/null
