# Shared assembly logic for the desktop packagers (sourced, not executed).
# Callers must set: MODULE_DIR, NETS_DIR before sourcing.
#
# Closed components (node jar, master jar, compiled gui) come from
# closed-artifacts/, populated by fetch-closed-artifacts.sh — from the private
# core/ source tree when present, otherwise from the published Docker Hub images.

NODE_RUNTIME_VERSION="${NODE_RUNTIME_VERSION:-22.14.0}"
CLOSED_DIR="${AGENTICOS_CLOSED_DIR:-$MODULE_DIR/closed-artifacts}"

# One list for every platform — proven to boot all four Spring Boot services.
# Deliberately NO jdk.compiler.
JLINK_MODULES="java.se,jdk.unsupported,jdk.crypto.ec,jdk.crypto.cryptoki,jdk.httpserver,jdk.zipfs,jdk.charsets,jdk.localedata,jdk.management,jdk.security.auth,jdk.naming.dns"

# assemble_app_dir <dest-app-dir> <node-platform|none> <cache-dir>
#   node-platform: darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | none
# Stages launcher.jar, service jars, gui statics, licenses, mcp (dist +
# prod-only node_modules — pure-JS, arch-independent) and the Node runtime.
assemble_app_dir() {
  local app="$1" node_platform="$2" cache="$3"

  for missing in "$CLOSED_DIR/agentic-net-node.jar" "$CLOSED_DIR/agentic-net-master.jar" "$CLOSED_DIR/gui/index.html"; do
    [ -e "$missing" ] || { echo "closed artifact missing: $missing — run scripts/fetch-closed-artifacts.sh first" >&2; return 1; }
  done

  rm -rf "$app"
  mkdir -p "$app/services" "$app/gui" "$app/mcp/dist/bin"

  cp "$MODULE_DIR/target/launcher.jar" "$app/launcher.jar"
  cp "$CLOSED_DIR/agentic-net-node.jar"   "$app/services/agentic-net-node.jar"
  cp "$CLOSED_DIR/agentic-net-master.jar" "$app/services/agentic-net-master.jar"
  cp "$NETS_DIR/agentic-net-gateway/target/agentic-net-gateway-"*.jar   "$app/services/agentic-net-gateway.jar"
  cp "$NETS_DIR/agentic-net-vault/target/agentic-net-vault-"*.jar       "$app/services/agentic-net-vault.jar"
  cp "$NETS_DIR/agentic-net-executor/target/agentic-net-executor-"*.jar "$app/services/agentic-net-executor.jar"

  cp -R "$CLOSED_DIR/gui/." "$app/gui/"

  cp "$NETS_DIR/LICENSE.md" "$app/LICENSE.md"
  cp "$NETS_DIR/PROPRIETARY-EULA.md" "$app/EULA.md"

  # MCP: dist + a production-only node_modules (manifest stripped of devDeps —
  # the file:../agentic-net-cli dev dep is inlined by tsup and must not resolve)
  cp "$NETS_DIR/agentic-net-mcp/dist/bin/agenticnets-mcp.js" "$app/mcp/dist/bin/"
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const out = { name: pkg.name, version: pkg.version, type: pkg.type, dependencies: pkg.dependencies };
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  ' "$NETS_DIR/agentic-net-mcp/package.json" "$app/mcp/package.json"
  (cd "$app/mcp" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)

  if [ "$node_platform" != "none" ]; then
    fetch_node_runtime "$app" "$node_platform" "$cache"
  fi
}

# fetch_node_runtime <dest-app-dir> <node-platform> <cache-dir>
fetch_node_runtime() {
  local app="$1" node_platform="$2" cache="$3"
  local dist="node-v$NODE_RUNTIME_VERSION-$node_platform"
  mkdir -p "$cache" "$app/node-runtime/bin"
  if [ ! -f "$cache/$dist/bin/node" ]; then
    echo "[assemble] fetching Node runtime $dist"
    curl -fsSL "https://nodejs.org/dist/v$NODE_RUNTIME_VERSION/$dist.tar.gz" | tar -xz -C "$cache"
  fi
  cp "$cache/$dist/bin/node" "$app/node-runtime/bin/node"
  cp "$cache/$dist/LICENSE" "$app/node-runtime/LICENSE" 2>/dev/null || true
}

# build_open_components — everything that builds from THIS repository
build_open_components() {
  (cd "$NETS_DIR/agentic-net-gateway"  && ./mvnw -q clean package -DskipTests)
  (cd "$NETS_DIR/agentic-net-vault"    && ./mvnw -q clean package -DskipTests)
  (cd "$NETS_DIR/agentic-net-executor" && ./mvnw -q clean package -DskipTests)
  (cd "$MODULE_DIR" && ./mvnw -q clean package)
  (cd "$NETS_DIR/agentic-net-cli" && { [ -d node_modules ] || npm install; } \
    && { [ -d dist ] || npx tsup; })
  (cd "$NETS_DIR/agentic-net-mcp" && { [ -d node_modules ] || npm install; } && npm run build)
}

# default_version — ci/VERSION in the maintainer workspace, else newest git tag
default_version() {
  cat "$(dirname "$NETS_DIR")/ci/VERSION" 2>/dev/null \
    || git -C "$NETS_DIR" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' \
    || echo 0.0.0
}
