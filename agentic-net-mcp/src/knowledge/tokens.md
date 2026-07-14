# Token shapes, stringification, size

Tokens are leaves under a runtime place; their `data` is what your templates and queries read;
`_meta` (id, name, timestamps) rides alongside and never collides with data fields.

## Stringification — JSON types do NOT round-trip through properties

Token properties store STRINGS. Write an array or nested object into a token and it comes back as
a JSON-ENCODED STRING: `byDay: [1,2,3]` reads back as `"[1,2,3]"`. Consumers must parse
(`JSON.parse` / `fromjson`) — and LLM-produced output can be DOUBLE-encoded (a JSON string inside
a JSON string), so parse, inspect, parse again if needed. This is invisible until it bites;
template paths (`${input.data.history.0}`) handle it transparently (the engine auto-parses
JSON-looking strings), but code that reads raw token payloads must parse explicitly.

## Unique names

Token names must be unique within a place — creating a duplicate 422s. Use
`{descriptive}-{timestamp}-{shortid}` when generating (the curated tools do).

## Size discipline

- Check before you read: `INSPECT_TOKEN_SIZE` classifies a token (SMALL/LARGE), then
  `EXTRACT_TOKEN_CONTENT mode:"auto"` reads large ones safely (windowed).
- `query_tokens` truncates long values in its default projection (marked, e.g. `_truncated`) —
  raise `maxValueLength` or project `fields` when you need full payloads.
- Executor stdout > ~128KB offloads to the blobstore; the result token carries a blob URN — fetch
  with READ_BLOB_TEXT.
- Server storage and reads are verified to carry 100KB+ token properties intact (node, gateway,
  and ArcQL paths). **If you ever see a payload cut at a suspiciously round length (e.g. exactly
  65536 chars, mid-JSON), suspect YOUR client's tool-output cap before the platform** — MCP
  clients truncate large tool results; re-read with a `fields` projection or EXTRACT_TOKEN_CONTENT
  windows instead of one giant read. Validate JSON completeness before feeding a big payload to an
  LLM — a plausible-looking analysis of truncated garbage is the worst failure mode.

## Config tokens

Long-lived configuration is a token in a `*-config` place read with `consume:false` — scheduled
lanes re-read it every tick. Remember both caveats: it is event-sourced (never put secrets in it —
docs/security) and stringified (nested config objects come back as strings).

## Design-time `tokens: 0` is not live state

The PNML export's per-place `tokens` field is the initial marking, never updated by firing. Live
counts come from `query_tokens` / `net_overview`, not from the drawing (docs/architecture).
