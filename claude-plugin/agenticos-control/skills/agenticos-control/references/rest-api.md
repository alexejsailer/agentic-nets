# AgenticOS REST API surface

Master = `:8082`, node = `:8080`, gateway = `:8083`. In gateway mode, master is reached at `{gateway}/api/...`
(same paths) and node-backed operations are best reached through the master **proxy** endpoints below (so no
node routing is needed). All bodies are JSON. `modelId` is the isolated workspace; `sessionId` groups nets.

## Designtime (PNML authoring) — `/api/designtime`
- `POST /api/designtime/nets` — create net `{modelId, sessionId, netId, name}`
- `GET  /api/designtime/nets?modelId=&sessionId=` — list nets in a session
- `GET  /api/designtime/nets/{netId}` · `DELETE /api/designtime/nets/{netId}`
- `POST /api/designtime/nets/{netId}/places` — `{modelId, sessionId, placeId, label, x, y, tokens}`
- `PUT  /api/designtime/nets/{netId}/places/{placeId}` — update x/y/label/tokens (does NOT touch inscriptions)
- `DELETE /api/designtime/nets/{netId}/places/{placeId}`
- `POST /api/designtime/nets/{netId}/transitions` — `{modelId, sessionId, transitionId, label, x, y}`
- `PUT  /api/designtime/nets/{netId}/transitions/{transitionId}` — update x/y/label
- `DELETE /api/designtime/nets/{netId}/transitions/{transitionId}`
- `POST /api/designtime/nets/{netId}/arcs` — `{modelId, sessionId, arcId, sourceId, targetId, label}`
- `GET/PUT/DELETE /api/designtime/nets/{netId}/arcs/{arcId}`
- `POST /api/designtime/nets/{netId}/batch` — batched element ops
- `GET  /api/designtime/nets/{netId}/export?modelId=&sessionId=` — clean structure JSON `{net:{places,transitions,arcs}}` (each with id/label/x/y)

## Runtime (places + tokens + runtime transitions) — `/api/runtime`
- `POST /api/runtime/places` · `GET /api/runtime/places` · `GET/DELETE /api/runtime/places/{placeId}`
- `GET  /api/runtime/places/{placeId}/tokens?modelId=&size=` — read tokens (`{tokens:[{data,_meta}]}` or an array)
- `POST /api/runtime/places/{placeId}/tokens?modelId=` — create token `{name, data}`
- `POST /api/runtime/places/{placeId}/tokens/bulk` · `POST .../tokens/query` (ArcQL) · `POST .../tokens/deleteAll`
- `DELETE /api/runtime/places/{placeId}/tokens/{tokenId}?modelId=` — delete one
- `PUT  /api/runtime/transitions/{transitionId}/inscription` — (avoid for setting values; use assign — see below)

## Transition lifecycle + executor — `/api/transitions`
- `POST /api/transitions/assign` — **the correct way to set an inscription** `{modelId, transitionId, agentId, inscription, credentials}`
- `GET  /api/transitions/{transitionId}/status?modelId=`
- `POST /api/transitions/{transitionId}/start` · `/stop` · `/delete` — body `{modelId}`
- `POST /api/transitions/{transitionId}/fireOnce` — body `{modelId}` (409 while RUNNING -> stop first)
- `POST /api/transitions/{transitionId}/cancelFireOnce`
- `POST /api/transitions/tokens/consume` · `/tokens/release` · `/tokens/emit`
- `GET/POST /api/transitions/{transitionId}/credentials`
- `GET  /api/models/{modelId}/execution/status` — every transition's live `{status, ready, firing, error, schedule, deployedAt}` (best "what's running" view)
- `POST /api/dryrun/transitions/{transitionId}` — dry-run its binding
- `POST /api/verify/transitions/{transitionId}/inscription`

## Programmatic net construction — `/api/petrinet`
- `POST /api/petrinet/{modelId}/commands` — batch `CreateNet, UpsertPlace, UpsertTransition, UpsertArc, SetInscription, Rename, SetProperty, Remove, Batch`
- `POST /api/petrinet/{modelId}/validate` · `GET /api/petrinet/{modelId}/{netId}/pnml` (XML export)

## Node-backed via master proxy (auth-uniform)
- `POST /api/proxy/arcql/{modelId}/query` — `{query:"FROM $ WHERE ..."}`
- `POST /api/proxy/events/{modelId}/execute` — atomic event batch (`createNode/createLeaf/deleteLeaf/updateProperty`)

## Personas / assistants (SSE) — `/api/assistant`
- `GET  /api/assistant/p/personas` — list personas `{id, displayName, description, role, toolCount, triggerMode}`
- `POST /api/assistant/p/{personaId}/{modelId}/chat/start?sessionId=` — `{conversationId}`
- `GET/POST /api/assistant/p/{personaId}/{modelId}/chat/{conversationId}/agent-stream` (SSE; `AgentEvent` frames: thinking/tool_call/tool_result/text/completion/error)
- `POST /api/assistant/universal/{modelId}/chat/start` · `.../chat/{conversationId}/agent-stream` (the Universal Assistant front door)
- `GET  /api/assistant/universal/{modelId}/tools` · `POST .../tools/{toolName}/execute` — call one agent tool over REST
- `GET  /api/assistant/universal/{modelId}/query/{runtime-state|net-overview|session-overview|tool-nets|...}` — read-only queries (some require params)

## Forge (async tool-builder) — `/api/forge`
- `POST /api/forge/{modelId}/runs` — `{prompt}` -> `{requestId, status:"queued"}`
- `GET  /api/forge/{modelId}/runs` — collapsed status `queued -> running -> done|failed`

## Tool-nets + usage + agent tools
- `GET  /api/toolnets/library` · `GET /api/toolnets/{modelId}/{health|candidates}` · `POST /api/toolnets/{modelId}/{sessionId}/{netId}/promote` · `POST /api/toolnets/{modelId}/crystallize/run`
- `GET  /api/usage/{toolnets|tools|transitions|sessions|live}`
- `GET  /api/agent/tools/catalog` — the full tool catalog; `POST /api/agent-action/execute` — run one agent action

## Models, docker, llm
- `GET/POST /api/admin/models` (master mirror) — create needs `{modelId, name}`; `POST /{modelId}/{load|activate|deactivate|unload}`
- `GET  /api/docker/containers` · `POST /api/docker/containers` · `GET /api/registry/images`
- `POST /api/llm/{execute|layout|generate-pnml|repair-pnml|structured}`

## Node direct (:8080, direct mode only)
- `POST /api/events/execute/{modelId}` — canonical write path (event batches)
- `POST /api/arcql/query/{modelId}` — ArcQL (also `?includeReservedFor=`)
- `GET/POST /api/admin/models` — create model `{modelId, name}`
- `GET  /api/models/{modelId}/children/analysis` — sample+summarize a place's tokens
- `GET  /api/models/{modelId}/version` — cheap version poll

Sources of truth (private `core` repo): `core/CLAUDE.md`, `core/agentic-net-master/CLAUDE.md`. These are the
public request/response contracts; nothing here exposes closed-source implementation.
