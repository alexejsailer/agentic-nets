# Approval Room: end-to-end Net Application tutorial

Approval Room is the reference application for decisions that require an identity other than the
requester. It is intentionally different from a task board: the canonical object is an approval
request, the write history is append-only, and the important invariant is separation of duty.

The example proves that a public Angular application and a public net/runtime definition can be
published and installed without importing application code into the closed Studio. Studio knows
only the generic Net Application contract.

Source:

```text
agentic-net-apps/examples/approval-room/
├── agenticos.app.v1.json             # 1.0.0 contract
├── agenticos.app.json                # 1.1.0 contract
├── certification.json                # executable acceptance scenario
├── runtime/
│   ├── session.package.v1.json       # requests + decisions
│   └── session.package.json          # adds evidence
└── src/
    ├── approval-model.ts             # pure projection helpers
    ├── approval-model.spec.ts        # model tests
    ├── approval-room.component.ts    # Angular surface
    ├── main.ts                       # custom-element registration
    └── index.html                    # Angular build input only
```

## 1. Understand what gets deployed

There are three distinct lifecycle objects:

```text
source tree ──build + pack──> versioned NetHub application package
                                      │
                                      └──install──> model-local application instance
```

The source tree contains real Angular and runtime code. The package contains the compiled,
self-contained JavaScript module, runtime session package, application manifest, hashes, and
metadata. Installation imports the runtime into the chosen model and writes the installed
manifest into the new session.

The closed Studio is unchanged:

1. it lists installed manifests through `GET /api/applications/{modelId}`;
2. it shows one generic route, `#/applications/{sessionId}`;
3. it retrieves the manifest-declared entry asset through the authenticated gateway;
4. it verifies the SHA-256 digest in the browser;
5. it imports the module and creates the declared custom element;
6. it assigns a constrained `runtime` bridge as the element's Angular input.

Angular Elements consumes that input inside the component. The capability object is not retained
as a public `element.runtime` handle after mounting, so browser tests interact with the rendered UI
and verify resulting state through the semantic application API.

No Angular source, Angular module, or application-specific route is copied into Studio.

## 2. Model the domain as event-sourced stores

Approval Room 1.1 declares three stable semantic store roles:

| Role | Runtime place | Responsibility |
|---|---|---|
| `requests` | `p-approval-requests` | Canonical current state, exactly one token per `requestId` |
| `decisions` | `p-approval-decisions` | Append-only review, decision, and resubmission history |
| `evidence` | `p-approval-evidence` | Append-only public-safe evidence references |

The place IDs are runtime details. The UI and Personas ask for `requests`, `decisions`, or
`evidence`; Master resolves the installed mapping. This lets a later package change net layout
without teaching every consumer a new place ID.

The net also contains link transitions that make the request-to-decision and request-to-evidence
relationships visible in the net design. Application actions are still the authoritative write
boundary: they validate input and commit the canonical update and audit append atomically.

### Canonical token

A request token is small and queryable:

```json
{
  "kind": "approval-request",
  "requestId": "APR-42",
  "title": "Promote release 3.2 to production",
  "summary": "Certification report and rollback plan are attached.",
  "status": "pending",
  "risk": "high",
  "requestedBy": "persona-release-manager",
  "requestedAt": "2026-08-15T12:00:00Z",
  "dueDate": "2026-08-16"
}
```

Keep correlation and lifecycle fields scalar so Personas can query them with ArcQL. Put secrets
nowhere in these tokens; evidence should be a safe reference or summary.

## 3. Declare mutations instead of exposing raw storage

The 1.1 manifest declares six actions:

| Action | Result |
|---|---|
| `submitRequest` | Creates one unique pending request |
| `addEvidence` | Appends evidence without changing lifecycle |
| `approve` | Appends an approval and changes canonical status to `approved` |
| `reject` | Appends a rejection and changes canonical status to `rejected` |
| `requestChanges` | Records review feedback and changes status to `changes-requested` |
| `resubmit` | Lets the original requester return the item to `pending` |

For example, `approve` contains a runtime-enforced identity comparison:

```json
{
  "name": "approve",
  "targetRole": "decisions",
  "guard": {
    "role": "requests",
    "matchKey": "requestId",
    "where": { "status": ["pending"] },
    "compare": [
      {
        "left": "$input.actor",
        "operator": "notEquals",
        "right": "$target.requestedBy"
      }
    ]
  },
  "effects": [
    {
      "updateRole": "requests",
      "matchKey": "requestId",
      "set": { "status": "approved", "changeNote": "" },
      "setFromInput": {
        "decidedBy": "actor",
        "decidedAt": "createdAt",
        "decisionNote": "note"
      }
    }
  ]
}
```

`$input` is the validated and defaulted action token. `$target` is the unique canonical token
selected by `role`, `matchKey`, and `where`. Supported comparison operators are `equals`,
`notEquals`, `in`, and `notIn`. Either operand may reference `$input.<field>` or
`$target.<field>`; `in`/`notIn` require the right operand to resolve to a collection.

The comparison is not merely UI validation. Master evaluates it immediately before producing a
single optimistic Node transaction. The decision append and canonical update either both commit
or neither commits.

`resubmit` reverses the comparison: `$input.actor equals $target.requestedBy`. The requester is the
only identity allowed to resubmit after changes were requested.

## 4. Make every logical action safely retryable

Transport failure is ambiguous: the server may have committed even though the client never saw
the response. Every application action accepts an idempotency key through the SDK, MCP, CLI, the
`Idempotency-Key` HTTP header, or the `idempotencyKey` query parameter.

The rules are strict:

- mint one key for one logical action;
- retain it until a definitive response arrives;
- reuse it only with the identical model, application, action, and input;
- keys are 1–200 characters and use the documented safe character set;
- a matching retry returns the original success with `replayed: true`;
- the same key with different input returns `409 Conflict`;
- never author `actionRequestId` or `actionRequestHash`; those are system audit fields.

The Angular surface keeps the key per action/input fingerprint:

```ts
const fingerprint = `${action}:${JSON.stringify(input)}`;
const idempotencyKey = retryKeys.get(fingerprint) ?? crypto.randomUUID();
retryKeys.set(fingerprint, idempotencyKey);

try {
  const result = await runtime.invoke(action, input, { idempotencyKey });
  retryKeys.delete(fingerprint); // a definitive success was received
  await refresh();
} catch (error) {
  // Keep the key. A user retry represents the same logical attempt.
}
```

Do not automatically retry a `409` optimistic conflict with a new key. Re-read canonical state
first. A competing reviewer may already have made the request terminal.

## 5. Teach a Persona without hard-coded application knowledge

The manifest's `agentProtocol` is machine-readable operational documentation. It names the task
store role and request ID field, lists ready and terminal states, describes polling, exposes a
workflow, and states separation-of-duty and retry rules.

A blind Persona follows this algorithm:

1. call `application_list` for its current model;
2. call `application_describe` for candidates;
3. select a descriptor whose protocol advertises pending approval work;
4. resolve `agentProtocol.taskStoreRole` through the descriptor;
5. query pending tokens and exclude `requestedBy == personaId`;
6. derive the applicable workflow action and required input schema;
7. invoke it with a stable idempotency key;
8. re-read canonical and audit state.

The acceptance script deliberately receives no application name or place ID:

```bash
npm run certify:persona -- \
  --model approval-cert-<id> \
  --persona persona-independent-reviewer
```

It starts the bundled MCP server over stdio, inspects its advertised tool schemas, discovers the
application, chooses the approval workflow, invokes it, and verifies the canonical result.

## 6. Build and test locally

From the public repository:

```bash
cd agentic-net-apps
npm install
npm run test:approval
npm run build:approval
npm run pack:approval:v1
npm run pack:approval
npm run test:approval-package:v1
npm run test:approval-package
```

The production build registers `agenticos-approval-room-v1` and emits one self-contained ESM file:

```text
dist/approval-room/browser/main.js
```

The packager embeds it into:

```text
dist/packages/approval-room-1.0.0.application.json
dist/packages/approval-room-1.1.0.application.json
```

The package verifier checks manifest/runtime agreement, role and permission references, action
guards and effects, workflow action names, a self-contained module, and SHA-256 integrity.

For UI-only iteration, run:

```bash
npm run dev
```

Load `dist/approval-room/browser/main.js` in the development host with element name
`agenticos-approval-room-v1`. The host is useful for layout and projection behavior; it is not a
substitute for real-stack concurrency, installation, or event-state tests.

## 7. Publish and install

With a running Desktop Lite or full stack:

```bash
export AGENTICOS_GATEWAY=http://127.0.0.1:8083
export AGENTICOS_TOKEN='<short-lived-access-token>'

npm run publish:approval
```

Or publish the package directly:

```bash
curl -X PUT \
  "$AGENTICOS_GATEWAY/api/hub/applications/approval-room/versions/1.1.0" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @dist/packages/approval-room-1.1.0.application.json
```

Install it into an existing model:

```bash
curl -X POST "$AGENTICOS_GATEWAY/api/hub/install" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "local",
    "name": "approval-room",
    "version": "1.1.0",
    "targetModelId": "my-model",
    "targetSessionId": "application-approval-room"
  }'
```

Installation is server-side. It verifies the package, materializes the content-addressed UI blob,
imports or upgrades the runtime session, and writes the installed manifest and origin metadata.
It does not rebuild or restart Studio.

In Studio, select `my-model`, open **Apps**, choose **Approval Room**, or navigate to:

```text
#/applications/application-approval-room
```

## 8. Exercise the HTTP contract

List and describe the installed instance:

```bash
curl -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  "$AGENTICOS_GATEWAY/api/applications/my-model"

curl -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  "$AGENTICOS_GATEWAY/api/applications/my-model/application-approval-room"
```

Submit a request:

```bash
curl -X POST \
  "$AGENTICOS_GATEWAY/api/applications/my-model/application-approval-room/actions/submitRequest" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: apr-42-submit' \
  -d '{
    "requestId": "APR-42",
    "title": "Promote release 3.2",
    "risk": "high",
    "requestedBy": "persona-release-manager",
    "requestedAt": "2026-08-15T12:00:00Z"
  }'
```

An independent reviewer approves it:

```bash
curl -X POST \
  "$AGENTICOS_GATEWAY/api/applications/my-model/application-approval-room/actions/approve" \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: apr-42-approval' \
  -d '{
    "requestId": "APR-42",
    "actor": "persona-security-reviewer",
    "note": "Certification and rollback evidence passed."
  }'
```

The same request with `actor: persona-release-manager` is rejected before any audit event is
appended. Two independent reviewers racing `approve` versus `reject` produce one winner; the
other receives a guard or optimistic-conflict response. The requests store has one terminal
state, and decisions has one terminal audit record.

## 9. Upgrade and roll back without losing state

Version 1.0 contains requests, decisions, and three actions. Version 1.1 adds the evidence place,
three actions, and the `changes-requested → resubmit → pending` loop. It retains the original net,
place, session, role, and custom-element IDs.

Installing 1.1 into the same target session upgrades the definition in place. Existing request and
decision tokens survive. Installing 1.0 again is a definition rollback: evidence becomes
unavailable through the older contract but remains event-sourced. Reinstalling 1.1 makes the same
evidence visible again.

This is safe here because the change is additive. For a real application, never remove or rename a
place until a migration has copied and verified its tokens. Treat rollback compatibility as an
explicit release property, not an assumption.

## 10. Run the real-stack certification

Build and package both versions, start the stack, then run:

```bash
npm run certify:approval
```

The harness creates a uniquely named disposable model, runs package and server checks, and deletes
that exact model even on failure. To retain a run temporarily for Studio or Persona inspection:

```bash
npm run certify:approval -- --keep-model
```

The report is written to:

```text
dist/certification/approval-room-latest.json
```

For the complete trusted-beta gate, keep one run and use its exact model for blind Persona and
real Studio mounting checks:

```bash
npm run certify:approval -- --keep-model
APP_CERT_MODEL=$(node -e \
  "const r=require('./dist/certification/approval-room-latest.json'); if(!r.passed) process.exit(1); process.stdout.write(r.model)")
npm run certify:persona -- --model "$APP_CERT_MODEL"
npm run certify:studio -- --model "$APP_CERT_MODEL" --cleanup-model
```

The Studio certificate is not an asset-only approximation. It opens the closed Studio shipped by
Desktop Lite, mounts `<agenticos-approval-room-v1>` through the generic route, verifies that the DOM
exposes neither the runtime capability nor a raw-place handle, renders existing approval state,
submits a uniquely titled request through the actual form, re-reads it from the semantic `requests`
store, waits for the UI projection to refresh, and captures a hashed screenshot. The guarded
cleanup then removes only that disposable model. The Studio unit suite separately pins descriptor
sanitization so the bridge exposes semantic roles and never manifest `placeId` values.

The tested gates and readiness meaning are specified in
[Application certification and readiness](APPLICATION_CERTIFICATION.md).

## 11. Security boundary

Approval Room is suitable for a trusted beta, not an unreviewed public marketplace. Its
`trusted-element` JavaScript executes in Studio's origin. Hash verification proves that installed
bytes match the reviewed package; it does not prove who authored those bytes and it does not
sandbox them.

Until publisher signatures and a sandboxed/capability-hardened surface exist:

- install executable packages only from trusted publishers;
- review source and generated package before publication;
- keep permissions minimal;
- never expose tokens, gateway credentials, or raw clients to the element;
- keep consequential authorization in runtime guards, not UI controls;
- retain an event-sourced audit trail and re-read it after actions.

That distinction is deliberate: Approval Room proves the architecture and trusted-install
workflow. It does not pretend content hashing is publisher authentication.
