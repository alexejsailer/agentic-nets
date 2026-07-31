#!/usr/bin/env bash
# One-command desktop build for a cloned repository — produces the installer for
# THIS machine:
#
#   macOS  -> dist/out/AgenticNetOS-<v>-macos-<arch>.dmg
#   Linux  -> dist/out/AgenticNetOS-<v>-linux-<arch>.deb   (+ .rpm with --rpm)
#   Windows: use scripts\build-windows.ps1 instead.
#
# Requirements: JDK 21+ (jlink + jpackage on PATH), Node.js 22 + npm, and Docker
# unless this checkout sits inside the maintainer workspace (the closed-source
# node/master/gui are extracted from the published Docker Hub images and are
# governed by ../PROPRIETARY-EULA.md). Linux additionally: fakeroot + binutils
# (deb), rpm (--rpm).
#
# Usage: build.sh [version] [--rpm] [--skip-builds]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(dirname "$SCRIPT_DIR")"
NETS_DIR="$(dirname "$MODULE_DIR")"
DIST="${AGENTICOS_DESKTOP_DIST:-$MODULE_DIR/dist}"

source "$SCRIPT_DIR/lib-assemble.sh"

VERSION="$(default_version)"
MAKE_RPM=false
SKIP_BUILDS=false
for arg in "$@"; do
  case "$arg" in
    --rpm)         MAKE_RPM=true ;;
    --skip-builds) SKIP_BUILDS=true ;;
    *)             VERSION="$arg" ;;
  esac
done

log() { printf '\n\033[1;32m[desktop]\033[0m %s\n' "$*"; }

if [ "$(uname -s)" = "Darwin" ]; then
  exec "$SCRIPT_DIR/build-desktop.sh" "$VERSION" --dmg $($SKIP_BUILDS && echo --skip-builds)
fi

# ---------------------------------------------------------------------------
# Linux, natively (no Docker cross-build needed when already on Linux)
# ---------------------------------------------------------------------------
if ! $SKIP_BUILDS; then
  log "Building open components"
  build_open_components
  log "Fetching closed artifacts"
  "$SCRIPT_DIR/fetch-closed-artifacts.sh" "$VERSION"
fi

case "$(uname -m)" in
  aarch64) ARCH="arm64";  NODE_PLATFORM="linux-arm64" ;;
  x86_64)  ARCH="amd64";  NODE_PLATFORM="linux-x64" ;;
  *) echo "Unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

log "Assembling app dir"
assemble_app_dir "$DIST/app" "$NODE_PLATFORM" "$DIST/cache"

log "Building jlink runtime"
rm -rf "$DIST/runtime"
jlink --add-modules "$JLINK_MODULES" --output "$DIST/runtime" \
      --no-header-files --no-man-pages --compress zip-6

# Two-phase app-image -> package so the launcher cfg can pin app.runtime —
# without it jpackage's Linux launcher searches for a dir named "runtime" and
# settles on mcp/node_modules/@babel/runtime. No --linux-shortcut: its xdg
# postinst hook fails on headless installs.
log "Packaging v$VERSION ($ARCH)"
rm -rf "$DIST/image" "$DIST/out"
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
  --dest "$DIST/image"
sed -i "/^\[Application\]/a app.runtime=\$APPDIR/../runtime" \
  "$DIST/image/AgenticNetOS/lib/app/AgenticNetOS.cfg"

TYPES="deb"
$MAKE_RPM && TYPES="deb rpm"
for type in $TYPES; do
  jpackage \
    --type "$type" \
    --app-image "$DIST/image/AgenticNetOS" \
    --linux-package-name agenticnetos \
    --app-version "$VERSION" \
    --vendor "Alexej Sailer" \
    --license-file "$NETS_DIR/PROPRIETARY-EULA.md" \
    --dest "$DIST/out"
done

DEB_SRC=$(ls "$DIST/out"/agenticnetos_*"$ARCH".deb 2>/dev/null | head -1)
[ -n "$DEB_SRC" ] && mv "$DEB_SRC" "$DIST/out/AgenticNetOS-$VERSION-linux-$ARCH.deb"
if $MAKE_RPM; then
  RPM_SRC=$(ls "$DIST/out"/agenticnetos-*.rpm 2>/dev/null | head -1)
  [ -n "$RPM_SRC" ] && mv "$RPM_SRC" "$DIST/out/AgenticNetOS-$VERSION-linux-$ARCH.rpm"
fi
(cd "$DIST/out" && sha256sum AgenticNetOS-"$VERSION"-* > SHA256SUMS.txt)

log "Done:"
ls -lh "$DIST/out" | tail -n +2
