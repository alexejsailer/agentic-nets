# AgenticNetOS Desktop Lite

Single-install local creator/operator environment: one download, one tray app,
no Docker, no Java/Node install, no API key, and no server-side LLM required.
The intended control surface is an MCP client; Studio provides the visual view.

Desktop Lite is not the recommended production deployment. See
[the Desktop Lite guide](DESKTOP-LITE.md) for the intended workflow, exact
capabilities, security boundary, installation, updates, and limitations.

Two documents, two audiences: `DESKTOP-LITE.md` is the operator reference, and
`src/main/resources/manual.html` is the **newcomer manual** the tray opens as
**Manual (Start Here)**. The launcher serves it from its own jar at
`http://localhost:4200/manual`, so it versions with the app and stays readable
while the services are still starting.

```
AgenticNetOS.app
├── runtime/            jlink'd Java (shared by launcher + all Java services)
└── app/
    ├── launcher.jar    tray app + supervisor + Studio static server (this module)
    ├── services/       agentic-net-{node,master,gateway,vault,executor}.jar + sa-blobstore.jar
    ├── gui/            compiled Angular Studio
    ├── mcp/            @agenticnets/mcp dist + production node_modules
    └── node-runtime/   bundled Node (runs the MCP server)
```

## What runs where

| Child | Port | Notes |
|---|---|---|
| vault | 8085 | `VAULT_BACKEND=file` — AES-256-GCM local store, **no OpenBao** |
| blobstore | 8090 | `single` profile; blobs in `~/.agenticos/blobs`. NetHub offloads package payloads here, so template seeding needs it |
| node | 8080 | data in `~/.agenticos/models` (same as native dev) |
| master | 8082 | deterministic net/schedule runtime; server LLM, docker tools, registry and knowledge-blob seeding off by default |
| gateway | 8083 | single seed master; JWT keys in `~/.agenticos/desktop/gateway/jwt` |
| executor | 8084 | direct-mode, eligible for every model; polls models on demand after command assignment |
| mcp | 8091 | streamable HTTP, bearer token auto-generated |
| Studio server | 4200 | in-process: static GUI + reverse proxy of `/oauth2 /api /node-api /vault-api` to :8083 (same contract as the nginx image; port 4200 keeps the GUI in relative-URL mode) |

Everything binds `127.0.0.1`. Desktop Lite is deliberately loopback-only.

## User data

`~/.agenticos/desktop/`: `desktop.properties` (settings: LLM provider, MCP models,
docker tools, heaps), `mcp-token`, `gateway/jwt/`, `logs/` (console + rolling logs),
`run/<service>/` (working dirs). Vault file store: `~/.agenticos/vault/`.
Everything survives app updates. Deleting `~/.agenticos/desktop/` resets only
launcher settings/secrets; deleting all of `~/.agenticos/` is the deliberate
full data reset.

## Tray menu

Status per service, Open Studio (**auto-login**: a single-use 60s link exchanges
the admin secret for a JWT server-side and seeds the Studio session — the secret
never reaches the browser or the user), LLM Settings (opens the Studio
Desktop LLM card — provider, tier models and API key, saved via the launcher
with a ~10s master restart), Connect Codex (copies a ready
`config.toml` block), Connect Claude Code (copies the full `claude mcp add …`
command with token), Copy MCP URL + Token, Manual (Start Here) (the newcomer
guide, served from the launcher jar at `/manual` with no login nonce so it opens
before the gateway is up), Start at Login (XDG autostart on
Linux, a LaunchAgent on macOS), Check for Updates, Open Logs Folder,
Restart Services, Quit. The icon is
the brand glyph (a Petri place holding two tokens), monochrome to match native
menu bar symbols — white/black following the macOS appearance, dimmed while
starting, red corner badge when a service needs attention.

## Updates

The app is stateless; everything under `~/.agenticos/` survives. The tray checks
GitHub daily (skipped for `dev` builds, fail-soft offline), downloads the correct
asset, and verifies it against the release checksums, whose detached **Ed25519
signature** must validate against the key pinned in the launcher (published in
[SECURITY.md](../SECURITY.md)) — GitHub is only transport; unsigned or tampered
releases are refused. macOS stages the new app, verifies its code signature when
one is present, and swaps it transactionally after quit, with rollback if
relaunch fails. Linux copies the correct `apt`/`dnf` command because package
installation needs root.

## Build from a clone

```bash
scripts/build.sh                  # installer for THIS machine (macOS dmg / Linux deb, --rpm)
scripts\build-windows.ps1         # Windows msi (app-image folder without WiX); best-effort, no Windows CI yet
```

Needs JDK 21+ (jlink/jpackage), Node.js 22/npm, `curl`, `tar`, and `unzip`;
Linux also needs `fakeroot` + `binutils`, and `rpm` when requested. The closed node/master/gui come
from `scripts/fetch-closed-artifacts.sh` — source order: private `../core` tree
(maintainers) → GitHub release assets (`agentic-net-{node,master}-<v>.jar` +
`agentic-net-gui-<v>.zip`, SHA256-verified, EULA applies) → Docker Hub images
(fallback, needs Docker). Force with `AGENTICOS_CLOSED_FROM=source|release|images`.

## Maintainer build

```bash
scripts/build-desktop.sh                 # macOS app-image only (fast, for testing)
scripts/build-desktop.sh 2.38.0 --dmg    # + .dmg installer (EULA embedded)
scripts/build-desktop.sh --skip-builds   # reassemble/package without rebuilding artifacts

scripts/package-desktop-linux.sh 2.38.0 --arch all --rpm   # .deb (+.rpm) for amd64+arm64 via Docker
```

Requires: JDK 21+ with jlink/jpackage, node/npm, Docker (Linux packages), network
for the Node runtime download (cached). `AGENTICOS_DESKTOP_DIST` overrides the
dist dir (release builds use `dist-release/` so they never wipe a running app's
`dist/`). Shared staging logic lives in `scripts/lib-assemble.sh`; Linux
packaging runs jlink+jpackage inside `eclipse-temurin:21-jdk-noble` per arch
because jpackage cannot cross-build. Publishing to GitHub Releases:
`ci/scripts/publish-desktop-release.sh` (private repo).

## Known limitations

- macOS `.dmg` + Linux `.deb`/`.rpm` (amd64 + arm64) built on the Mac; the Windows
  `.msi` (x64, per-user install, in-place upgrades via fixed UpgradeCode) is built by
  GitHub Actions per release from the release assets and folded into the signed
  checksum manifest with `ci/scripts/sign-windows-asset.sh`. All installers are
  unsigned (macOS: right-click → Open; Windows: SmartScreen "Run anyway") until
  certificates exist. Windows command transitions need a bash on PATH (Git Bash) —
  MCP-first usage, Studio, schedules and updates work without it.
- Linux menu entry + icon are installed per-user on the first launch inside a
  desktop session (packages carry no xdg postinst hooks, so headless installs
  stay clean); launch once from `/opt/agenticnetos/bin/AgenticNetOS` after install.
- No blobstore child yet: blob URN rendering and knowledge-blob reads degrade. Command
  transitions run on the built-in executor (`agentic-net-executor-default`). It is wildcard-
  eligible and activates each model on demand within about 5s; lanes pinned to a second executor
  id stall until phase 2 adds multi-executor support.
- Server-side LLM is deliberately disabled. AI lanes run through MCP external
  fires by default; set `llm.provider=ollama` or `claude` in
  `desktop.properties` only when master-run or unattended AI lanes are wanted.
- Maintainer signing: `AGENTICOS_MAC_SIGN_IDENTITY` (Developer ID) and
  `AGENTICOS_NOTARY_PROFILE` (notarytool keychain profile) activate macOS code
  signing + notarization in `build-desktop.sh`; without them builds stay
  unsigned and Gatekeeper warns on first launch.
