#!/usr/bin/env bash
# Package AgenticNetOS Desktop for Linux (.deb, optionally .rpm) via Docker —
# jpackage cannot cross-build, so jlink + jpackage run inside a Linux container
# per target arch while the platform-independent artifacts are staged on the host.
#
# Usage: package-desktop-linux.sh [version] [--arch amd64|arm64|all] [--rpm]
#   version   app version (default: ci/VERSION)
#   --arch    target arch(es); default: the host's arch (arm64 on Apple Silicon).
#             amd64 runs emulated on Apple Silicon (slower but works).
#   --rpm     also produce an .rpm per arch
#
# Prereqs: the artifacts are already built (run build-desktop.sh once, or pass
# --skip-builds there) and Docker is running.
#
# Output: dist-linux/<arch>/out/AgenticNetOS-<v>-linux-<arch>.deb (+ .rpm)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(dirname "$SCRIPT_DIR")"
NETS_DIR="$(dirname "$MODULE_DIR")"
DIST="$MODULE_DIR/dist-linux"
IMAGE="eclipse-temurin:21-jdk-noble"

source "$SCRIPT_DIR/lib-assemble.sh"

VERSION="$(default_version)"
case "$(uname -m)" in arm64|aarch64) ARCHES="arm64" ;; *) ARCHES="amd64" ;; esac
MAKE_RPM=false
EXPECT_ARCH=false
for arg in "$@"; do
  if $EXPECT_ARCH; then
    case "$arg" in all) ARCHES="amd64 arm64" ;; amd64|arm64) ARCHES="$arg" ;; *) echo "bad --arch $arg" >&2; exit 1 ;; esac
    EXPECT_ARCH=false; continue
  fi
  case "$arg" in
    --arch) EXPECT_ARCH=true ;;
    --rpm)  MAKE_RPM=true ;;
    *)      VERSION="$arg" ;;
  esac
done

log() { printf '\n\033[1;36m[desktop-linux]\033[0m %s\n' "$*"; }

for arch in $ARCHES; do
  case "$arch" in
    amd64) NODE_PLATFORM="linux-x64" ;;
    arm64) NODE_PLATFORM="linux-arm64" ;;
  esac

  log "[$arch] assembling app dir"
  assemble_app_dir "$DIST/$arch/app" "$NODE_PLATFORM" "$DIST/cache"
  cp "$NETS_DIR/PROPRIETARY-EULA.md" "$DIST/$arch/EULA-license.md"
  rm -rf "$DIST/$arch/out" "$DIST/$arch/runtime"

  TYPES="deb"
  $MAKE_RPM && TYPES="deb rpm"

  log "[$arch] jlink + jpackage in $IMAGE (linux/$arch)"
  docker run --rm --platform "linux/$arch" \
    -v "$DIST/$arch:/work" \
    -e VERSION="$VERSION" -e TYPES="$TYPES" -e JLINK_MODULES="$JLINK_MODULES" \
    "$IMAGE" bash -euc '
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null
      apt-get install -qq -y fakeroot binutils $(echo "$TYPES" | grep -q rpm && echo rpm) >/dev/null
      jlink --add-modules "$JLINK_MODULES" --output /work/runtime \
            --no-header-files --no-man-pages --compress zip-6

      # Two-phase: app image first so we can pin app.runtime in the launcher cfg.
      # Without it the Linux launcher SEARCHES for a dir named "runtime" and finds
      # mcp/node_modules/@babel/runtime before lib/runtime. (No --linux-shortcut:
      # its xdg postinst hook fails on headless installs and half-configures the deb.)
      rm -rf /work/image
      jpackage \
        --type app-image \
        --name "AgenticNetOS" \
        --app-version "$VERSION" \
        --vendor "Alexej Sailer" \
        --input /work/app \
        --runtime-image /work/runtime \
        --main-jar launcher.jar \
        --main-class com.sailer.agenticos.desktop.Main \
        --java-options "-Dagenticos.desktop.version=$VERSION" \
        --dest /work/image
      sed -i "/^\[Application\]/a app.runtime=\$APPDIR/../runtime" \
        /work/image/AgenticNetOS/lib/app/AgenticNetOS.cfg

      for type in $TYPES; do
        jpackage \
          --type "$type" \
          --app-image /work/image/AgenticNetOS \
          --linux-package-name agenticnetos \
          --app-version "$VERSION" \
          --vendor "Alexej Sailer" \
          --license-file /work/EULA-license.md \
          --dest /work/out
      done
    '

  DEB_SRC=$(ls "$DIST/$arch/out"/agenticnetos_*"$arch".deb 2>/dev/null | head -1)
  [ -n "$DEB_SRC" ] && mv "$DEB_SRC" "$DIST/$arch/out/AgenticNetOS-$VERSION-linux-$arch.deb"
  if $MAKE_RPM; then
    RPM_SRC=$(ls "$DIST/$arch/out"/agenticnetos-*.rpm 2>/dev/null | head -1)
    [ -n "$RPM_SRC" ] && mv "$RPM_SRC" "$DIST/$arch/out/AgenticNetOS-$VERSION-linux-$arch.rpm"
  fi
  log "[$arch] done:"
  ls -lh "$DIST/$arch/out" | tail -n +2
done
