# AgenticNetOS Desktop Lite

Desktop Lite is the quickest way to put Agentic-Nets on one computer:
install one package, start the tray app, connect an MCP client, and build or
operate nets. It needs no Docker daemon, Java installation, Node installation,
server-side LLM, or API key.

It is a local creator/operator environment, not the recommended production
deployment. Use the Docker/server deployment when you need remote access,
multiple executors, clustered services, monitoring, hardened secret
infrastructure, or production lifecycle controls.

> **New users start with the in-app manual, not this page.** The tray item
> **Manual (Start Here)** opens a newcomer guide (what to connect, what to build
> first, what runs while you are away) served by the launcher itself at
> `http://localhost:4200/manual`. Source: `src/main/resources/manual.html`.
> This page stays the operator/reference document for the same edition.

## The intended workflow

1. Install the package from the GitHub release.
2. Start AgenticNetOS. The tray app starts and health-checks the local runtime.
3. Choose **Connect Codex (copy config)** or **Connect Claude Code (copy
   command)** in the tray.
4. Add the copied configuration to the MCP client and start a new client
   session.
5. Ask the connected model to create nets, inspect state, schedule work, run
   deterministic transitions, or execute AI lanes externally.

The connected MCP client supplies the intelligence. The bundled master remains
because it is the deterministic control plane: it binds and consumes tokens,
applies inscriptions, schedules transitions, records events, enforces
execution policy, and completes externally executed AI fires. It does not call
an LLM in the default profile.

```text
Codex / Claude / another MCP client
                  |
         loopback MCP + bearer token
                  |
   tray supervisor ── Studio
        |
        ├─ node       durable event-sourced state
        ├─ master     nets, schedules, fires, audit (LLM disabled)
        ├─ gateway    local authenticated API
        ├─ vault      encrypted local transition credentials
        └─ executor   local command/script transitions
```

## What works with no server LLM

- Create, edit, deploy, inspect, export, and delete nets.
- Read and write places, tokens, working memory, and context.
- Run `pass`, `map`, `http`, and local `command` transitions; use `link` edges
  for non-firing structure.
- Create schedules, pause/resume models, and inspect scheduler or fire status.
- Use transition-scoped credentials through the encrypted local vault.
- Let the connected MCP model perform `llm` or `agent` transitions with
  `prepare_external_fire` and `complete_external_fire`. With no provider, master
  simply skips its AI lanes, so they keep a normal lifecycle and wait for a client;
  `set_external` marks a lane as client-only on purpose, and is the ONLY thing that
  ever sets that status.
- Use Studio as the visual/manual editor for the same state. Studio's built-in
  AI assistants need an optional server provider; the MCP client is the
  assistant in the default profile.

An explicit policy can return a lane to master execution. If that lane has no
configured server provider, it fails clearly; it does not silently try Ollama
or consume a provider key.

## Local services

| Component | Port | Desktop Lite role |
|---|---:|---|
| Studio | 4200 | Visual editor served by the launcher |
| Node | 8080 | Durable net, token, and event state |
| Master | 8082 | Deterministic orchestration and scheduling |
| Gateway | 8083 | Authenticated local API |
| Executor | 8084 | Local command and script execution |
| Vault | 8085 | AES-256-GCM file-backed credentials |
| MCP | 8091 | Streamable HTTP endpoint for the controlling client |

All listeners are fixed to `127.0.0.1`. Desktop Lite intentionally has no LAN
exposure switch. Remote and multi-user access belongs behind the production
gateway/deployment rather than a single-user tray process.

User state is under `~/.agenticos/` and survives application updates:

- `~/.agenticos/models/` — node data.
- `~/.agenticos/desktop/desktop.properties` — advanced desktop settings.
- `~/.agenticos/desktop/mcp-token` — local MCP bearer token.
- `~/.agenticos/desktop/gateway/jwt/` — Studio/gateway credentials.
- `~/.agenticos/desktop/logs/` — child-process logs.
- `~/.agenticos/vault/` — encrypted transition credentials.

The settings and secret files are created with user-only permissions on POSIX
systems. Windows relies on the user's profile ACL.

## Connect an MCP client

The tray generates the endpoint configuration with the installation's own
bearer token. Copy it from the tray instead of copying examples from this page.

For Codex, choose **Connect Codex (copy config)** and merge the copied block
into `~/.codex/config.toml`:

```toml
[mcp_servers.agenticnets]
url = "http://127.0.0.1:8091/mcp"
http_headers = { Authorization = "Bearer <installation token>" }
```

For Claude Code, choose **Connect Claude Code (copy command)** and paste the
command into a terminal. For another Streamable HTTP MCP client, choose
**Copy MCP URL + Token**.

The default MCP model and session are `default` and `desktop`. The MCP
allowlist still applies, including to a connected model.

Desktop Lite advertises the curated lowercase MCP tools by default. This keeps the first-session
surface focused on memory, net construction, scheduling, protocols, and execution instead of also
showing the large low-level UPPERCASE catalog. Advanced clients can opt back into both layers by
setting `AGENTICOS_NATIVE_TOOLS=all` when running their own MCP server; non-Desktop installations
retain `all` as the backward-compatible default.

Use `add_transitions` for a batch of similar lanes, `delete_tokens` for a bounded ArcQL-selected
cleanup, and `fire_once` to smoke-test a deterministic lane without stopping it (the default
`preserveRunning:true` leaves its lifecycle unchanged). Cron schedules accept an explicit IANA
timezone such as `Europe/Berlin`; `scheduler_status` names stopped or invalid schedules and keeps
armed, fired, and successful timestamps distinct.

Schedules for deterministic, HTTP, and command lanes run without the MCP
client connected. A scheduled external AI lane can become ready on its own,
but its reasoning waits safely until an MCP client performs the external fire.
Configure a server provider only when AI reasoning itself must run unattended.

### AI lanes cannot be scheduled unattended in the default profile

With `llm.provider=disabled`, master has nothing to execute an llm or agent
transition with, so it **skips** those lanes rather than firing them into a
guaranteed failure. They keep a completely normal lifecycle — `deployed`, or even
`running` — and simply wait for a connected MCP client to serve them. A cron on
one is accepted and displayed as armed but is dispatched by nobody. Deterministic,
HTTP, and command lanes are unaffected. Personas are agent lanes and follow the
same rule.

`external` is a separate, deliberate thing: it means *this lane is client-only,
because I said so*. Only `set_external` sets it. A missing provider never implies
it, so the marker keeps one meaning and a lane you started stays discoverable.

The protocol surfaces all of this rather than leaving it to be discovered:

- `readiness` reports `llm.youAreTheRuntime` and an `externalFires` block with
  `waiting` (lanes holding bound tokens) and `stranded` (lanes master cannot run at
  all), plus a warning naming them. A backlog is work pending, not a failed
  installation, so it does not make the installation unready.
- `list_external_fires {includeAll:true}` lists every llm/agent lane with a
  `servable` verdict and reason. The default view shows only hand-marked lanes, so
  the tool returns a hint pointing at the wider view whenever the provider is off.
- `scheduler_status` marks each such lane `willNotFireUnattended` with an
  `unattendedHint`, and lists them under `headline.externalScheduled` with a
  `reason` separating "marked external" from "master has no provider".
- The server instructions tell the connected client to check the backlog early in
  a session, report the count, and offer to work it. The `work-external-fires`
  prompt is the same recipe on demand.

To hand these lanes to master instead, configure a provider (tray → **LLM
Settings**). A client may also take over a running lane for a single fire; master
stands down while that fire is in flight.

An **explicit** fire (Studio's fire button, `fire_once`, a test harness) is
answered rather than skipped: it returns a `providerDisabled` refusal naming both
options, and preserves the input tokens. Master also hands back the preset locks
on such a refusal, so the external client is not blocked by a lease it can never
resolve.

`prepare_external_fire` returns everything a client needs to serve the lane
without guessing: the interpolated prompt (or resolved agent instruction), the
leased tokens, a `contract` block stating which field carries the answer, whether
it must be JSON because an emit rule parses it, the emission shape for agent
lanes, the failure and idempotency rules, and the transition's own `inscription`
so the emit rules that will route the answer can be read directly.

Besides an MCP client, the `agenticos` CLI can serve these lanes with its own
provider (`transition lanes --all`, `transition serve`). The CLI is not part of
this bundle and installs separately.

### Command executor state across models

The bundled executor is eligible for every model (`EXECUTOR_MODELS=*`), including
models created later through MCP. To stay light, it does not continuously poll
models with no command assignments. MCP reports this lifecycle explicitly:

- `STANDBY` — eligible and command-capable; no assignment in this model yet.
- `READY` — polling this model because at least one command lane is assigned.
- `UNAVAILABLE` — no online executor is eligible; this is the only blocking state.

After a command transition is assigned, Desktop discovery moves the executor
from STANDBY to READY within about five seconds. This model-local executor state
does not change Studio's selected model. Check it with MCP `readiness`,
`list_executors`, or `net_stats.executorCoverage`.

Studio's Protocol view is independently model-scoped too: its dropdown can show one model or merge
all models without changing the model selected in the editor. It supports free-text search, level
filtering, grouping by source/day/tag/model, JSON body formatting, tag chips, and raw-token detail.

## Optional server-side LLM

The default in a new installation is:

```properties
llm.provider=disabled
```

Most Desktop Lite users should leave it that way and run AI lanes through the
connected MCP client. If unattended server-side AI lanes are specifically
needed, edit `~/.agenticos/desktop/desktop.properties` and choose one of:

```properties
# Local or remote Ollama
llm.provider=ollama
ollama.base.url=http://127.0.0.1:11434
ollama.model=llama3.2

# Anthropic API
llm.provider=claude
anthropic.api.key=...
```

Then choose **Restart Services** in the tray. A Claude selection with no key
falls back to the disabled state. Docker-backed tool execution is also off by
default and remains an advanced opt-in (`docker.enabled=true`).

## Install and update

Download the package for the operating system from the GitHub release and
verify it with the release's `SHA256SUMS.txt`.

- macOS: open the `.dmg`, accept the license, and drag AgenticNetOS to
  Applications. Current builds are unsigned, so the first launch needs
  right-click **Open** or approval in Privacy & Security.
- Debian/Ubuntu: `sudo apt install ./AgenticNetOS-<version>-linux-<arch>.deb`.
- Fedora/RHEL: `sudo dnf install ./AgenticNetOS-<version>-linux-<arch>.rpm`.
- Windows: run `scripts\build-windows.ps1` on Windows for an MSI when WiX is
  installed, or an app-image otherwise. Published Windows packages still need
  a Windows release builder.

The tray checks GitHub releases once per day. Downloads are verified against
the release checksum. macOS uses a transactional app swap with rollback if the
new app cannot relaunch; Linux copies the appropriate package-manager command
to the clipboard because installation needs root. Windows stops every child
service and waits for them to actually exit BEFORE launching the msi, then hands
it to a detached script with a short delay so the launcher itself is gone when
the installer's files-in-use scan runs — the background node/java children have
no windows and cannot be closed by Restart Manager, so any other ordering ends
in "error writing to file" and a rollback that removes the old install
(observed on 2.40.0; recovery: end the leftover processes or reboot, re-run the
msi).

The stop is not limited to what the current launcher remembers. Every spawned
child is recorded as `~/.agenticos/desktop/run/<service>/pid` holding
`<pid> <startEpochMillis>`; an entry only counts when the live process's start
instant matches the record, because pids are numbers the OS reuses. Both update
paths then combine that registry with a scan BY EVIDENCE — processes whose
executable resolves under the install root AND carries one of the shipped image
names (`java`, `node`, `AgenticNetOS`) — so orphans of a force-killed previous
instance and second launcher instances are found either way. Everything
identified is killed and awaited until provably dead (ports and, on Windows,
file handles release only at process death). A process under the root that is
NOT positively identifiable — wrong image name, unreadable command — is never
killed: it surfaces as a survivor and the update **aborts naming it**, instead
of handing the installer a fight it loses by rollback. On macOS the sweep runs
before the update applier is spawned, because the applier is itself a java
process from the install runtime. Updates
never replace `~/.agenticos/`, failed ones included.

## Build an installer from a clone

```bash
# macOS or Linux
agentic-net-desktop/scripts/build.sh <version>

# Linux, also create an RPM
agentic-net-desktop/scripts/build.sh <version> --rpm
```

```powershell
# Windows
agentic-net-desktop\scripts\build-windows.ps1 -Version <version>
```

The local build needs JDK 21+, Node.js 22/npm, `curl`, `tar`, and `unzip`.
Linux also needs `fakeroot` and `binutils`, plus `rpm` when requested. The matching closed
node/master/GUI binaries are downloaded from the GitHub release and verified
against its checksums; Docker Hub images are only the fallback when those
assets are absent. The proprietary components remain governed by the
[EULA](../PROPRIETARY-EULA.md).

Maintainer release publication additionally refuses dirty or incorrectly
tagged source trees and records artifact hashes plus the core, public, and CI
commit IDs in `BUILD_PROVENANCE.txt`. Reusing a build is allowed only when its
version, commits, and staged artifact hashes still match.

## Scope and limitations

Desktop Lite deliberately omits blobstore, OpenBao, OCI tool registry,
Prometheus/Grafana/Tempo, clustering, and remote executor topology. Command
lanes use the one bundled executor ID, `agentic-net-executor-default`, which is
eligible for all local models and activates per model on demand. Blob URN
rendering and knowledge-blob reads therefore degrade, and lanes pinned to
another executor wait for that executor.

The current packages are unsigned. Code signing/notarization and a published
Windows installer require release credentials and a Windows builder. These are
distribution limitations, not reasons to make the local runtime depend on
Docker.

For a production-like or remotely reachable installation, use
[the Docker deployment](../deployment/README.md).
