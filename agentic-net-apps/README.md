# AgenticOS Net App SDK

This open-source Angular workspace is the authoring and packaging boundary for UI applications
that run on Agentic Nets. An application developer compiles a normal Angular component into a
browser custom element, combines it with an ordinary session runtime, and uploads one
`kind: "application"` artifact to NetHub. The closed Studio discovers and mounts the compiled
surface at runtime; Studio is not rebuilt and never imports the application's source code.

Read the complete [Net Application Developer Guide](../docs/applications/DEVELOPER_GUIDE.md)
before publishing a production application. For the full human + Persona example, follow the
[Persona Kanban tutorial](../docs/applications/PERSONA_KANBAN_TUTORIAL.md). For identity-relative
guards, ambiguous retry, and version lifecycle, use the
[Approval Room tutorial](../docs/applications/APPROVAL_ROOM_TUTORIAL.md) and the
[certification specification](../docs/applications/APPLICATION_CERTIFICATION.md).

## Quick start

```bash
npm install
npm run build
npm run pack:example
npm run pack:kanban
npm run test:kanban-package
npm run pack:approval:v1
npm run pack:approval
npm run test:approval-package:v1
npm run test:approval-package
```

The example package is written to:

```text
dist/packages/hello-net-1.0.0.application.json
dist/packages/persona-kanban-1.0.0.application.json
dist/packages/approval-room-1.0.0.application.json
dist/packages/approval-room-1.1.0.application.json
```

Run the development host:

```bash
npm run dev
```

Then select `dist/persona-kanban/browser/main.js`, keep the element name
`agenticos-persona-kanban-v1`, load the surface, and choose **Seed Kanban**. The host supplies an
in-memory implementation of the same runtime bridge Studio injects after installation.

Publish to a running stack:

```bash
AGENTICOS_GATEWAY=http://localhost:8083 \
AGENTICOS_TOKEN='<access-token-if-required>' \
npm run publish:example
```

Install into a model:

```bash
curl -X POST http://localhost:8083/api/hub/install \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AGENTICOS_TOKEN" \
  -d '{
    "source":"local",
    "name":"hello-net",
    "version":"1.0.0",
    "targetModelId":"my-model",
    "targetSessionId":"application-hello-net"
  }'
```

Open `#/applications/application-hello-net` in Studio.

## Workspace contents

| Path | Purpose |
|---|---|
| `projects/net-app-sdk` | Framework-neutral runtime and descriptor TypeScript contracts |
| `projects/net-app-angular` | Angular custom-element registration helper |
| `projects/net-app-dev-host` | Local host with a mock application runtime |
| `examples/hello-net` | Complete Angular + session runtime example |
| `examples/kanban` | Full Persona-facing Kanban board, guarded lifecycle, tests, and agent protocol |
| `examples/approval-room` | Independent decisions, input-relative guards, retry safety, and upgrade/rollback fixture |
| `schemas` | JSON Schema for `agenticos.app.json` |
| `tools/pull-runtime.mjs` | Downloads an MCP/CLI-authored session package from NetHub |
| `tools/pack-application.mjs` | Creates a self-contained NetHub application artifact |
| `tools/publish-application.mjs` | Uploads a pre-built application through the gateway |
| `tools/test-application-package.mjs` | Re-verifies roles, actions, agent workflow, module shape, and SHA-256 |
| `tools/certify-application.mjs` | Reusable disposable-model, real-stack certification runner |
| `tools/certify-studio-mount.mjs` | Generic real-Studio custom-element, UI interaction, semantic-state, refresh, screenshot, and cleanup gate |
| `tools/certify-persona-discovery.mjs` | Blind MCP Persona discovery and action acceptance test |

## Trusted-beta certification

With Desktop Lite or a full stack running:

```bash
npm run certify:approval
```

This exercises package integrity, publish/install, role reads, separation of duty, atomic audit
effects and durable EventBlocks, concurrent decisions, deliberate response loss plus idempotent
retry, version upgrade/rollback, singleton discovery, and exact clean-room cleanup. Retain a model
with `--keep-model`, then run `certify:persona` and `certify:studio -- --model <id>
--cleanup-model` for the blind-agent and actual closed-Studio gates. See the certification
specification for readiness levels. Executable UI currently uses same-origin `trusted-element`
isolation, so only reviewed packages from trusted publishers are appropriate; public marketplace
use still requires publisher signatures and stronger isolation.
