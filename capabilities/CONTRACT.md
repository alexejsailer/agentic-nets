# Capability Pack Contract v1

Status: **DRAFT for review** (2026-08-29). Defines what a capability pack IS - at runtime, on disk,
and across its lifecycle. One document, three parts:

- [Part A - Runtime shape](#part-a---runtime-shape): what an installed, armed pack looks like inside a model.
- [Part B - On-disk format](#part-b---on-disk-format): how a pack is expressed as files in a git repository.
- [Part C - Distribution and lifecycle](#part-c---distribution-and-lifecycle): export, publish, install, upgrade, lockfile.
- [Part D - Validation and CI](#part-d---validation-and-ci): what makes a pack valid, and how CI proves it.

Implementation status of each mechanism is marked **[LIVE]** (works today, 2.55.0) or
**[PROPOSED]** (this contract specifies it; not yet implemented).

---

## Part A - Runtime shape

An installed pack is **one tagged agent session** inside a model (the system registry is the
`default` model). The session carries:

### A1. Identity and discovery [LIVE]

- Session id: `agent-<pack-name>` by convention (e.g. `agent-token-janitor`).
- Session tags: `agents` (the discovery contract - `find_capabilities` matches on it) and
  `capability-pack`.
- An **agent manifest** on the session carrying: `name`, `displayName`, `domain`, `description`,
  and the `entry` block (A2). `find_capabilities` returns exactly this.

### A2. The front door [LIVE]

Every pack exposes **exactly one NL entry point**:

```
entry:
  inbox:            p-<pack>-task       # write ONE task token here
  outbox:           p-<pack>-output     # await the correlated result here
  correlationField: requestId
```

Task tokens are **flat string fields**: `{requestId, request, ...optional hints}`. Result tokens
carry `requestId`, a `status` from the pack's declared status enum, and the pack's result fields.
`delegate` is sugar over exactly this write-await pair.

Behind the inbox sits the pack's **deciding agent transition**:

- In a **single-domain pack** (one task lane), the deciding agent reads the NL request and picks a
  strategy. token-janitor is this shape.
- In a **multi-net pack** (several member nets), the deciding agent is a **concierge**: it answers
  routing questions and emits a **plan token** (A4) that a deterministic lane executes step-wise.

Either way the rule is the same and non-negotiable: **the agent decides, the pipeline measures.**
Any count, verdict, or success flag in a result token must be produced by a deterministic
transition, never authored by the model.

### A3. Routing knowledge [PROPOSED - the concierge convention]

Multi-net packs carry a place `p-routing-knowledge` holding one token per member net:

```json
{
  "net": "tool-clear-place",
  "purpose": "Bulk-delete every token in one place, with before/after counts",
  "whenToUse": "The request names one place and asks to empty or clean it",
  "inputPlace": "p-clear-task",
  "outputPlace": "p-clear-done",
  "cost": "deterministic, no LLM"
}
```

The concierge's charter is tiny and fixed: *answer only from routing knowledge; emit a plan token;
if nothing matches, emit `status: unsupported` with the nearest match named.* It does not explore
the model. When a builder adds a member net, it writes the routing token **in the same fire** -
the pack documents itself and cannot go stale.

### A4. Plan tokens [PROPOSED]

```json
{
  "requestId": "r-123",
  "plan": {
    "steps": [
      { "net": "tool-preview-place", "inputPlace": "p-preview-task",
        "payload": { "place": "p-inbox" }, "awaitPlace": "p-preview-done" },
      { "net": "tool-clear-place", "inputPlace": "p-clear-task",
        "payload": { "place": "p-inbox" }, "awaitPlace": "p-clear-done" }
    ]
  },
  "clarify": null
}
```

A deterministic executor lane runs the steps in order, threading `requestId`. If the concierge
cannot route, it sets `clarify` to one question instead of a plan; the pack returns it via the
outbox rather than guessing.

### A5. Policy gates [LIVE]

Destructive or scoped packs gate **before** any work: a deterministic transition checks the request
against pack config (e.g. model allowlist, protected places) and emits `status: refused` without
reading anything else. Policy values are pack **config**, declared in the manifest (B2) and
overridable at install time - never hardcoded in inscriptions.

### A6. Metering and the route cache

- Every result token carries metering leaves stamped by the pipeline: `costUsd`, `tokens`,
  `turns` (0 for fully deterministic paths). [LIVE pattern, per-pack rollup via `usage_report`]
- `question -> plan` pairs are appended to `p-route-history`; recurring routes are candidates for
  crystallization into deterministic match rules that fire before the concierge. Target: a pack's
  determinism ratio rises with use. [PROPOSED]

### A7. Engine-fact guardrails (inherited, mandatory)

- Retry/rework loops bounded with ArcQL `< N`, never `!= N` (matches missing and overshoot).
- Capacity lives on producer postsets; never on a self-consumed place (deadlocks the lane).
- Verdicts computed in ONE shell block, emitted as a single boolean with a complementary
  `if(ok)` / `if(!ok)` pair; emit is fan-out, `when` compares to literals only.
- Command-transition scripts travel as pack assets (B1) and are fetched from the blobstore;
  no inscription may depend on a file that was hand-placed in a container.

---

## Part B - On-disk format

### B1. Layout [PROPOSED]

```
capabilities/<name>/
├── capability.yaml              # the manifest (B2) - the only required file besides nets/
├── README.md                    # human docs; rendered by GitHub and by hub_show
├── manifest.runtime.json        # the agent-manifest leaf (registry contract) as exported
├── nets/
│   ├── <net>.pnml.json          # visual structure (EXPORT_PNML output, JSON)
│   ├── <net>.inscriptions.json  # runtime inscriptions for that net
│   └── session-links.inscriptions.json  # session-level typed link transitions
├── charters/<agent>.md          # persona charters for agent transitions
├── seeds/
│   ├── routing.json             # p-routing-knowledge seed tokens (A3)
│   └── <place>.json             # config/policy/knowledge seed tokens, keyed by place name
├── assets/                      # scripts/files command transitions reference by name
└── verify/smoke.json            # smoke cases (D2)
```

**Portability rules:**

1. **Symbolic names only.** Net, place, and transition references use names; the installer remaps
   into target-model ids. A pack containing literal runtime UUIDs is invalid.
2. **Everything travels.** Inscriptions reference assets as `asset://<filename>`; the installer
   uploads `assets/` to the blobstore and rewrites references to the resulting blob ids.
3. **No secrets, ever.** The manifest declares required vault keys; the repo never contains a
   credential value. The installer verifies the keys exist and reports what is missing.
4. **Deterministic export.** `pack export` produces byte-stable output for an unchanged pack
   (sorted keys, stable ordering), so `git diff` shows real changes only.

### B1a. Compact net source — what a human actually writes [IMPLEMENTED v0]

The compiled pair (`.pnml.json` + `.inscriptions.json`) is the *interchange* format — complete
but boilerplate-heavy. Authors write `nets/<net>.net.json` instead and run `pack.mjs build`:

```jsonc
{
  "net": "persona-inspector",
  "session": "agent-place-inspector",
  "places": { "p-inspector-task": "Task inbox (NL entry)", ... },   // labels only
  "transitions": [
    { "id": "t-inspector-parse", "kind": "agent",
      "reads":  { "task": "p-inspector-task",
                  "policy": { "place": "p-inspector-policy", "consume": false } },
      "writes": { "intent": "p-inspector-intent" },
      "agent":  { "tier": "medium", "maxIterations": 6,
                  "charter": "charters/inspector-parse.md" } },      // prompts are MARKDOWN files
    { "id": "t-insp-count", "kind": "http",
      "reads":  { "go": "p-insp-go-count" },
      "writes": { "raw": "p-insp-raw-count", "err": "p-insp-fail" },
      "http":   { "url": "${master}/api/runtime/places/..." } }      // ${master} injected at build
  ]
}
```

Everything else is **derived** by `build`: arcs (one per read/write), deterministic serpentine
layout, preset/postset boilerplate (`FROM $ LIMIT 1`, `take FIRST`, `consume true`, hosts),
default emits (map: one per write; http: `raw`/`err` success-error pair), `mode`, `metadata`.
Proven: rebuilding place-inspector from its compact source produced inscriptions **deep-equal**
to the interactively-verified originals, and the reinstalled build passed its smoke 4/4.

Rules: the compact source is the **source of truth**; the compiled pair is committed alongside it
(reviewable, installable without a build step) and CI verifies `build` leaves no diff. Packs
born from `export` (like token-janitor) have no compact source until someone back-ports one.

### B2. capability.yaml [PROPOSED]

```yaml
apiVersion: agentic-nets.com/capability/v1
name: <kebab-case, unique per repo>
version: <semver>                  # authoritative version of the pack
displayName: <short human name>
domain: <one word/phrase, e.g. platform-maintenance>
description: >-
  One paragraph. This is what find_capabilities and hub_show display.
tags: [agents, capability-pack, ...]
engineMin: "2.55.0"                # oldest engine this pack is proven on

entry:                             # A2, verbatim what the manifest exposes at runtime
  inbox: p-<name>-task
  outbox: p-<name>-output
  correlationField: requestId
  statuses: [done, refused, nothing-to-do, unsupported, failed]

nets:                              # member nets, symbolic name -> files
  - name: persona-<name>
    pnml: nets/persona-<name>.pnml
    inscriptions: nets/persona-<name>.inscriptions.json
    role: front-door               # front-door | tool | verdict

config:                            # policy + tuning, overridable at install
  - key: allowedModels
    default: ["net-lab"]
    description: Models this pack may touch. Gate refuses others.

credentials: []                    # required vault keys: [{key, purpose, required}]

tiers:                             # tier hints per agent transition
  - transition: t-<name>-decide
    tier: worker                   # decision-only agents stay cheap

install:
  targetModelDefault: default      # where the pack lands unless overridden
  sessionId: agent-<name>          # stable session id (A1)

verify: verify/smoke.json
```

---

## Part C - Distribution and lifecycle

### C1. Two channels, one artifact

- **NetHub** [LIVE]: `hub_publish` packages the pack (payload in the blobstore) and
  `hub_install <name>@<version>` installs it. NetHub is the curated, fast channel.
- **Git** [PROPOSED]: any repository with a `capabilities/` tree following Part B is a source.
  Git is where development, review, forks, and third-party sharing happen. This repo is the
  first such source; anyone's repo can be the second.

### C2. Git remotes [PROPOSED]

Extend the existing hub-remote abstraction with a `git` kind - search and install then work
identically against NetHub and any git source:

```
hub_add_remote git+https://github.com/<owner>/<repo>#<ref>[//<path>]
```

- `<ref>` is a branch, tag, or commit SHA; default branch if omitted.
- `<path>` is the capabilities tree inside the repo; default `capabilities/`.
- `hub_search` shallow-fetches at the ref and reads `capability.yaml` files.
- `hub_install <name>@<version>` resolves the version to a tag (C3), fetches, installs.
- One-shot form without a stored remote:
  `hub_install git+https://github.com/<owner>/<repo>#<ref>//<pack-dir>`.

### C3. Versioning

- `version:` in `capability.yaml` is authoritative (semver).
- Per-pack git tags: `<name>/v<semver>` (e.g. `token-janitor/v1.0.0`) let packs evolve
  independently inside one repo.
- The platform release tag `vX.Y.Z` pins the known-good set that shipped with that engine.
- Bump rules: patch = internal fix, same contract; minor = new member nets / config keys /
  statuses; major = a breaking change to the entry block or result fields.

### C4. The lock [PROPOSED]

The installation records every installed pack in `capabilities.lock` (managed by the hub
subsystem, surfaced via `hub_show --installed`):

```json
{
  "name": "token-janitor",
  "version": "1.0.0",
  "source": "git+https://github.com/alexejsailer/agentic-nets#token-janitor/v1.0.0",
  "commitSha": "<resolved at install>",
  "installedAt": "2026-08-29T09:00:00Z",
  "model": "default",
  "sessionId": "agent-token-janitor",
  "assetsDigest": "sha256:..."
}
```

Install is **idempotent and upgrade-aware**: re-installing the recorded version is a no-op;
installing a newer version diffs manifest + nets + seeds and applies the delta. Seeds are never
blind-reseeded on upgrade (the stale-seed-manifest failure class). `hub_install --reinstall`
forces a clean replace after explicit confirmation.

### C5. Lifecycle verbs

| Verb | Direction | Status |
|------|-----------|--------|
| `pack build` | compact `nets/*.net.json` -> compiled pair (offline, no connection) | **IMPLEMENTED v0** |
| `pack export` | running session -> directory | **IMPLEMENTED v0** (`capabilities/tools/pack.mjs export`) |
| `pack install` | directory -> a session in ANY `--model` (id remap via `--suffix`; hosts + agent modelId normalized to the target) | **IMPLEMENTED v0** |
| `pack uninstall` | stop + deregister transitions, delete nets, untag session (runtime places/tokens remain) | **IMPLEMENTED v0** — idempotent: already-absent elements are tolerated and reported, never fatal |
| `pack verify` | installed pack -> smoke verdict | **IMPLEMENTED v0** (`capabilities/tools/pack.mjs verify`, runs D2) |
| `hub_publish` | directory -> NetHub | LIVE (pack layout support PROPOSED) |
| `hub_install` | NetHub or git -> session | LIVE for NetHub, PROPOSED for git |

Install is idempotent where it must be: config seeds are skipped when the place already holds
tokens (never blind-reseed), and the `agent-manifest` leaf is replaced, not re-created — both
learned from a live uninstall/reinstall cycle, where the session node and runtime places survive.

**Tool parity [IMPLEMENTED v0]**: the same compile+install lifecycle is exposed as MCP tools —
curated `install_net` / `uninstall_net` in `agentic-net-mcp` (compiler shared via
`@agenticos/cli/net/compile`; taught by `agenticnets://docs/net-source`). One `install_net` call
takes the compact source + charters + seeds + manifest + tags inline and instantiates a
discoverable pack; its response mandates the verify loop. This puts whole-net injection in reach
of every MCP client, the CLI, and — via `attach_mcp_server {self:true}` + the `m` role flag —
in-net agent personas (builder/forge), with no additional engine surface. Proven on staging
2026-08-29: uninstall_net + install_net cycled place-inspector, find_capabilities rediscovered
it, smoke 4/4.

**Teardown removes the pack from the registry.** A dismantled pack must stop being advertised:
`uninstall_net` removes the discovery tags by default (`untag: []` opts out), because a listed
entry contract whose transitions no longer exist is a lie — `delegate` refuses it as `stopped`
and its "start it first" advice is unfollowable. Teardown is also idempotent: elements already
gone are counted (`alreadyAbsent`) rather than fatal, so a half-finished uninstall can always
be completed by re-running it. Verified against staging 2026-08-30, alongside suffixed copies
(full id remap, original untouched) and cross-model injection (hosts + agent `modelId`
normalized to the target model).

The v0 implementation speaks to any installation through its MCP HTTP endpoint
(`AGENTICOS_MCP_URL` + `AGENTICOS_MCP_TOKEN`), so the same commands work against staging,
a compose deployment, or the Desktop app. Round-trip proven on staging 2026-08-29 with
token-janitor: export -> install as `-e2e` copy -> `find_capabilities` discovery -> smoke
4/4 on both copies. Folding these verbs into `agenticos pack ...` (the CLI) remains open.

Authoring loop: build interactively on a staging model, `pack export`, commit, PR, tag.

### C6. Provenance and trust

Git installs pin a commit SHA in the lock; that is the floor. Publisher signing of NetHub
payloads remains an open roadmap item (tracked since the app-SDK review) and is out of scope
for contract v1. Until then: treat third-party git remotes like third-party code, because that
is what they are - review before installing, pin to SHAs, and note that a pack's policy gates
protect its targets, not your installation from the pack.

---

## Part D - Validation and CI

### D1. Conformance checklist

A pack is **valid** only if all of these hold (checked by `pack verify` and CI):

1. `capability.yaml` parses, semver valid, `engineMin` <= current engine.
2. Entry block present; inbox/outbox places exist in a front-door net; statuses non-empty.
3. Every net has both `.pnml` and `.inscriptions.json`; no literal runtime UUIDs anywhere.
4. Every `asset://` reference resolves to a file in `assets/`.
5. No credential values in the tree; every declared vault key has `purpose`.
6. Multi-net packs: routing seed present with one token per non-front-door net.
7. Loop bounds use `< N`; no capacity on self-consumed places (static lint of inscriptions).
8. `verify/smoke.json` exists with at least: one happy path, one refusal path.

### D2. Smoke format and CI [PROPOSED]

```json
{
  "cases": [
    { "name": "happy-path",
      "inject": { "place": "p-janitor-task",
                  "token": { "requestId": "smoke-1", "request": "preview p-demo in net-lab" } },
      "await":  { "place": "p-janitor-output", "where": "requestId == \"smoke-1\"" },
      "expect": { "status": "done" }, "timeoutSec": 120 },
    { "name": "policy-refusal",
      "inject": { "place": "p-janitor-task",
                  "token": { "requestId": "smoke-2", "request": "clear p-x in forbidden-model" } },
      "await":  { "place": "p-janitor-output", "where": "requestId == \"smoke-2\"" },
      "expect": { "status": "refused" }, "timeoutSec": 60 }
  ]
}
```

CI on every PR touching `capabilities/`: boot an ephemeral compose stack, `pack install` the
changed pack into a scratch model, run every smoke case through injected tokens, assert expected
fields, run NET_DOCTOR, tear down. **A capability change merges the way code merges: green.**

---

## Reference implementation

[`token-janitor/`](token-janitor/) - live on staging as session `agent-token-janitor` in model
`default` since 2026-08-26; its manifest here mirrors the running pack.
