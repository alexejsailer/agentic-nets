# AgenticNetOS Desktop Lite

AgenticNetOS is a runtime for observable workflows and persona agents. Desktop
Lite is the quickest way to run it on one computer: create one named specialist
or multiple personas, compose them into a team, and let them collaborate through
shared context and explicit hand-offs. Agentic-Nets provides the durable state,
tools, schedules, Protocol reporting, and event-sourced audit trail underneath.
One complete worked example is the Safe Product Team: a Product Manager front
door, bounded specialists, explicit review/release approval, repository context,
and a Chronicle that reports from evidence. It needs no Docker daemon, Java
installation, Node installation, server-side LLM, or API key.

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
5. Ask the client to read `agenticnets://docs/starter-patterns` and propose the
   smallest matching example. For the complete product-delivery example, invoke
   the MCP prompt `start-safe-product-team` with the product goal and repository. It reads
   `agenticnets://docs/safe-product-team`, checks `readiness`, proposes an
   execution backend, stages the team stopped, verifies it, and states which
   personas run while disconnected. For another domain, use
   `design-persona-team`; for one specialist, use `spawn-worker`.

The connected MCP client supplies interactive intelligence. The bundled master
is the durable control plane: it binds and consumes tokens, applies inscriptions,
schedules transitions, records events, enforces execution policy, and completes
externally executed AI fires. It does not call a server LLM in the default
profile, but a CLI-backed agent transition may ask an installed Claude
Code/Codex process to perform its reasoning step.

```text
Codex / Claude / another MCP client
                  |
         loopback MCP + bearer token
                  |
   tray supervisor ── Studio + Protocol
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
- Run full bounded persona agents through a locally installed Claude Code/Codex
  session by setting `action.llmMode=bash` and `action.binary=claude|codex`.
  These lanes are master-owned and can be scheduled without a server provider.
- Use command lanes for one-shot headless CLI jobs; pipe the prompt through stdin
  (`claude -p` or `codex exec -`) rather than nesting dynamic shell quotes.
- Create schedules, pause/resume models, and inspect scheduler or fire status.
- Read the complete historical event trail and keep a readable operational
  journal through the installed Protocol net's `entries` role; Desktop renders
  those same tokens through **Open Protocol**. The built-in compatibility mapping
  remains `p-protocol`, but clients discover the role rather than depending on it.
- Use transition-scoped credentials through the encrypted local vault.
- Let the connected MCP model perform `llm` or `agent` transitions with
  `prepare_external_fire` and `complete_external_fire`. With no provider, master
  skips provider-backed AI lanes, so they keep a normal lifecycle and wait for a client;
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
| Blob store | 8090 | Package payloads and blobs behind NetHub publish/install |
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
- `~/.agenticos/blobs/` — blob store payloads (NetHub package bodies).

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

Schedules for deterministic, HTTP, command, and CLI-backed agent lanes run
without the MCP client connected. A scheduled external/provider-backed AI lane
can become ready on its own, but its reasoning waits safely until an MCP client
performs the external fire. Configure a server provider only when ordinary API
agent/llm lanes must run unattended.

### AI execution in the default profile

With `llm.provider=disabled`, master **skips provider-backed** llm/agent lanes
rather than firing them into guaranteed failure. They keep a normal lifecycle
and wait for a connected client. A cron on one is armed but dispatched by
nobody. Two unattended exceptions are intentional: an agent with
`action.llmMode=bash` uses a local Claude Code/Codex process while preserving the
bounded agent loop, and a command lane may spawn a one-shot headless CLI job.

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
- `scheduler_status` marks each provider-backed stranded lane `willNotFireUnattended` with an
  `unattendedHint`, and lists them under `headline.externalScheduled` with a
  `reason` separating "marked external" from "master has no provider".
- The server instructions tell the connected client to check the backlog early in
  a session, report the count, and offer to work it. The `work-external-fires`
  prompt is the same recipe on demand.

To hand provider-backed lanes to master, configure a provider (tray → **LLM
Settings**). To keep the provider disabled, create a CLI-backed persona explicitly
(`spawn_persona execution:"claude-code"|"codex"` or `add_transition` with
`llmMode:"bash"`). The binary must be reachable from the Desktop master process.
A client may also take over a running lane for a single fire; master stands down
while that fire is in flight.

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

## Worked example: Safe Product Team

The Safe Product Team is one detailed persona-first product-delivery example, based on the
working pattern used by the larger server deployment but self-contained inside
the Agentic-Nets model. Its default roles are:

| Persona | Owns | Default boundary |
|---|---|---|
| Product Manager | Single user inbox, story and acceptance criteria | Does not edit repositories |
| Architect | Smallest viable design, affected components and risks | Does not implement its own design |
| Developer | Scoped repository changes and test evidence | Writes only declared paths; no release authority |
| Reviewer / QA | Independent verdict and actionable rework | Reviews evidence; does not silently approve its own changes |
| Release Guardian | Commit/push/deploy/publish boundary | Requires the configured approval policy/token |
| Chronicle | Readable status and Protocol reports | Observes and summarizes; does not change product state |

Add the Domain Expert, Operations watcher, or Security reviewer only when the
product needs those roles. More personas create more hand-offs and cost; clear
separation of duties is the goal, not the largest possible team.

The built-in `dev-team` template supplies the token-free deterministic backbone:
backlog, ready, in-progress, review, done, WIP limits, repository/product context,
decisions, reviewed lessons, structured team status, and `p-protocol`. The
`start-safe-product-team` MCP playbook adds the resident personas and backend,
wires their hand-offs, records repository policy, smoke-tests the team, and arms
only ready lanes. A forum, issue tracker, Slack, or email adapter can be added
later, but it is not the team's system of record.

For a smaller provider-free concept example, deploy `headless-cli-reviewer` with
an absolute executor-visible working directory and `binary=claude|codex`. It
shows the safe MAP → CommandToken → COMMAND → result path in read-only mode.
Use the starter-pattern catalog to choose other shapes instead of inheriting
product-team roles for an unrelated domain.

### Repository context and side effects

One token in `p-team-repositories` should exist per repository and contain only
portable configuration: `repositoryId`, `repoUrl` or executor-visible
`workingDir`, `defaultBranch`, allowed write scope, build/test commands,
`pushPolicy`, and `deployPolicy`. Stories reference `repositoryId`; personas do
not guess paths or commands. Credentials remain in Vault and never travel in
repository/context tokens or NetHub packages.

The safe default is local analysis/edit/test with commit, push, deployment, and
publishing approval-gated. The Release Guardian consumes the explicit approval
token before permitting those external effects. Package repository/domain
knowledge as a `kind=context` artifact when several teams should reuse it.

## Observability is the product loop

Agentic-Nets gives the team three views of the same execution:

1. **Event trail** — immutable low-level history of token changes, bindings,
   fires, emissions, tool results, and lifecycle changes. `event_trail` is the
   evidence for reconstructing exactly what happened.
2. **Status board** — structured story/persona/stage/outcome/duration facts used
   for current state, metrics, stuck-work detection, and comparisons.
3. **Protocol** — a curated human-readable narrative in the installed Protocol
   net's `entries` store, rendered by Studio and readable with `protocol_tail`.
   Personas write milestones, decisions, approvals, warnings, failures, and
   what happens next. The built-in template maps this role to `p-protocol` so
   existing histories continue to work without migration.

Protocol does not replace the event history; it explains it. A claim such as
“QA approved STORY-42” should have a Protocol entry for the reader, a status
token for analysis, and transition/token events as proof. This makes questions
such as these answerable after the fact:

- Where did a story wait, and for how long?
- Which persona or context version creates the most rework?
- Did the release follow its approval policy?
- Which commands/tests support the reported outcome?
- Which repeated successful reasoning step is ready to crystallize?

Use `protocol_tail` for the narrative, then verify with `event_trail`,
`query_tokens`, `net_stats`, `scheduler_status`, and `usage_report`. Persona or
context optimizations should be proposed from that evidence, recorded as a new
version, smoke-tested, and compared with the previous version—not silently
rewritten in place.

## Playbooks, templates, NetHub, and runtime agents

These mechanisms are complementary:

- **MCP prompts/playbooks** (`start-safe-product-team`,
  `design-persona-team`) tell the connected model how to perform an
  environment-aware deployment through tools. MCP is the setup/control surface;
  master-owned nets continue after the MCP session closes.
- **Starter templates** (`deploy_template`) materialize common topologies. They
  are convenient local blueprints, not a versioned marketplace contract.
- **NetHub / Agent Hub packages** are the portable artifacts. Use `kind=agent`
  for a complete persona-team session and manifest, `kind=context` for repository
  or domain context and links, `kind=toolnet` for deterministic capabilities,
  and `kind=model` only when the whole isolated domain should travel. Agent and
  context packages install stopped and return a configure-then-start checklist.
  Two built-ins make the boundary concrete: `safe-product-team` is a worked
  reasoning-only, approval-schema product-delivery example; `model-steward` is a
  domain-neutral advisory agent that reviews any model's nets and event evidence
  while writing only its own findings and Protocol summaries. Both install stopped.
- **Built-in runtime agents** can be called from MCP with `invoke_agent`:
  Builder authors nets, Operator diagnoses them, Chronicle summarizes history,
  Persona helps shape residents, and Domain Expert answers grounded questions.
  `start_domain_expert` gives the model a durable self-maintaining domain net.
  These master-hosted agents need a healthy server provider; on provider-free
  Desktop Lite, let the connected MCP model use the underlying curated tools or
  create explicit CLI-backed resident personas instead.

Publish team structure/config with `hub_publish` and `tokens:"config"`; do not
publish a live backlog by default. Credentials are always scrubbed. Inspect with
`hub_show`, install stopped with `hub_install`, fill the repository/context and
credentials, verify, then arm. When a successful sequence repeats, use
`crystallize_session` or `scaffold_tool_net` to propose deterministic replay and
record the promotion in Protocol.

The Safe Product Team is a teaching path, not the scope of the product. The same
runtime models healthcare, research, operations, finance, support, logistics, or
any other domain as named personas plus typed state and deterministic control.
Use the MCP prompt `review-current-model` when you want the Model Steward pattern:
with a server provider it can run from Agent Hub; without one, the connected MCP
model performs the same evidence review interactively and does not pretend the
stopped resident agent ran.

## Optional server-side LLM

The default in a new installation is:

```properties
llm.provider=disabled
```

Most Desktop Lite users can leave it that way and run AI through their connected
client or a CLI-backed persona. If provider-backed AI lanes are specifically
needed unattended, edit `~/.agenticos/desktop/desktop.properties` and choose one of:

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
- Windows: run `AgenticNetOS-<version>-windows-x64.msi`. Current builds are
  unsigned, so SmartScreen may warn on first run. Upgrades install over the
  existing version in place; the msiexec-level upgrade path (previous published
  release installed, data preserved, app serving afterwards) is tested in CI
  before every release. `scripts\build-windows.ps1` still builds the MSI from a
  clone when WiX is installed, or an app-image otherwise.

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
