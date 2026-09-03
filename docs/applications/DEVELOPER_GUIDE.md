# Net Application Developer Guide

## Purpose

A Net Application adds a human-facing view to an executable Agentic Net without adding its UI
source code to the closed Studio repository. It is deployed as one versioned NetHub artifact:

```text
application package
├── application manifest
├── ordinary session runtime
│   ├── one or more nets
│   ├── inscriptions
│   ├── permitted initial/configuration tokens
│   └── tool and blob dependencies
└── compiled browser surface
    └── self-contained ESM module registering one custom element
```

Publishing makes that reusable definition available in NetHub. Installing it into a model creates
an application instance: an ordinary runtime session plus an installation manifest pointing to
the verified UI asset. Opening the instance makes Studio load the compiled UI module at runtime.

Studio does **not** run npm, compile TypeScript, edit its route table, or rebuild its Docker image.

## Mental model and terminology

| Term | Definition |
|---|---|
| Application source | The developer's Angular project and net-design files |
| Application package | Versioned `kind: "application"` NetHub artifact with content-addressed UI assets |
| Runtime template | Session bundle carried by the package |
| Application instance | Runtime session installed into a target model |
| Surface | Compiled browser UI mounted by Studio |
| Store role | Stable semantic name mapped to a runtime place |
| Action | Manifest-declared, schema-checked mutation targeting a store role |
| Runtime bridge | Capability object injected into the custom element by Studio |

The net is the source of truth. The UI is a projection and controller over event-sourced tokens.
Deleting browser state must never delete or invalidate runtime state.

## Deployment architecture

```text
Developer workstation
  Angular source ──ng build──> main.js
  Session package ───────────> nets + inscriptions + tokens
             │
             └──app pack──> hello-net-1.0.0.application.json
                                  │
                                  └──PUT /api/hub/applications/...──> NetHub

User installation
  POST /api/hub/install
    ├── verify package and UI blob hashes
    ├── materialize content-addressed UI blob
    ├── import the session runtime into target model
    ├── write application-manifest + application-origin
    └── return modelId + installed sessionId

Studio
  GET /api/applications/{modelId}
    └── installed application appears in navigation

  #/applications/{sessionId}
    ├── resolve installed descriptor
    ├── authenticated GET of declared entry module through the configured gateway
    ├── verify SHA-256 in the browser
    ├── import the module from a temporary blob URL
    ├── create the registered custom element
    └── assign constrained runtime bridge as the element's Angular input
```

The host assignment is an input-delivery mechanism, not a public debugging API. Angular Elements
consumes it in the application component; mounted applications must not depend on reading a
long-lived `element.runtime` property from the DOM.

## Repository and trust boundary

Application source belongs in this public workspace, a fork of it, or an independent public
repository consuming the SDK libraries from this workspace. The private Studio may depend on the public
application contract, but application projects must not depend on private Studio code.

Never import:

- Studio authentication services;
- workspace/session editor services;
- raw node or master clients;
- private Angular components;
- private route definitions.

The public SDK contract and CSS custom properties are the integration boundary. An application is
not an Angular module imported by Studio. It is compiled independently to a browser-native custom
element, so Angular build graphs and source repositories remain completely separate.

## Prerequisites

- Node.js 20 or newer;
- npm 10 or newer;
- an AgenticOS stack with gateway, master, node, and blobstore running;
- a session package describing the runtime nets;
- authorization to upload and install NetHub artifacts.

Install and verify the workspace:

```bash
cd agentic-net-apps
npm install
npm run build
```

## Anatomy of an application project

The workspace contains three complete examples. `hello-net` is intentionally small; `kanban` is
the worked Persona-first pattern documented in the
[Persona Kanban tutorial](PERSONA_KANBAN_TUTORIAL.md). `approval-room` demonstrates
identity-relative guards, safe ambiguous retries, and an additive upgrade/rollback cycle in the
[Approval Room tutorial](APPROVAL_ROOM_TUTORIAL.md).

```text
examples/hello-net/
├── agenticos.app.json
├── runtime/
│   └── session.package.json
└── src/
    ├── index.html
    ├── main.ts
    └── hello-net.component.ts
```

```text
examples/kanban/
├── agenticos.app.json
├── runtime/session.package.json
└── src/
    ├── main.ts
    ├── kanban-model.ts
    ├── kanban-model.spec.ts
    └── persona-kanban.component.ts
```

```text
examples/approval-room/
├── agenticos.app.v1.json
├── agenticos.app.json
├── certification.json
├── runtime/session.package.v1.json
├── runtime/session.package.json
└── src/
    ├── main.ts
    ├── approval-model.ts
    ├── approval-model.spec.ts
    └── approval-room.component.ts
```

`index.html` exists only because the Angular application builder requires it. NetHub does not
package or serve that file. Studio mounts the custom element registered by `main.js`.

## Authoring the runtime

The runtime package is an ordinary session bundle. It must contain at least one net:

```json
{
  "format": "agentic-net-package",
  "formatVersion": "1.5.0",
  "scope": "runtime",
  "kind": "session",
  "manifest": {
    "name": "example-runtime",
    "version": "1.0.0"
  },
  "nets": [
    {
      "netId": "example-main",
      "net": {
        "net": {
          "places": {
            "p-items": { "label": "Items", "x": 100, "y": 100 }
          },
          "transitions": {},
          "arcs": {}
        }
      },
      "inscriptions": {},
      "tokens": {}
    }
  ]
}
```

Create this package by exporting a Studio session, through MCP/CLI tooling, or by maintaining a
reviewed runtime JSON definition. The application packager does not alter net semantics.

### MCP/CLI-authored runtime workflow

The net and the UI do not need to be authored in the same tool. A developer or agent can create
the session and nets through MCP, then publish that runtime template to NetHub:

```text
hub_publish {
  kind: "session",
  name: "task-board-runtime",
  version: "1.0.0",
  modelId: "app-development",
  sessionId: "task-board-design",
  tokens: "config"
}
```

Pull the immutable runtime package into the Angular project:

```bash
AGENTICOS_GATEWAY=http://localhost:8083 \
AGENTICOS_TOKEN='<token>' \
npm run pull-runtime -- \
  --name task-board-runtime \
  --version 1.0.0 \
  --output examples/task-board/runtime/session.package.json
```

Point `runtimePackage` in `agenticos.app.json` at that file. Packaging then combines the exact
NetHub runtime definition with the independently compiled UI. The final upload is a new
`kind: "application"` artifact; the original session artifact may remain as the runtime design
history or be unpublished according to project policy.

### Runtime design rules

1. Use stable place IDs inside one package version.
2. Expose places to the UI through semantic roles, never through UI hardcoding.
3. Keep fields used by ArcQL scalar. Nested arrays and maps may be serialized as JSON strings by
   the event store.
4. Put defaults such as `kind`, `status`, and `createdAt` on declared actions.
5. Use explicit correlation IDs across stores.
6. Include no credentials in packages or initial tokens.
7. Package only safe initial/configuration state.

## Authoring `agenticos.app.json`

This file joins the runtime and UI build outputs:

```json
{
  "$schema": "../../schemas/application-package.schema.json",
  "name": "task-board",
  "version": "1.0.0",
  "displayName": "Task Board",
  "description": "Human task view over an Agentic Net",
  "author": "Example Publisher",
  "visibility": "public",
  "tags": ["application", "tasks"],
  "runtimePackage": "runtime/session.package.json",
  "output": "../../dist/packages/task-board-1.0.0.application.json",
  "ui": {
    "element": "example-task-board-v1",
    "entryFile": "../../dist/task-board/browser/main.js",
    "sdkVersion": "^0.1.0",
    "isolation": "trusted-element"
  },
  "application": {
    "scope": "model",
    "instancePolicy": "singleton",
    "surface": {
      "route": "task-board",
      "icon": "list-checks",
      "defaultView": "open"
    },
    "stores": [],
    "actions": [],
    "agentProtocol": {},
    "permissions": {
      "readStores": [],
      "watchStores": [],
      "actions": []
    }
  }
}
```

The packager supplies `surface.type`, `surface.entry`, `surface.integrity`, `surface.element`,
`surface.sdkVersion`, and `surface.isolation`. Do not write blob URNs by hand.

### Instance policy

`singleton` permits one instance of the application name per model. The default session ID is
`application-<name>`.

`multiple` requires the installer to supply a unique `targetSessionId`. Routes and all runtime
calls use that session ID as the durable installation identifier.

## Store roles

A store binds a public semantic name to one runtime place:

```json
{
  "role": "tasks",
  "placeId": "p-tasks",
  "required": true,
  "description": "Tasks displayed and updated by the board"
}
```

The backend validates that every declared place exists in a net carried by the package. Studio
does not send the place ID to the public UI. The UI calls `runtime.readStore("tasks")`; master
resolves that role against the installed manifest.

Changing a place ID in a later package does not require a UI change as long as the role remains
stable.

## Actions

Actions are the mutation boundary:

```json
{
  "name": "addTask",
  "targetRole": "tasks",
  "description": "Append an open task",
  "defaults": {
    "kind": "task",
    "status": "open"
  },
  "inputSchema": {
    "type": "object",
    "required": ["title"],
    "properties": {
      "title": { "type": "string" },
      "priority": { "enum": ["low", "normal", "high"] }
    }
  }
}
```

The caller input is merged after defaults, and master adds audit metadata. Required inputs are
validated before any event is written. The UI should not use raw place mutation APIs.

Actions may assert the current correlated token before appending:

```json
{
  "guard": {
    "role": "tasks",
    "matchKey": "taskId",
    "where": { "status": ["ready"] }
  }
}
```

`exists:false` is useful for uniqueness checks on a create action. The default is `exists:true`.
A failed guard rejects the action before its primary append. For `exists:false`, the guard role
must be the action's `targetRole`; master derives a stable event-leaf name from the application,
action, match key, and match value. Node's sibling-name uniqueness then makes two concurrent create
requests mutually exclusive as well as rejecting ordinary sequential duplicates.

Guards can compare validated action input with the selected canonical token. This is the runtime
form of identity-relative policy such as separation of duty:

```json
{
  "guard": {
    "role": "requests",
    "matchKey": "requestId",
    "where": { "status": ["pending"] },
    "compare": [
      { "left": "$input.actor", "operator": "notEquals", "right": "$target.requestedBy" }
    ]
  }
}
```

Operands are `$input.<field>` or `$target.<field>`. Operators are `equals`, `notEquals`, `in`, and
`notIn`; the right operand of `in`/`notIn` must resolve to a collection. Every comparison must pass
before the action transaction is submitted. Put authorization invariants here rather than only in
Angular button visibility or Persona instructions.

An action that appends audit/activity can update the newest correlated token in another declared
store:

```json
{
  "effects": [{
    "updateRole": "tasks",
    "matchKey": "taskId",
    "set": { "status": "in-progress" },
    "setFromInput": {
      "assignee": "assignee",
      "updatedAt": "createdAt"
    }
  }]
}
```

`set` supplies constants. `setFromInput` maps target-property names to fields on the merged action
token, including master-added `createdAt`. Missing optional source values are skipped.

### Command emission

A button that means "run X" should not need a request token *and* a dispatcher lane that turns
it into a command. An action may declare a `command`: in the same Node transaction as its
primary append, master writes a CommandToken into the store named by `role`, shaped exactly as
every command lane consumes it, with `${input.field}` interpolated from the merged action token:

```json
{
  "name": "refresh-cost",
  "targetRole": "requests",
  "defaults": { "kind": "app-request", "run": "usage" },
  "command": {
    "role": "usage-cmd",
    "toolId": "scout-usage",
    "env": { "MODEL_ID": "research", "SINCE": "${input.since}" },
    "timeoutMs": 60000
  }
}
```

`role` must be a declared store; `toolId` is required; `executor` (default `script`), `command`
(`invoke`), `expect` (`text`), `argv` and `env` are optional. Env values are strings and a missing
input interpolates to an empty string, never the text `null`. Besides `${input.field}` the scope
offers `${modelId}` (the model the application is installed into), `${application}` and
`${action}`. Prefer references over literals under `env`: a package publish scrubs every literal
string under an `env` key as credential material (`[REDACTED]`), while a `${...}` reference
survives, so `"MODEL_ID": "${modelId}"` is both portable and publishable. The primary token still records
the request (the audit trail), the command token carries `application`, `action` and the
`actionRequestId` so the two can be joined, and the action response returns the command under
`command`. The application never executes anything; the lane consuming the command store does.

### Atomicity and conflicts

Master reads each correlated token together with its Node element version, evaluates the guard,
and submits the primary append plus every active effect as one Node event transaction. Every update
contains `expectedVersion`. Therefore the transaction has all-or-nothing behavior:

- the activity/domain token and its canonical updates commit together;
- a missing effect target or invalid effect rejects the action before any event is submitted;
- a concurrent writer that changed the guarded token causes the whole transaction to roll back;
- the action endpoint returns `409 Conflict` with a refresh-and-retry message to the losing caller;
- a `when` condition that does not match is intentionally skipped and remains visible as
  `applied:false, skipped:"when-condition not met"` in the successful response.

This is optimistic concurrency, not a long-lived lease. It guarantees a single winner for the
guarded commit, but it does not reserve a card for a caller that merely read the store and never
invoked `claimTask`. Clients should treat `409` as normal contention: refresh, select other work,
or retry only if the refreshed lifecycle still permits the action.

### Idempotency and ambiguous responses

Every declared action accepts a caller-provided retry identity. Supply it as
`runtime.invoke(action, input, {idempotencyKey})`, MCP/CLI `idempotencyKey`, the
`Idempotency-Key` HTTP header, or the `idempotencyKey` query parameter. If both HTTP forms are
present they must match.

Mint one key per logical action and retain it across timeout, disconnect, or unknown response.
Reuse it only with exactly the same action input. A committed retry returns the original logical
success with `replayed:true`; the same key with different input returns `409 Conflict`. Keys are
1–200 characters. `actionRequestId` and `actionRequestHash` are reserved system fields and must
never be authored by a UI, Persona, net, or direct token writer.

Idempotency answers “did this logical append already commit?” Optimistic concurrency answers “is
this canonical state still eligible?” Applications usually need both.

## Agent protocol

An optional `agentProtocol` makes an application's operational contract discoverable to Personas:

```json
{
  "agentProtocol": {
    "version": "1.0",
    "taskStoreRole": "tasks",
    "taskIdField": "taskId",
    "readyStatuses": ["ready"],
    "terminalStatuses": ["done", "archived"],
    "poll": "Query ready tasks assigned to your Persona id.",
    "workflow": [
      { "from": "ready", "action": "claimTask", "to": "in-progress" }
    ],
    "rules": ["Re-read before claiming."]
  }
}
```

Master returns this block from the installed descriptor, and MCP/native agent discovery tools pass
it through. It is documentation and machine-readable guidance, not an authorization grant. Store
permissions, action permissions, agent tool flags, and resource scopes still enforce access.

## Permissions

Permissions constrain the runtime bridge:

```json
{
  "readStores": ["tasks"],
  "watchStores": ["tasks"],
  "actions": ["addTask", "completeTask"]
}
```

Every value must reference a declared store or action. Manifest v2 requires a public
`web-component` surface to declare all three lists explicitly; an empty list grants nothing.
First-party `local` surfaces may omit the permission object because they are compiled into Studio.

`watchStores` is part of the public contract. The current Studio bridge implements it as bounded
polling of the role-based store endpoint. Applications must treat each event as a complete
snapshot and replace their local projection. A future server event stream can replace polling
without changing the SDK interface.

## Building the Angular surface

The surface is a standalone Angular component with a `runtime` input:

```ts
import { Component, Input } from '@angular/core';
import { NetApplicationRuntime } from '@agenticos/net-app-sdk';

@Component({
  standalone: true,
  selector: 'example-task-board-source',
  template: `...`
})
export class TaskBoardComponent {
  @Input() runtime?: NetApplicationRuntime;
}
```

Register it in `main.ts`:

```ts
import { provideZonelessChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { defineNetApplicationElement } from '@agenticos/net-app-angular';
import { TaskBoardComponent } from './task-board.component';

void createApplication({
  providers: [provideZonelessChangeDetection()]
}).then(application => {
  defineNetApplicationElement(
    'example-task-board-v1',
    TaskBoardComponent,
    application.injector
  );
});
```

Do not bootstrap the component into an application root. Studio creates the custom element after
the entry module registers it.

### Element naming

Custom-element names must contain a dash. Use a globally distinctive publisher prefix and version
the element name at least by incompatible UI major version:

```text
<publisher>-<application>-v<major>
```

The browser custom-element registry cannot redefine a tag during the same page lifetime. A new
incompatible implementation must use a new tag. Users should reload Studio after an in-place patch
upgrade that retains the same element name.

### Build constraints

The UI entry must be:

- one self-contained ESM file;
- UTF-8 JavaScript;
- free of relative or external chunk imports;
- free of a separate global stylesheet dependency;
- free of hardcoded Studio or gateway URLs.

Angular component styles are included in `main.js` and may use Studio CSS variables. The provided
production example emits one `main.js` file. The packager rejects visible external imports.

Images should initially be embedded as data URLs or rendered from application data. Named asset
blobs are represented in the manifest and served by the backend, but the first SDK packager only
automates the entry module.

## Theme and layout

Studio owns the global application shell, header, navigation, model context, and refresh control.
The custom element owns only its body.

Use inherited CSS variables:

| Variable | Meaning |
|---|---|
| `--bg` | Page background |
| `--panel` | Raised panel background |
| `--card` | Card/input background |
| `--toolbar` | Toolbar surface |
| `--edge` | Borders and dividers |
| `--fg` | Primary text |
| `--muted` | Secondary text |
| `--acc` | Accent/action color |
| `--err` | Error color |
| `--sans` | UI font stack |
| `--mono` | Monospace font stack |

The surface must be responsive within an arbitrary content width. An installed element is usually
narrower than the browser viewport, so set `container-type: inline-size` on the host and use CSS
container queries for layout breakpoints. Viewport media queries alone can leave a multi-column app
clipped inside Studio even though the page itself is wide. Avoid viewport-fixed headers, global
resets, and selectors targeting `body`, `html`, or Studio classes.

## Runtime bridge reference

```ts
interface NetApplicationRuntime {
  readonly context: {
    modelId: string;
    sessionId: string;
    installationId: string;
    name: string;
    version?: string;
  };

  describe(): Promise<ApplicationDescriptor>;
  readStore(role: string): Promise<ApplicationStoreToken[]>;
  watchStore(
    role: string,
    listener: (event: {type: 'snapshot'; role: string; tokens: ApplicationStoreToken[]}) => void,
    intervalMs?: number
  ): () => void;
  invoke<T>(action: string, input: Record<string, unknown>): Promise<T>;
  navigate(command: 'open-app-index' | 'open-underlying-net'): void;
}
```

Always retain and call the unsubscribe function returned by `watchStore` when the component is
destroyed or receives another runtime instance.

## Local development

Build the libraries and example:

```bash
npm run build
```

For the worked example specifically:

```bash
npm run test:kanban
npm run build:kanban
npm run pack:kanban
npm run test:kanban-package
```

Start the public development host:

```bash
npm run dev
```

In the browser:

1. select the built `dist/<app>/browser/main.js`;
2. enter the custom-element name;
3. load the surface;
4. exercise reads, watches, and actions through the in-memory mock runtime.

The dev host validates the browser deployment boundary. It does not validate your real net or
master-side action semantics.

## Packaging

Run:

```bash
node tools/pack-application.mjs \
  --config examples/hello-net/agenticos.app.json
```

The packager:

1. reads and validates required authoring fields;
2. locates the built entry module;
3. requires a self-contained module;
4. computes SHA-256 over the exact UTF-8 source;
5. assigns a content-addressed blob URN;
6. embeds the module as a verified `BlobEntry`;
7. attaches the application manifest to the runtime package;
8. writes a first-class `kind: "application"` artifact.

The output is JSON because it is the native NetHub wire format. It is self-contained and can be
reviewed, signed externally, archived, or transferred without an npm registry.

## Publishing

```bash
AGENTICOS_GATEWAY=http://localhost:8083 \
AGENTICOS_TOKEN='<token>' \
node tools/publish-application.mjs \
  --file dist/packages/hello-net-1.0.0.application.json
```

The upload endpoint is:

```http
PUT /api/hub/applications/{name}/versions/{version}
Content-Type: application/json
Authorization: Bearer <token>
```

Master validates:

- package kind;
- application manifest structure;
- stores against places carried by the runtime;
- action role references;
- permission references;
- custom-element name;
- content-addressed entry URN;
- entry presence in package blobs;
- manifest integrity value against blob SHA-256.

The registry canonicalizes the URL name/version and stamps the whole package with its own content
hash when storing it.

## Installing

Singleton:

```bash
curl -X POST "$GATEWAY/api/hub/install" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "source":"local",
    "name":"task-board",
    "version":"1.0.0",
    "targetModelId":"customer-support"
  }'
```

Multiple-instance application:

```bash
curl -X POST "$GATEWAY/api/hub/install" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "source":"local",
    "name":"task-board",
    "version":"1.0.0",
    "targetModelId":"customer-support",
    "targetSessionId":"task-board-tier-one"
  }'
```

Installation integrity-verifies and materializes UI/tool blobs before importing the runtime. The
application manifest and origin are then written onto the installed session. The application is
immediately returned by the installed-applications API.

## How Studio discovers and mounts the app

Installed list:

```http
GET /api/applications/{modelId}
```

Descriptor by installed session ID:

```http
GET /api/applications/{modelId}/{sessionId}
```

The descriptor's surface contains an authenticated relative URL:

```json
{
  "type": "web-component",
  "element": "example-task-board-v1",
  "integrity": "sha256-...",
  "entryUrl": "/api/applications/customer-support/task-board-tier-one/assets/entry?v=sha256-..."
}
```

Studio resolves that relative URL against its configured gateway, fetches it with authenticated
`HttpClient`, verifies the source in the browser, imports it through a temporary blob URL, creates
the declared element, and assigns the runtime
bridge. No application-specific Studio component or route exists.

## Runtime HTTP API

Public UI code should call only the injected bridge. For diagnostics, the corresponding endpoints
are:

```http
GET  /api/applications/{modelId}/{sessionId}
GET  /api/applications/{modelId}/{sessionId}/stores/{role}/tokens
GET  /api/applications/{modelId}/{sessionId}/stores/{role}/watch
POST /api/applications/{modelId}/{sessionId}/actions/{action}
GET  /api/applications/{modelId}/{sessionId}/assets/{assetName}
```

The gateway recognizes `modelId` in application paths and routes every request to the owning
master in a multi-master deployment.

## Compatibility policy

This first release deliberately has no legacy application-package mode. NetHub discovery and
installation require `kind: "application"`, and the manifest validator requires
`manifestVersion: "2.0"` plus an explicit surface type. A `kind: "session"` artifact merely tagged
`application` is a session, not an installable application. Rebuild it with the public packager
instead of adding compatibility branches to Studio or master.

## Versioning and upgrades

Version the application as one unit. A package version fixes:

- net structure;
- inscriptions/runtime behavior;
- token schemas;
- store/action contract;
- permissions;
- SDK compatibility range;
- compiled UI source.

Use semantic versioning:

- patch: behavior/UI fix without contract changes;
- minor: backward-compatible store/action addition;
- major: incompatible roles, actions, schemas, runtime semantics, or element contract.

Never mutate an already published version. The UI entry is content-addressed, so different
versions can coexist across models and installations.

An upgrade process must define token migration before replacing or removing a place. UI-only
changes should preserve role/action names. If a UI module cannot load, the installed net remains
intact and can still be inspected through Studio and MCP.

Approval Room is the executable additive-version fixture: 1.0 has requests and decisions; 1.1
adds evidence and a change/resubmit loop while preserving existing IDs. Its certification installs
1.0, upgrades to 1.1, rolls back to 1.0, and reinstalls 1.1 while asserting that old state and the
temporarily hidden evidence survive.

## Security model

The current v2 loader supports `isolation: "trusted-element"`. A trusted element executes in the
same browser page as Studio. It is an extension boundary, not a sandbox.

Protections already enforced:

- UI source is carried inside the reviewed package;
- blob SHA-256 is checked at installation;
- package hash is checked at installation;
- Studio loads only manifest-declared assets through its configured authenticated gateway;
- Studio fetches assets with its own authenticated client;
- browser SHA-256 is checked again before import;
- UI receives a role/action bridge, not a JWT or raw node client;
- read and action permissions are enforced server-side.

Important limitation: a content hash proves integrity, not publisher identity. Until publisher
signatures and `sandboxed-frame` isolation are implemented, administrators must install executable
UI packages only from publishers they trust and after reviewing their source/package.

Read [Application certification and readiness](APPLICATION_CERTIFICATION.md) for the explicit
L0–L3 model. The current platform targets L2 trusted beta. Publisher signatures, revocation policy,
and sandboxed or equivalently hardened UI execution remain blockers for L3 public marketplace use.

Do not put secrets in:

- source code;
- compiled bundles;
- manifests;
- tokens;
- action defaults;
- browser local storage.

Use AgenticOS Vault-backed runtime credentials for transitions that need secrets.

## Testing strategy

### UI contract tests

- component accepts `runtime` after connection;
- every watcher is unsubscribed;
- every role/action matches the manifest exactly;
- errors from `readStore` and `invoke` are visible and recoverable;
- snapshots replace local state without creating duplicates;
- component works in light and dark token sets;
- component fits narrow/mobile widths.

### Package tests

- `npm run build` succeeds;
- packager emits one application blob;
- entry blob hash equals `surface.integrity`;
- every store place exists in the runtime package;
- permissions reference declared roles/actions only;
- guards and correlated effects reference declared store roles;
- `agentProtocol.workflow` references declared actions;
- package contains no credential values;
- compiled entry has no external imports.

### Installation tests

- upload appears in `GET /api/hub/catalog?kind=application`;
- install creates the requested session;
- installed descriptor contains `entryUrl`;
- asset endpoint returns JavaScript with `nosniff`;
- role read returns tokens from the resolved place;
- undeclared role/action is rejected;
- action appends the expected event-sourced token;
- Studio opens `#/applications/{sessionId}` without a rebuild.

### Real-stack certification

For applications with consequential workflows, add a reusable-harness scenario covering rejected
guards with no partial state, true concurrent writers, deliberate post-commit response loss,
idempotent replay, different-input conflict, upgrade/rollback, blind Persona discovery, Studio
mounting, and exact disposable-model cleanup. Cleanup must remove both catalog and durable state
even when a Studio/store watcher races deletion; the platform's `DELETING` state prevents that
watcher from lazily reloading the model. The normative gates and Approval Room invocation are in
[Application certification and readiness](APPLICATION_CERTIFICATION.md).

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| `UI entry not found` | Angular build was not run or config path is wrong | Run the app build and verify `ui.entryFile` |
| `external/chunk imports are not allowed` | Angular emitted lazy chunks | Remove lazy imports and keep the element entry self-contained |
| `UI module did not register <...>` | `main.ts` registered another name or failed during evaluation | Match `ui.element` exactly and inspect browser console |
| `integrity verification failed` | Bundle changed after packaging | Re-run the packager; never edit packaged base64 manually |
| Asset returns 404 | Entry URN absent from installed manifest | Inspect the installed descriptor and uploaded package |
| Asset returns 502 | Blobstore unavailable or blob was not materialized | Check blobstore health and reinstall the verified package |
| App is not in navigation | Package was published but not installed in selected model | Install it and select the installation model |
| Multiple install rejected | `targetSessionId` missing or duplicate | Supply a unique session ID |
| Store role rejected | Role absent from manifest or read permission | Fix stores/permissions and publish a new version |
| Action rejected | Action absent, missing required input, or not permitted | Compare call with `applicationManifest.actions` |
| Guard rejected | Correlated token is missing, duplicate, or in the wrong lifecycle state | Re-read the canonical store and retry only if still eligible |
| Action returns 400 for an effect | Match key not found or no dynamic values resolved | Inspect `effects`, correlation field, and `setFromInput` mapping; no append was committed |
| Action returns 409 | Another writer changed the correlated token first | Refresh the store and retry only if the refreshed lifecycle permits it |
| Effect reports `applied:false` | Its `when` condition did not match | Expected skip; inspect the action intent and `when` mapping |
| View does not refresh | Watcher was not registered or polling request fails | Inspect network requests and retain the unsubscribe handle |
| New code not visible after upgrade | Browser already registered the same custom-element tag | Reload Studio or use a new major-version element name |

## Production publication checklist

- [ ] Application name and custom-element tag are globally distinctive.
- [ ] Package uses semantic versioning.
- [ ] Runtime package contains only intended nets and safe tokens.
- [ ] Every store role maps to a real place.
- [ ] Every action has a documented input schema.
- [ ] Permissions are explicit and minimal.
- [ ] UI entry is one self-contained ESM file.
- [ ] UI never hardcodes model, session, place, gateway, or auth values.
- [ ] All runtime watchers are cleaned up.
- [ ] Light, dark, narrow, loading, empty, and error states are tested.
- [ ] Layout breakpoints follow the custom-element host width and do not horizontally clip in Studio.
- [ ] Source and compiled package have been reviewed for secrets.
- [ ] Package builds and packs reproducibly.
- [ ] Installation succeeds in a disposable model.
- [ ] Role reads and actions affect only the installed session's declared stores.
- [ ] Studio mounts the app through the generic application route.
- [ ] Certification cleanup removes the exact disposable model from catalog and durable storage.
- [ ] Upgrade and token-migration policy is documented.
