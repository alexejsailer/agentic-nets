# The Tool Catalog: four flags, two scopes, one registry

When a net needs to reach outside itself — call an API, start a container, run a script, invoke a
reusable sub-workflow — the answer is ONE durable Tool Catalog. Entries are event-sourced tokens
in a `p-tool-catalog` place; large material (OpenAPI docs, script bodies) lives in the blob store
behind immutable URNs. Every entry separates the **contract** (what can be called) from the
**binding** (how it runs) — that split is what lets one catalog describe very different tools.

## The capability string: rwxhludctsm

Agent roles read like a file-permission string, parsed POSITIONALLY (each slot is its letter or
`-`): **r** read · **w** write · **x** execute (run/fire transitions) · **h** http · **l** logs
(event queries) · **u** user (await-token inhabitant) · **d** docker · **c** coordinate (invoke/
delegate personas) · **t** tool-nets · **s** scripts · **m** external MCP servers declared in `action.mcp`. Valid forms: exact prefixes (`rw`, `rwxhl`,
`rwxhludcts`) or explicit positional strings with gaps (`rw------t`, `rwxhl---t`, `rwxh------m`) — `rwt` is NOT
valid (positions are fixed). The `m` slot (position 11) is explicit-only. Subtlety: tool-net AUTHORING (register/scaffold/promote) lives under
**w**, while tool-net INVOKING (list/describe/invoke) is gated by **t** — a persona told to
"invoke tool-nets" needs the t flag, not just x.

## Four of those flags map to the four kinds of tool

- **d (docker)** — discover/start container tools and import images into the catalog. The master
  NEVER builds an image: builds happen on the coding agent's machine; the master only validates
  (temp container + OpenAPI fetch), digest-pins, catalogs, and runs. Re-pushing a tag with new
  content breaks the recorded digest — re-import to re-validate. Always global; status `approved`.
- **h (http)** — call external services AND register them (a base URL + OpenAPI, inline or
  fetched). No container is started, so the status is honestly `registered`, not `approved`.
  Always global. Agents wrap the stored operations into ordinary http transitions.
- **t (tool-nets)** — discover and invoke tool-nets: reusable sub-workflows composing the other
  tools into one callable unit (invoke_tool_net / scaffold_tool_net).
- **s (scripts)** — register executable artifacts (node/sh/bash/python3) that run on the executor.
  RUNNING one is just authoring a command transition, so that stays with write access.

The split is deliberate: earlier everything hid behind one docker flag, so granting script
registration also granted container spawning. Now `d` means containers and `s` means scripts —
neither implies the other. Catalog search/get are granted by ANY of the four and return only the
kinds you hold.

## Global vs local — where a tool lives

Docker images and external HTTP services are inherently shared → always in the GLOBAL catalog
(the `default` model's `p-tool-catalog`). Scripts are usually private to one workflow → each model
gets its own LOCAL catalog, and script registration defaults to the caller's model; pass
`model: "default"` only to make a script global.

**Lookup is local-first**: search and fire-time resolution check the model's own catalog before
the global one, and a local entry with the same id SHADOWS the global one — a model can ship its
own variant of a shared script without disturbing anyone. Results carry `scope: local|global` and
mark shadowed globals. Reading a model's catalog never creates anything in it.

## How a script tool actually fires (the security story)

A command token invokes by REFERENCE, never by content:
```json
{"executor":"script","command":"invoke","args":{"toolId":"nightly-digest","argv":[],"env":{},"timeoutMs":110000}}
```
At FIRE time the master resolves the toolId (local-first), verifies the blob still hashes to the
pinned sha256, and inlines content+digest+runtime into the shipped token (executors are egress-only
and scope-limited — they can't fetch blobs themselves). The executor re-verifies the sha256,
materializes into a content-addressed cache (survives container recreation; a tampered cache file
re-hashes wrong and is rewritten), and runs the declared runtime with stdin closed. **The digest is
checked twice — before it ships and before it runs — so `approved` means cryptographically pinned,
and tampering with a stored blob is a non-event.** If resolution fails, the master ships the token
untouched and that one command fails with a precise error instead of wedging the transition.

## Working the catalog (the native TOOL_CATALOG_* tools)

- **TOOL_CATALOG_SEARCH** {query?, type?, status?, model?, limit?} and **TOOL_CATALOG_GET** {id,
  model?} — inspect before wiring anything; the `model` param is the scope (local-first + global);
  results only include the kinds your flags reveal.
- **TOOL_CATALOG_REGISTER_SCRIPT** {id, name, runtime, content|contentBase64, model?} — defaults
  LOCAL to the given model; pass `model:"default"` to share globally. Scripts cap at 1 MB.
- **TOOL_CATALOG_REGISTER_HTTP** {id, name, baseUrl, openapi|openapiUrl?} — global, `registered`.
- **TOOL_CATALOG_IMPORT_IMAGE** {image, id?} — the image must already be in the local registry;
  import validates + digest-pins. Docker fires re-check the live registry digest against the pin
  at run time — a re-pushed tag stops running until re-imported.
- Entries upsert by id — one current definition per tool; re-registering replaces, never duplicates.
- WRAP_DOCKER_TOOL turns a cataloged container's OpenAPI into ready tool-nets (one per operation).
- Large command output offloads to the blob store (token carries a preview + URN — docs/tokens).

The endgame is crystallization: a capability starts as ad-hoc reasoning, hardens into a cataloged
tool, and becomes something any net can call by id (docs/concepts). NetHub carries catalog entries
with published packages so they survive export/import — docs/nethub.
