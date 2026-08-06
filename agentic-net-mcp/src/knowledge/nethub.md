# NetHub: export, import, and self-contained packages

NetHub is how work leaves one instance and lands runnable on another: publish an artifact,
search/inspect it, install it — locally or across federated peers. The curated tools are
`hub_publish`, `hub_search`, `hub_show`, `hub_install`, `hub_add_remote` (plus native `HUB_*` /
`PACKAGE_*` tools for raw registry access).

## What you can publish (kinds)

- **net** — one net: structure + inscriptions.
- **session** — every net in a session (a whole workflow bundle).
- **model** — an entire model; installing creates a NEW model (pass a fresh `targetModelId`) that
  joins your allowlist immediately.
- **agent** — a persona-team session with an `agent-manifest` (personas, entry inbox/outbox,
  startPlan, config places, context requirements). Installs STOPPED: configure → arm. The install
  response is a machine-readable configure-then-start checklist.
- **context** — a context-net session with a `context-manifest`: named stores (role → place),
  hierarchy policies (`readPolicy` local-first|local-only|parent-first, `resolution`
  nearest|explicit|merge) and structural `kind=link` relations. Links never fire;
  START_CONTEXT arms only maintenance transitions.
- **toolnet** — a reusable tool-net (net + inscriptions + manifest; re-scaffolded and its manifest
  re-registered on install).
- **tool** — a single tool-catalog entry WITH its blobs (script body / OpenAPI, sha256-pinned).
- **catalog** — an entire catalog (a model's local one, or the global `default`).
- **blob** — raw blobs by URN.

## Agent/context install semantics (instancePolicy, ownership, upgrades)

- **instancePolicy** in the manifest: `singleton` (one instance per model — a second install to a
  different session is refused) or `multiple` (each install REQUIRES a unique `targetSessionId`,
  which becomes a deterministic namespace rewriting every net/place/transition id so instances
  never collide).
- **scopeOwnerId** (context installs): a context with `scope: session|agent|task` must name its
  owner (`scopeOwnerId` = the owning session/agent/task id). Model-scoped contexts derive the
  owner automatically. Agents only bind contexts owned by their own execution frame.
- **Upgrades** are forward-only: reinstalling a newer version preserves runtime tokens and lands
  STOPPED; downgrades are refused (republish a forward migration instead). The install response
  carries `upgrade: {from, to, kind}`.
- **Model profiles** (create_model `profile` param): `standard` (domain context only), `research`
  (+ research-analyst), `knowledge` (+ context-curator + crystallizer), `development` (+ dev-crew
  + crystallizer). Resident agents install STOPPED; a partial provisioning surfaces as an error
  listing per-artifact status — re-run with the same profile to complete (installs are idempotent).

Two canonical domain-boundary examples ship in the local Agent Hub:

- **`safe-product-team`** (`singleton` per model) is a software/product-delivery starter with six bounded
  personas, typed product/repository and approval schemas, status + Protocol reporting, and no
  command/repository/release authority by default. It is one template, not the product boundary.
- **`model-steward`** (`singleton`) is domain-neutral and advisory-only. It reviews any model's
  current sessions/nets/processes and event evidence, then writes only its own reports/findings/
  journal and Protocol. It cannot modify or operate the nets it reviews.

## Self-contained packages — the part that makes installs actually run

A published net used to carry only POINTERS to the tools its inscriptions used (a script's URN, a
docker digest) — installed elsewhere, those dangled and the net could not run. Now publish SCANS
the inscriptions (including stringified command templates) for every referenced `toolId`,
`action.image`, and blob URN, resolves them local-first against the catalog, and bundles the
entries plus the blobs they point at (each base64 + sha256). On install the package integrity hash
is verified first (a tampered artifact is refused), every blob is re-verified and uploaded
content-addressed (same URN resolves identically on any instance), and each catalog entry lands in
the RIGHT scope: docker/http → the global catalog, script/tool-net → the installed model's local
catalog. Result: a net that uses script/http/docker/tool-net tools runs after install, not just
renders.

## Token policy & credential safety

`tokens` on publish: `none` (structure + inscriptions only), `config` (default — also carries
`*-config`/`*-charter` place tokens and tokens marked `config:"true"`, i.e. what a net needs to
run), or `all`. **Credentials are ALWAYS scrubbed** — vault-backed secrets never travel; after
install, re-set them with `set_transition_credentials` on the target.

## The export/import workflow

1. Export: `hub_publish {kind, name, version, tokens}` — versioned, survives deletion of the source.
   A `kind:net` package is the net's DESIGNTIME PNML (places/transitions/arcs) plus the inscriptions
   of those PNML transitions. **A lane created with SET_INSCRIPTION only (a runtime inscription with
   no PNML transition) is NOT in the PNML and is silently omitted** — build lanes with
   `add_transition` (which creates the designtime transition + arcs) if they must travel, or publish
   `kind:session`/`kind:model` to capture everything.
2. Inspect before committing: `hub_show {name, version?}` — versions, kind, tokenPolicy, tags, size,
   readme. Honest limit: it does NOT itemize a net's places/transitions/kinds or its dependency
   manifest (model kind returns only a node count; net/session kinds return no structure). To truly
   evaluate contents, `hub_install` into a THROWAWAY session and inspect with net_overview /
   list_transitions. Browse with `hub_search` (paginated, true totals) or `agenticnets://hub`.
3. Import: `hub_install {name, version, targetModelId?}` — model-kind creates the new model;
   installed nets arrive with runtime places provisioned and lifecycle wired.
4. After install: start the lanes you want live (installed transitions arrive stopped), re-set
   credentials, and check `list_executors` coverage if the net has command lanes (docs/commands).
   Verified: an installed command lane fires within seconds of start (executor auto-discovers the
   new model).

## Federation (peer instances)

`hub_add_remote {name, url}` registers a peer; `hub_search {remote}` browses it and `hub_install`
pulls from it. A peer serves anonymous reads only when its operator enabled the public-catalog
flag — otherwise no token ⇒ nothing. Publishing to your own hub never exposes it externally by
itself.

## Curated vs native, and where NetHub lives

Prefer the curated lowercase `hub_*` tools: the native UPPERCASE `HUB_*` mirror the same API but
are the raw layer. NetHub is a CLIENT-side surface (MCP/CLI → the master's hub API) — in-net agent
transitions do not have HUB_* tools at all; inside a net the portable-package primitives are
`PACKAGE_SEARCH` / `PACKAGE_PUBLISH` / `PACKAGE_INSTALL`.

## Portability guarantee

Everything is content-addressed: the same tool re-registered on a fresh install lands at the same
URN the catalog already points at, so re-imported packages keep working. For a file-level export
of just the drawing, EXPORT_PNML still exists — but NetHub is the path that preserves RUNTIME
behavior, not just the picture.
