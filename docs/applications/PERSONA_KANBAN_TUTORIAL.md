# Persona Kanban: complete Net Application tutorial

## What this example proves

Persona Kanban is a complete open-source Angular application and Agentic Net runtime. Install one
versioned NetHub artifact into a model and three actors immediately share the same state:

- a human uses the five-column board inside Studio;
- an MCP-connected coding agent discovers and works tasks through generic application tools;
- a resident Persona agent reads the same task place and writes through the same declared actions.

There is no Kanban database, Kanban backend service, private Studio module, or application-specific
route. The board is a projection over ordinary event-sourced tokens. NetHub installation imports
the runtime, materializes the verified browser module, and registers one installed application
descriptor. Studio's generic application host does the rest.

This tutorial explains the example from source to a real Desktop Lite installation, including how
agents discover work, how lifecycle mutations remain auditable, how to test the package, and where
the current concurrency boundary lies.

## Resulting architecture

```text
public source repository
  examples/kanban/
    Angular component ───────────────┐
    session runtime ───────────────┐ │
    application contract ────────┐ │ │
                                 ▼ ▼ ▼
                         pack-application.mjs
                                 │
                  persona-kanban-1.0.0.application.json
                                 │
                    PUT /api/hub/applications/...
                                 │
                              NetHub
                                 │
                       POST /api/hub/install
                                 │
                    target model (one installation)
             ┌───────────────────┴────────────────────┐
             │                                        │
     p-kanban-cards                           p-kanban-activity
     canonical current state                  append-only audit facts
             ▲                                        ▲
             │ guarded actions + correlated effects   │
             └───────────────────┬────────────────────┘
                                 │
                   installed application contract
                     ├── semantic store roles
                     ├── action schemas
                     ├── agentProtocol
                     └── verified Web Component entry
                                 │
           ┌─────────────────────┼──────────────────────┐
           │                     │                      │
   Studio Kanban UI       MCP-connected agent     resident Persona agent
```

The source of truth is the two-place runtime, not the browser. Closing Studio, refreshing the
page, or upgrading the UI does not lose task state.

## Why two places instead of five

A visual Kanban board has five columns, but a reliable agent work queue needs one cheap query for
current state. Persona Kanban therefore stores one canonical token per task in `cards`. The
`status` property determines the rendered column:

| Status | Meaning | Normal next action |
|---|---|---|
| `backlog` | Captured, not yet declared actionable | `moveTask` to ready |
| `ready` | Actionable and eligible for a worker | `claimTask` |
| `in-progress` | Owned by one human or Persona | `requestReview` or `releaseTask` |
| `review` | Work and evidence await a verdict | `approveTask` or `reopenTask` |
| `done` | Independently accepted outcome | `reopenTask` or `archiveTask` |
| `archived` | Hidden from the active board, retained in history | no normal transition |

Every meaningful change also appends a token to `activity`. That gives the UI a timeline and gives
operators a durable explanation of claims, moves, blockers, review requests, verdicts, and
comments without forcing agents to reconstruct intent from property-update events alone.

Five physical stage places would make the net drawing resemble the UI, but a Persona would have
to join old arrivals across all five places to determine current ownership. A single canonical
place is the better operational contract here. The net still expresses the semantic `audited-by`
link from cards to activity.

## Lifecycle and separation of duties

```text
backlog ──make ready──> ready ──claimTask──> in-progress
   ▲                                           │
   │                                           ├──releaseTask──> ready
   │                                           │
   │                                      requestReview
   │                                           ▼
   └────────────reopenTask────────────────── review
                                                │
                                           approveTask
                                                ▼
                                               done
```

The recommended worker/reviewer boundary is deliberate:

1. a planner or human makes work ready;
2. a worker claims it with a stable Persona id;
3. the worker publishes progress and evidence with `addComment`;
4. the worker calls `requestReview`;
5. a separate reviewer calls `approveTask` or `reopenTask`.

The contract cannot prove that two arbitrary strings represent different real principals. That
policy belongs in Persona charters and capability assignment. The contract and tutorial make the
boundary explicit so an orchestrator can enforce it.

## Source tour

```text
agentic-net-apps/
├── examples/kanban/
│   ├── agenticos.app.json
│   ├── runtime/
│   │   └── session.package.json
│   ├── tsconfig.app.json
│   └── src/
│       ├── index.html
│       ├── main.ts
│       ├── kanban-model.ts
│       ├── kanban-model.spec.ts
│       └── persona-kanban.component.ts
├── projects/
│   ├── net-app-sdk/
│   ├── net-app-angular/
│   └── net-app-dev-host/
├── schemas/application-package.schema.json
└── tools/
    ├── pack-application.mjs
    ├── publish-application.mjs
    └── test-application-package.mjs
```

`agenticos.app.json` is the portable public contract. `session.package.json` is the ordinary net
runtime. The Angular files know only semantic roles and action names. They do not import Studio,
know the target model id, or contain a gateway URL.

## Step 1: inspect the runtime

The runtime has two places and one structural link transition:

```json
{
  "places": {
    "p-kanban-cards": { "label": "Canonical cards" },
    "p-kanban-activity": { "label": "Activity and evidence" }
  },
  "transitions": {
    "t-kanban-activity-link": { "label": "records lifecycle events" }
  }
}
```

The link inscription is `kind:"link"` with relation `audited-by`. It documents the semantic graph
but never fires. State changes occur through manifest-declared application actions, which still
write normal Node events against these runtime places.

The runtime uses `tokenPolicy:"none"`. Installing the example creates an empty board. Published
development tasks never leak into a user's model.

## Step 2: understand the canonical card

`createTask` creates one token shaped like this:

```json
{
  "kind": "kanban-task",
  "taskId": "TASK-42",
  "title": "Add retry evidence to the deployment check",
  "description": "Record the failed attempt, retry, and final health result.",
  "status": "ready",
  "priority": "high",
  "assignee": "",
  "createdBy": "product-manager",
  "labels": ["deployment", "observability"],
  "acceptanceCriteria": [
    "The event trail identifies both attempts",
    "The final health check is attached to the review request"
  ],
  "dueDate": "2026-08-20"
}
```

Master adds `createdAt`, `application`, and `action`. Arrays are serialized into JSON strings at
the leaf-property boundary; the Angular projection parses arrays and strings. Fields intended for
ArcQL selection—`kind`, `taskId`, `status`, `priority`, `assignee`, `archived`—stay scalar.

`taskId` is the durable correlation key. Agents must not substitute the Node leaf UUID or leaf
name for it.

## Step 3: understand guarded actions

The app declares ten actions:

| Action | Primary append | Canonical effect |
|---|---|---|
| `createTask` | cards | creates the canonical task; rejects a duplicate `taskId` |
| `updateTask` | activity | copies supplied editable fields onto the card |
| `moveTask` | activity | sets `status`; intended for human planning/drag-drop |
| `claimTask` | activity | requires `ready`; sets owner and `in-progress` |
| `releaseTask` | activity | requires `in-progress`; clears owner and returns to `ready` |
| `requestReview` | activity | requires `in-progress`; sets `review` and result evidence |
| `approveTask` | activity | requires `review`; sets `done` and completion evidence |
| `reopenTask` | activity | requires `review` or `done`; returns to `ready` |
| `archiveTask` | activity | sets `archived` and hides the card |
| `addComment` | activity | no card mutation; appends progress/evidence only |

A guard is evaluated before the primary audit token is appended:

```json
{
  "guard": {
    "role": "cards",
    "matchKey": "taskId",
    "where": { "status": ["ready"] }
  }
}
```

That prevents a stale worker from claiming a card already moved out of ready in ordinary
cooperative use.

An effect can combine constants and values copied from action input:

```json
{
  "updateRole": "cards",
  "matchKey": "taskId",
  "set": {
    "status": "in-progress",
    "blockedReason": ""
  },
  "setFromInput": {
    "assignee": "assignee",
    "claimedAt": "createdAt",
    "updatedAt": "createdAt"
  }
}
```

This capability is generic. The master contains no Kanban class, status enum, route, or action
switch. Another application can use the same guard/effect contract for tickets, approvals,
inventory, or incident ownership.

Guards and effects are committed with optimistic concurrency. Master reads the card's Node element
version, evaluates `status:ready`, and sends the claim activity append plus all card updates in one
atomic event batch carrying that version. If two Personas observed the same ready card, one batch
wins and the other receives `409 Conflict`; the losing batch appends no claim activity and changes
no card fields. The Persona must refresh and select other work (or retry only if the refreshed card
is eligible again).

This is a hard guarantee for the individual guarded commit, not a long-lived lease acquired by
reading a card. Ownership begins only when `claimTask` succeeds. The card's resulting assignee and
lifecycle rules provide the continuing ownership contract.

```mermaid
sequenceDiagram
    participant A as Persona A
    participant B as Persona B
    participant M as Master App API
    participant N as Node transaction boundary
    A->>M: claimTask(T-42, A)
    B->>M: claimTask(T-42, B)
    M->>N: read card T-42 (version 17, ready)
    M->>N: read card T-42 (version 17, ready)
    M->>N: atomic batch: activity + card updates (expectedVersion 17)
    N-->>A: 200 committed; card is version 18
    M->>N: atomic batch: activity + card updates (expectedVersion 17)
    N-->>B: 409 conflict; no events committed
    B->>M: refresh board
```

The batch may contain several property updates with the same `expectedVersion`. Node evaluates
them against the pre-transaction snapshot and publishes the entire resulting snapshot only after
all events validate. Do not split a canonical state change into several application actions merely
to update several fields; keep those fields in one action's `effects` list.

## Step 4: understand `agentProtocol`

The application manifest includes a machine-readable playbook:

```json
{
  "agentProtocol": {
    "version": "1.0",
    "taskStoreRole": "cards",
    "activityStoreRole": "activity",
    "taskIdField": "taskId",
    "assigneeField": "assignee",
    "readyStatuses": ["ready"],
    "terminalStatuses": ["done", "archived"],
    "poll": "Query the cards store ...",
    "workflow": [
      { "from": "ready", "action": "claimTask", "to": "in-progress" },
      { "from": "in-progress", "action": "requestReview", "to": "review" },
      { "from": "review", "action": "approveTask", "to": "done" }
    ],
    "rules": ["Do not claim a task assigned to another Persona."]
  }
}
```

`application_describe` and the native `DESCRIBE_APPLICATION` return this block. A general-purpose
Persona can therefore recognize the application without embedding the physical place id or a
private product convention in its prompt.

The protocol is guidance plus a contract reference. It does not silently grant a Persona access.
Normal role flags, resource scopes, tool allowlists, and place-write policies still apply.

## Step 5: build and test locally

From the public workspace:

```bash
cd agentic-net-apps
npm install
npm run test:kanban
npm run build:kanban
npm run build:dev-host
```

The production build must emit exactly one self-contained entry module:

```text
dist/persona-kanban/browser/main.js
```

Start the mock host:

```bash
npm run dev
```

Open the displayed localhost URL, then:

1. choose `dist/persona-kanban/browser/main.js`;
2. enter `agenticos-persona-kanban-v1`;
3. select **Load surface**;
4. select **Seed Kanban**;
5. test filtering, editing, comments, claim, review, approval, reopening, drag/drop, and archival;
6. narrow the window to confirm the board scrolls and the drawer remains usable.

The host uses an in-memory implementation of the same `NetApplicationRuntime` interface. It is a
UI contract test, not a substitute for real package installation.

## Step 6: package and verify

```bash
npm run pack:kanban
npm run test:kanban-package
```

The artifact is written to:

```text
dist/packages/persona-kanban-1.0.0.application.json
```

The verifier asserts:

- `kind` is `application`;
- name/version match the authoring config;
- every store resolves to a place carried by the runtime;
- every permitted and agent-workflow action exists;
- the entry is a non-empty, self-contained module below 1 MiB;
- the embedded bytes, blob SHA-256, and manifest integrity are identical;
- the package preserves the exact `agentProtocol` and permissions.

Review the resulting JSON before publishing. The browser code runs as `trusted-element` in the
Studio origin, so installing an application is equivalent to trusting its publisher's browser
code.

## Step 7: obtain a Desktop Lite admin token

Desktop Lite includes gateway, master, node, blobstore, executor, vault, MCP, and the Studio shell.
All listeners bind to loopback. Start AgenticNetOS and wait until the tray reports every service
healthy.

On macOS, the gateway's persistent admin secret is:

```text
~/.agenticos/desktop/gateway/jwt/admin-secret
```

Exchange it for a short-lived JWT without printing the secret:

```bash
GATEWAY=http://127.0.0.1:8083
ADMIN_SECRET="$(<"$HOME/.agenticos/desktop/gateway/jwt/admin-secret")"
TOKEN_RESPONSE="$(curl -fsS -X POST "$GATEWAY/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=agenticos-admin' \
  --data-urlencode "client_secret=$ADMIN_SECRET")"
AGENTICOS_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | jq -r .access_token)"
unset ADMIN_SECRET TOKEN_RESPONSE
export GATEWAY AGENTICOS_TOKEN
```

Do not commit, paste into issue reports, or place either credential in an application package.

## Step 8: publish to local NetHub

```bash
AGENTICOS_GATEWAY="$GATEWAY" npm run publish:kanban
```

Expected result:

```text
persona-kanban@1.0.0 published to http://127.0.0.1:8083
```

Publishing validates the manifest, runtime role mappings, guards/effects, permissions, blob URN,
and SHA-256 again on the server. UI bytes are immutable because their blob URN contains the hash.
The local upload API is an idempotent upsert for development and cross-instance transfer, so it can
move a name/version pointer to different bytes. Treat released semantic versions as immutable by
policy and increment the version whenever published bytes change.

Verify the catalog entry:

```bash
curl -fsS "$GATEWAY/api/hub/artifacts/persona-kanban/versions/1.0.0" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  | jq '{kind, manifest, applicationManifest: {
      name: .applicationManifest.name,
      stores: .applicationManifest.stores,
      actions: [.applicationManifest.actions[].name],
      agentProtocol: .applicationManifest.agentProtocol
    }}'
```

## Step 9: install into a model

Choose an existing model. For a disposable end-to-end model, create it first through the
administrative model API; application installation deliberately does not create model roots:

```bash
MODEL=kanban-e2e

curl -fsS -X POST "$GATEWAY/api/admin/models" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d "{\
    \"modelId\":\"$MODEL\",\
    \"name\":\"Persona Kanban E2E\",\
    \"description\":\"Disposable application acceptance model\",\
    \"profile\":\"standard\"\
  }" | jq '{modelId,name,state,healthy}'

curl -fsS -X POST "$GATEWAY/api/hub/install" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d "{
    \"source\":\"local\",
    \"name\":\"persona-kanban\",
    \"version\":\"1.0.0\",
    \"targetModelId\":\"$MODEL\",
    \"targetSessionId\":\"application-persona-kanban\"
  }" | jq
```

Installation performs these operations in order:

1. load the selected version of the application package;
2. verify the application contract and blob bytes;
3. upload/materialize the content-addressed UI entry in blobstore;
4. create the session and runtime net;
5. create both runtime places and the structural link inscription;
6. write the installed `application-manifest` and `application-origin` session leaves;
7. tag the session as an application;
8. return the installed descriptor.

No transition needs to be armed: lifecycle actions are synchronous declared application actions,
and the one link transition is structural only.

## Step 10: verify the runtime API before opening Studio

List and describe the installed app:

```bash
curl -fsS "$GATEWAY/api/applications/$MODEL" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" | jq

curl -fsS "$GATEWAY/api/applications/$MODEL/application-persona-kanban" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  | jq '{sessionId, name, stores, actions: [.actions[].name], agentProtocol, surface}'
```

Create ready work as a planning Persona:

```bash
curl -fsS -X POST \
  "$GATEWAY/api/applications/$MODEL/application-persona-kanban/actions/createTask" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d '{
    "taskId":"TASK-E2E-1",
    "title":"Prove the installed Kanban lifecycle",
    "description":"Claim, comment, submit, review, and verify through the real runtime.",
    "status":"ready",
    "priority":"high",
    "createdBy":"persona-planner",
    "labels":["e2e","example"],
    "acceptanceCriteria":["Card reaches done","Activity contains claim, evidence, and approval"]
  }' | jq
```

Claim it:

```bash
curl -fsS -X POST \
  "$GATEWAY/api/applications/$MODEL/application-persona-kanban/actions/claimTask" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d '{"taskId":"TASK-E2E-1","assignee":"persona-developer","actor":"persona-developer"}' \
  | jq
```

Verify current state through the semantic role endpoint:

```bash
curl -fsS \
  "$GATEWAY/api/applications/$MODEL/application-persona-kanban/stores/cards/tokens" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  | jq '.tokens[] | select(.properties.taskId == "TASK-E2E-1") | .properties'
```

The card should now report `status:"in-progress"` and
`assignee:"persona-developer"`. Also query `stores/activity/tokens`; it should contain a
`claimed` event for the same `taskId`.

Submit and approve:

```bash
curl -fsS -X POST \
  "$GATEWAY/api/applications/$MODEL/application-persona-kanban/actions/addComment" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d '{"taskId":"TASK-E2E-1","actor":"persona-developer","note":"Build and package checks passed."}' | jq

curl -fsS -X POST \
  "$GATEWAY/api/applications/$MODEL/application-persona-kanban/actions/requestReview" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d '{"taskId":"TASK-E2E-1","actor":"persona-developer","reviewer":"persona-qa","note":"Verified UI build and package SHA-256."}' | jq

curl -fsS -X POST \
  "$GATEWAY/api/applications/$MODEL/application-persona-kanban/actions/approveTask" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d '{"taskId":"TASK-E2E-1","actor":"persona-qa","note":"Independent lifecycle verification passed."}' | jq
```

Re-read both stores. The canonical card should be done; activity should show claimed, commented,
review-requested, and approved events in addition to the card's own creation event history.

## Step 11: verify the UI asset and Studio mount

The descriptor's `surface.entryUrl` is an authenticated, relative gateway URL. Fetch it and compare
the response integrity header:

```bash
ENTRY_PATH="$(curl -fsS "$GATEWAY/api/applications/$MODEL/application-persona-kanban" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" | jq -r .surface.entryUrl)"

curl -fsS "$GATEWAY$ENTRY_PATH" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -D /tmp/persona-kanban.headers \
  -o /tmp/persona-kanban.mjs

shasum -a 256 /tmp/persona-kanban.mjs
grep -i 'x-agentic-app-integrity' /tmp/persona-kanban.headers
```

In Desktop Lite Studio:

1. open `http://127.0.0.1:4200` from the tray;
2. select the target model;
3. choose **Open Apps**;
4. open **Persona Kanban**;
5. confirm the completed end-to-end card appears in Done;
6. create another ready task in the drawer;
7. edit it, add a note, drag it between backlog/ready, claim it, and inspect its activity;
8. select **View net** and confirm cards/activity are ordinary runtime places.

Studio fetches the module through its configured gateway, verifies SHA-256 in the browser, imports
it from a temporary Blob URL, registers `<agenticos-persona-kanban-v1>`, and injects the constrained
runtime bridge. There is no application-specific import in the closed GUI.

## Step 12: let an MCP-connected agent work the board

The MCP server provides a prompt named `work-persona-kanban`. Invoke it with a stable Persona id,
or give the connected agent the equivalent request:

```text
Work one eligible task from Persona Kanban as persona-developer.
Discover the installed application contract first, follow agentProtocol,
publish progress/evidence, request review, and do not self-approve.
```

The expected generic tool sequence is:

```text
application_list
  → application_describe {name:"persona-kanban"}
  → query_tokens {place:<cards placeId>, arcql:'FROM $ WHERE $.kind=="kanban-task" && $.status=="ready"'}
  → application_action {name:"persona-kanban", action:"claimTask", input:{...}}
  → perform work using the Persona charter and authorized tools
  → application_action addComment
  → application_action requestReview
  → query_tokens again to verify status=="review"
```

ArcQL syntax available in a deployment can differ in supported boolean composition. If a combined
predicate is rejected, query ready tasks first and filter assignee/archived in the client. Never
turn a query-parser limitation into permission to claim another Persona's work.

If no eligible task exists, the correct behavior is to report an empty queue and stop. An agent
must not invent backlog work merely to keep itself busy.

## Step 13: connect a resident Persona agent

A resident Persona can poll the board on a schedule or be woken by a separate deterministic lane.
Its charter should contain this bounded loop:

```text
Identity: persona-developer

1. LIST_APPLICATIONS; find persona-kanban.
2. DESCRIBE_APPLICATION; read agentProtocol and resolve cards/actions.
3. QUERY_TOKENS on cards for ready, unarchived tasks that are unassigned or assigned to me.
4. Re-read; APPLICATION_ACTION claimTask using the described action placeId.
5. Perform only work allowed by this charter and repository/context policy.
6. APPLICATION_ACTION addComment with concise evidence.
7. APPLICATION_ACTION requestReview; never call approveTask for my own work.
8. If blocked, record the reason and release the task when another worker should take it.
9. End the turn. Do not spin when no task exists.
```

Give a worker only the application/card read capability, the declared lifecycle actions it needs,
and the external tools required for its domain. A reviewer can receive `approveTask` and
`reopenTask` without repository-write capability. A planner can receive `createTask`, `updateTask`,
and `moveTask` without execution capability.

On provider-free Desktop Lite, create a CLI-backed Persona with Claude Code or Codex for unattended
polling, or let the connected MCP client execute the loop while connected. A provider-backed
Persona does not become unattended merely because it has a schedule when the provider is disabled.

## End-to-end acceptance checklist

An application release is ready only when all layers pass:

### Source and projection

- [ ] `npm run test:kanban` passes normalization, list parsing, filtering, sorting, and due-date tests.
- [ ] production Angular build emits one module below the configured budget.
- [ ] the mock host can create, edit, claim, release, review, approve, reopen, comment, drag, filter, and archive.
- [ ] narrow and wide layouts remain usable.

### Package contract

- [ ] packager resolves both manifest store roles to runtime places.
- [ ] all permission and `agentProtocol.workflow` actions exist.
- [ ] UI entry contains no runtime chunk import.
- [ ] package verifier recomputes the same SHA-256 as the manifest and blob entry.
- [ ] package contains no development task tokens or credentials.

### Installed runtime

- [ ] upload and install succeed through the gateway.
- [ ] installed descriptor exposes cards, activity, ten actions, `agentProtocol`, and `entryUrl`.
- [ ] duplicate `taskId` is rejected before a second card is appended.
- [ ] claiming a non-ready task is rejected before a claim activity is appended.
- [ ] two simultaneous claims produce one success, one HTTP 409, one claim activity, and one assignee.
- [ ] claim copies assignee and changes status.
- [ ] comment appends activity without rewriting card details.
- [ ] review and approval guards enforce the normal order.
- [ ] canonical card and activity are visible with normal net/token tools.

### Studio and agent behavior

- [ ] browser asset hash verification succeeds.
- [ ] generic Studio route mounts the custom element without a private GUI rebuild.
- [ ] UI changes appear in the role endpoints and agent queries.
- [ ] agent actions appear on the board after the next watch snapshot.
- [ ] a worker requests review and does not approve its own result.
- [ ] event/model history supports every displayed lifecycle claim.

## Failure modes and diagnosis

| Symptom | Likely cause | Check |
|---|---|---|
| Install returns 500 and Node reports model 404 | Target model does not exist | Create it with `POST /api/admin/models` or select an existing model |
| Upload returns 400 | Invalid role/action/guard/effect or blob hash | Read the server validation error; rerun pack and package test |
| Install fails before net import | Blobstore unavailable or integrity mismatch | Desktop tray blobstore health; package SHA-256 |
| App absent from Open Apps | Wrong target model or manifest/origin not written | `GET /api/applications/{model}` |
| Surface fails to mount | Wrong element name, stale Studio binary, or asset fetch failure | descriptor `surface`; browser console; asset endpoint |
| Board stays empty after an action | Wrong installation/model or watch permission | role tokens endpoint and manifest permissions |
| Claim rejected | Card is no longer ready or task id is wrong | re-read canonical card |
| Action returns 400 before card/activity changes | Effect target or dynamic value is invalid | inspect action `effects`, match key, and `setFromInput`; the batch rolled back |
| Effect reports `applied:false` | Its `when` condition intentionally skipped it | inspect action intent and effect `when` |
| Labels render as one string | producer double-encoded an array | inspect raw property; emit one JSON array, not JSON text inside JSON text |
| Agent cannot find work | hardcoded place id, wrong model, assignment mismatch, or invalid ArcQL | application describe, then broad ready query |
| Claim returns 409 | another worker committed from the same card version first | refresh the board and select another ready task |

## Extending the example

Safe additions that keep the current contract compatible include:

- swimlane/filter properties such as team, repository, epic, or milestone;
- a `blocked` scalar plus explicit block/unblock actions;
- WIP warnings computed by the UI;
- service-level/due-date metrics;
- reviewer assignment and policy hints;
- links from tasks to repository context or Protocol entries;
- a scheduled digest transition that summarizes cards without mutating them;
- deterministic notification adapters that consume activity copies.

Changes that require a new major application contract include renaming `cards`, changing `taskId`
correlation semantics, removing lifecycle actions, or replacing the custom-element runtime API.

For strict multi-agent exclusive claiming, do not merely add more UI checks. Design a runtime claim
lane that consumes one ready work token under the engine's binding lease and emits the owned token,
then expose a first-class transition-backed application action. That is a runtime semantic change
and should ship as a new major version.

## What to copy into a new application

Copy the pattern, not the names:

1. choose one canonical, easily queried store for current domain state;
2. add an append-only evidence/activity store where human explanations matter;
3. keep selection fields scalar;
4. use stable correlation ids;
5. declare guards for invalid lifecycle state;
6. use `setFromInput` for generic correlated updates;
7. publish an `agentProtocol` so unknown Personas can discover how to participate;
8. build the UI only against semantic roles and actions;
9. verify the self-contained browser artifact and installed runtime separately;
10. treat trusted browser code as a reviewed supply-chain artifact.

Continue with the general [Net Application Developer Guide](DEVELOPER_GUIDE.md) for the complete
SDK, packaging, versioning, security, and production publication reference.
