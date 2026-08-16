# Net Application certification and readiness

This document defines what AgenticOS means when an application “works.” It separates static
package validity from real runtime behavior and separates trusted deployment from a future public,
unreviewed marketplace.

The reusable runtime harness is `agentic-net-apps/tools/certify-application.mjs`; the companion
browser harness is `agentic-net-apps/tools/certify-studio-mount.mjs`. Approval Room drives both
from `agentic-net-apps/examples/approval-room/certification.json`.

## Readiness levels

| Level | Name | Required evidence | Appropriate use |
|---|---|---|---|
| L0 | Package-valid | Build, schema, role/action references, self-contained entry, SHA-256 | Developer artifact only |
| L1 | Runtime-certified | Disposable real-stack install, declared reads/actions, atomic state and audit behavior, cleanup | Controlled integration |
| L2 | Trusted beta | L1 plus Studio mount, blind Persona discovery, concurrency, ambiguous retry, upgrade/rollback, reviewed publisher | Trusted users and reviewed packages |
| L3 | Public-ready | L2 plus cryptographic publisher identity, signature policy/revocation, sandboxed or equivalently hardened execution, capability review | Unreviewed public marketplace |

The current Net Application platform and Approval Room target **L2: trusted beta**. A package hash
is not a publisher signature, and `trusted-element` is not a sandbox. Those are explicit L3 exit
criteria, not documentation caveats that can be waived silently.

## Certification invariants

A certification run must prove all of these categories.

### Package and supply-chain integrity

- package kind, name, and version match the scenario;
- the declared entry asset is embedded;
- decoded bytes match the blob SHA-256 and `surface.integrity`;
- the browser entry is one self-contained ESM module with no external imports;
- manifest roles, actions, guards, effects, permissions, and Persona workflow refer to existing
  runtime/application objects;
- the package carries no credentials.

### Clean installation and discovery

- the harness creates one uniquely named disposable model;
- it stops the model's background transitions so unrelated LLMs cannot mutate the fixture or spend
  provider quota during certification;
- each package version publishes through the same gateway used by clients;
- installation creates or upgrades the requested session;
- list returns exactly one singleton instance;
- describe returns the expected version, roles, actions, surface, and `agentProtocol`;
- a model loaded on demand does not temporarily appear to have an empty application registry.

The last rule matters operationally. Node uses `503 Retry-After` while replaying a cold model.
Master retries that explicit load window and propagates any remaining failure. It must never turn
an upstream failure into an authoritative `[]` response.

### UI delivery and Studio mounting

- the authenticated asset endpoint serves the manifest-declared entry;
- the delivered digest equals the installed integrity value;
- `X-Content-Type-Options: nosniff` and the application integrity header are present;
- Studio's generic route imports the module and finds the declared custom-element registration;
- the element receives only the constrained runtime bridge as its Angular input, and the mounted
  DOM retains no public runtime or raw-place handle;
- the custom element and Studio route have no unintended horizontal overflow or viewport clipping;
- its stores render and an action can refresh canonical state;
- no application-specific private Studio code or route exists.

### Guard and event-state consistency

- self-approval is rejected by a runtime comparison guard;
- a rejected action appends neither its primary audit token nor its effects;
- the durable Node journal contains no event block for that rejected action;
- an independent approval atomically appends one decision and updates one request in one
  EventBlock;
- two racing terminal actions produce one winner, one canonical terminal state, and one terminal
  audit event across exactly one request commit and one verdict commit;
- all correlated updates use optimistic element versions and roll back as one Node transaction.

### Ambiguous retry safety

- the first request reaches the real gateway and commits;
- the harness deliberately destroys the caller-facing connection only after the upstream response
  has completed;
- retrying the identical request and idempotency key returns `replayed: true`;
- exactly one logical token exists;
- the durable Node journal contains exactly one matching EventBlock;
- reusing that key with different input returns `409 Conflict`.

This is stronger than merely sending the same HTTP request twice: it tests the precise
“committed, response lost” failure window.

### Upgrade and rollback

- 1.0 state survives an in-place 1.1 upgrade;
- new 1.1 stores and actions become available;
- a rollback to 1.0 preserves canonical and audit state;
- additive 1.1 data remains in event history while the older contract is active;
- reinstalling 1.1 exposes that data again;
- the installed descriptor always reports the active definition version.

### Persona discoverability

- a newly spawned MCP process advertises application discovery, description, action, query, and
  `idempotencyKey` support;
- it is scoped to the test model and receives neither an application name nor place ID;
- it selects a compatible application from `agentProtocol` alone;
- it resolves the task store role, filters ineligible self-review, derives the workflow action and
  required input, supplies a retry key, and re-reads canonical state.

### Cleanup

- normal runs delete only the exact disposable model they created;
- cleanup executes after success or failure;
- cleanup failure fails certification and is recorded in the report;
- an active Studio/store watcher cannot lazily reload a model once deletion has entered the
  `DELETING` lifecycle state;
- deletion removes both the catalog entry and the complete durable model directory, and a retry
  also removes an orphan directory left by an interrupted older deletion;
- `--keep-model` is explicit and is used only for temporary Studio/Persona inspection.

## Running Approval Room certification

Prerequisites:

```bash
cd agentic-net-apps
npm install
npm run build:approval
npm run pack:approval:v1
npm run pack:approval
npm run test:approval-package:v1
npm run test:approval-package
```

Start Desktop Lite or a full stack, then:

```bash
npm run certify:approval
```

By default the harness uses `http://127.0.0.1:8083`. It accepts a short-lived access token in
`AGENTICOS_TOKEN`. For local Desktop developer testing only, if no token is supplied it exchanges
the Desktop admin secret file for a token without printing the secret or token.

Useful options:

```bash
npm run certify:approval -- --gateway http://127.0.0.1:8083
npm run certify:approval -- --token '<access-token>'
npm run certify:approval -- --keep-model
```

Never commit tokens, admin secrets, or generated Desktop credentials.

### Full L2 run, including Persona and Studio

Retain the clean-room model long enough for the two distribution-level gates, read its exact ID
from the JSON report, then give that same ID to both certifiers:

```bash
npm run certify:approval -- --keep-model

APP_CERT_MODEL=$(node -e \
  "const r=require('./dist/certification/approval-room-latest.json'); if(!r.passed) process.exit(1); process.stdout.write(r.model)")

npm run certify:persona -- --model "$APP_CERT_MODEL"
npm run certify:studio -- --model "$APP_CERT_MODEL" --cleanup-model
```

`certify:studio` launches an ephemeral Playwright Chromium against the Studio served by the
running Desktop distribution. It seeds only a short-lived JWT and the selected model into that
ephemeral context, opens the generic application route, and asserts all of the following:

- the declared custom element becomes visible;
- the mounted DOM exposes neither a runtime capability handle nor a raw-place handle;
- the mounted element fits its actual Studio host width without horizontal clipping;
- Studio's bridge unit contract exposes only the four public methods and strips raw place IDs from
  the descriptor;
- scenario-declared live state renders;
- scenario-declared accessible UI interactions submit an action;
- a semantic store read observes the resulting canonical token;
- the mounted UI refreshes to display that token;
- no page or browser-console errors occur.

It writes a JSON report and a full-page PNG with a SHA-256 digest. `--cleanup-model` is deliberately
guarded: deletion is refused unless the model ID begins with the scenario's disposable
`modelPrefix`. The secret and JWT are never printed or written to either report. Omit
`--cleanup-model` only while actively inspecting the fixture, and delete it afterward. Model
deletion is an atomic lifecycle operation: it publishes `DELETING` before draining the in-memory
registry, so concurrent semantic-store watchers cannot resurrect persistence while its journal is
being removed.

## Scenario format

A scenario names package versions and an ordered sequence of gates:

```json
{
  "name": "approval-room",
  "modelPrefix": "approval-cert",
  "sessionId": "application-approval-room",
  "studio": {
    "application": "application-approval-room",
    "element": "agenticos-approval-room-v1",
    "text": ["Approval Room", "SEPARATION OF DUTY"],
    "action": { "name": "submitRequest", "idempotencyKey": "studio-submit-1", "input": {} },
    "verifyStore": { "role": "requests", "where": { "requestId": "APR-STUDIO" }, "count": 1 },
    "textAfterAction": ["APR-STUDIO"]
  },
  "versions": [
    { "version": "1.0.0", "file": "../../dist/packages/approval-room-1.0.0.application.json" },
    { "version": "1.1.0", "file": "../../dist/packages/approval-room-1.1.0.application.json" }
  ],
  "steps": [
    { "type": "install", "version": "1.0.0" },
    { "type": "descriptor", "version": "1.0.0", "stores": ["requests", "decisions"], "actions": ["submitRequest", "approve", "reject"] }
  ]
}
```

Supported step types:

| Type | Purpose |
|---|---|
| `install` | Install or change the active package version in the same session |
| `descriptor` | Assert the active version and public role/action contract |
| `asset` | Retrieve and hash the browser-delivered UI asset |
| `action` | Invoke a declared action and assert status/body/error |
| `parallel` | Race multiple actions and assert the winner count |
| `store` | Query one semantic role and assert correlated state/count |
| `history` | Query durable Node EventBlocks and assert source, block/transaction/event counts, and event data |
| `drop-response-action` | Commit upstream, hide response, retry with the same identity |
| `list` | Assert singleton discovery |

The harness is intentionally domain-light. Domain behavior lives in scenario data, so another
application can reuse the runner without adding private-platform code.

## Report contract

Every run writes JSON containing start/end timestamps, gateway, application, model, whether the
model was retained, individual checks, and overall success. A release gate must inspect the
current report's timestamps and `passed`; stale reports are not evidence.

Approval Room writes:

```text
agentic-net-apps/dist/certification/approval-room-latest.json
agentic-net-apps/dist/certification/approval-room-studio-latest.json
agentic-net-apps/dist/certification/approval-room-studio.png
agentic-net-apps/dist/certification/persona-discovery-latest.json
```

Generated reports are local evidence and may be gitignored. CI should archive them with test logs
and the exact package digests.

## Adapting the harness to another application

1. Create at least two package definitions if upgrade/rollback matters.
2. Add a scenario with a unique model prefix and stable target session.
3. Express state assertions through semantic roles, not Node paths.
4. Include at least one rejected guard and prove it leaves no partial audit.
5. Include a true concurrent race on one canonical object.
6. Include `drop-response-action` on an append that must not duplicate.
7. Add a blind Persona script when the package advertises an agent workflow.
8. Add a `studio` block that names the custom element, visible fixture evidence, accessible UI
   interactions, and a semantic post-action store assertion.
9. Add package scripts such as `certify:my-app` and `certify:my-app:studio`.
10. Run against the same distribution that will be handed to users, not only source services.

## What L2 does not prove

Passing this harness does not prove:

- publisher identity or absence of malicious JavaScript;
- isolation from Studio DOM, same-origin storage, or other page capabilities;
- correctness of arbitrary third-party transition code;
- performance at production scale;
- accessibility across every assistive technology;
- migration safety for changes not represented in the scenario;
- authorization policy beyond the roles and guards actually tested.

Those require separate security review, load testing, accessibility testing, and release-specific
migration scenarios.

## L3 public-marketplace blockers

Before accepting executable UI from unknown publishers, require at minimum:

1. signed packages bound to a verified publisher identity;
2. a trust-store, revocation, rotation, and compromised-key response policy;
3. signature verification at publication and installation, with the verified identity retained in
   installation metadata;
4. sandboxed-frame isolation or a reviewed equivalent that prevents same-origin Studio access;
5. an explicit, enforceable capability grant presented during installation;
6. CSP and network policy appropriate to the isolation model;
7. dependency/SBOM and malicious-package scanning;
8. a security-reporting and takedown process.

Until these are implemented, label the feature **trusted beta** and operate a reviewed-publisher
allowlist. Do not describe it as a safe public plugin marketplace.
