# Capability model: `rwxhludct` + agent tools

In-net agents (and personas) get a **role** = nine independent capability flags. The role gates which of the
~79 agent tools are available. When you drive a persona or author an `agent`/`llm` transition, you pick a role.

## The nine flags

| Flag | Name | Grants |
|------|------|--------|
| **r** | read | inspect places, tokens, transitions, nets, sessions, blobs |
| **w** | write | create/delete tokens, places, nets, transitions, arcs, inscriptions; author + register tool-nets |
| **x** | execute | deploy / start / stop / fireOnce / execute transitions |
| **h** | http | make HTTP calls |
| **l** | logs | query events, event facets, event trail |
| **u** | user (inhabitant) | AWAIT_TOKEN (fire-and-wait; first-class net participant) |
| **d** | docker | OCI registry discovery + tool-container lifecycle |
| **c** | coordinate | invoke/delegate to personas + collect results |
| **t** | tooling | discover/describe/invoke the tool-net library (use, not author) |

Named roles (canonical flag string): `READ_ONLY r----`, `READ_WRITE rw---`, `READ_WRITE_EXECUTE rwx--`,
`FULL rwxh-`, `FULL_WITH_LOGS rwxhl`, `INHABITANT rwxhlu`, `INHABITANT_WITH_DOCKER rwxhlud`,
`COORDINATOR rwxhludc`, `TOOL_BUILDER rwxhlud-t`. Full coordinator+tooling = `rwxhludct` (the Universal
Assistant and Genesis). `THINK / DONE / FAIL` control tools are always available.

## Tool groups (representative members)

- **READ (r):** QUERY_TOKENS, LIST_PLACES, GET_PLACE_INFO, GET_TRANSITION, GET_NET_STRUCTURE, VERIFY_NET,
  EXPORT_PNML, DESCRIBE_PLACE, LIST_ALL_SESSIONS, LIST_ALL_INSCRIPTIONS, EXTRACT_TOKEN_CONTENT,
  FIND_SHARED_PLACES, GET_SESSION_OVERVIEW, GET_NET_OVERVIEW, DRY_RUN_TRANSITION, VERIFY_INSCRIPTION,
  DIAGNOSE_TRANSITION, OBSERVE_MODEL, SEARCH_KNOWLEDGE, READ_BLOB_TEXT
- **WRITE (w):** CREATE_TOKEN, DELETE_TOKEN, CREATE_RUNTIME_PLACE, CREATE_SESSION, CREATE_NET, DELETE_NET,
  CREATE_PLACE, CREATE_TRANSITION, CREATE_ARC, DELETE_PLACE, DELETE_TRANSITION, DELETE_ARC, SET_INSCRIPTION,
  NET_DOCTOR, ADAPT_INSCRIPTIONS, EMIT_MEMORY, PACKAGE_PUBLISH, PACKAGE_INSTALL, TAG_SESSION,
  REGISTER_TOOL_NET, SCAFFOLD_TOOL_NET, PROMOTE_TOOL_NET
- **EXECUTE (x):** DEPLOY_TRANSITION, START_TRANSITION, STOP_TRANSITION, FIRE_ONCE, EXECUTE_TRANSITION, EXECUTE_TRANSITION_SMART
- **HTTP (h):** HTTP_CALL
- **LOGS (l):** QUERY_EVENTS, GET_EVENT_FACETS, GET_EVENT_TRAIL
- **USER (u):** AWAIT_TOKEN
- **DOCKER (d):** REGISTRY_LIST_IMAGES, REGISTRY_GET_IMAGE_INFO, DOCKER_RUN, DOCKER_STOP, DOCKER_LIST, DOCKER_LOGS
- **COORDINATE (c):** INVOKE_PERSONA, DELEGATE_TASK, COLLECT_RESULTS
- **TOOLING (t):** LIST_TOOL_NETS, DESCRIBE_TOOL_NET, INVOKE_TOOL_NET, TOOLNET_HEALTH, TOOLNET_CANDIDATES

Note: **authoring** tool-nets (REGISTER/SCAFFOLD/PROMOTE_TOOL_NET) is under **w**; **using** the tool-net
library (LIST/DESCRIBE/INVOKE + health/candidates) is under **t**. A pure consumer is `r-------t`.

You can drive these tools without the LLM loop via `POST /api/agent-action/execute` or the per-tool REST
endpoint `POST /api/assistant/universal/{modelId}/tools/{toolName}/execute`. Catalog: `GET /api/agent/tools/catalog`.
