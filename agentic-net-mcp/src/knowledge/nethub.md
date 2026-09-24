# NetHub: export, import, remotes and self-contained packages

NetHub is how work leaves one instance and lands runnable on another: publish an artifact,
search and inspect it, install it, locally or from a remote. Curated tools: `hub_publish`,
`hub_search`, `hub_show`, `hub_install`, `hub_add_remote`, `hub_remotes`, `hub_sync_remote`
(native `HUB_*` / `PACKAGE_*` tools are the raw layer).

## Kinds you can publish

- **net**: one net, structure plus inscriptions. **session**: every net of a session.
- **application**: session runtime + manifest + optional browser surface.
- **model**: a whole model; installing creates a NEW model (fresh `targetModelId`, allowlisted).
- **agent**: a persona team with an `agent-manifest`; installs STOPPED (configure, then arm).
- **context**: a context-net session with a `context-manifest` (stores, hierarchy policies,
  structural `kind=link` relations that never fire).
- **toolnet**, **tool** (one catalog entry with its blobs), **catalog**, **blob**.
- **capability**: a whole pack (nets, inscriptions, scripts, seeds, contract, optional app) as ONE
  artifact: `pack.mjs package` then `pack.mjs publish`, then `hub_install {name, version,
  targetModelId}`. The install verifies the signature, binds the app's stores, imports every net
  with inscriptions rewritten for the target (hosts, session ids, `MODEL_ID`), registers scripts
  into the model's LOCAL catalog from sha256-verified blobs, seeds only empty places, writes the
  manifests into the same session and starts every non-link lane (`autoStart:false` to skip).

## Install semantics

- `instancePolicy`: `singleton` (one per model) or `multiple` (each install needs its own
  `targetSessionId`, which namespaces every id). Context installs with `scope: session|agent|task`
  name their owner with `scopeOwnerId`.
- A newer version is an upgrade (nets and inscriptions upserted, scripts re-registered, seeds left
  alone, lanes the new version no longer declares removed); the same version is a reinstall; an
  older one answers 409 `downgrade` unless `allowDowngrade:true`. Agent, context and application
  installs land STOPPED; net, session and toolnet installs keep a running instance running, so
  `pause_model` before publishing from a live model and `resume_model` after.
- `create_model {profile}` bakes the model id into domain-context ids; publish template sources
  per net or from a model created without a profile.
- Uninstall (`DELETE /api/applications/{model}/{session}`, Studio: Uninstall) removes lanes, nets
  and the session and keeps runtime places and tokens.

## Self-contained packages

Publish scans every inscription for `toolId`, `action.image` and blob URNs, resolves them
local-first and bundles the catalog entries with their blobs (base64 + sha256). Install verifies
the package hash, re-verifies each blob, uploads it content-addressed and lands each entry in the
right scope (docker/http global, script/tool-net local), so an installed net RUNS, not just renders.

## Token policy and credentials

`tokens`: `none`, `config` (default: `*-config`/`*-charter` tokens and tokens marked
`config:"true"`) or `all`. Credentials are ALWAYS scrubbed; re-set them after install with
`set_transition_credentials`.

## Export and import

1. `hub_publish {kind, name, version, tokens}`: versioned, survives deletion of the source. A
   `kind:net` package is the designtime PNML plus the inscriptions of ITS transitions; a lane made
   with SET_INSCRIPTION alone has no PNML transition and is omitted, so build lanes with
   `add_transition` or publish `kind:session`/`kind:model`.
2. `hub_show {name, version?, remote?}`: versions, kind, visibility, token policy, tags, size,
   readme, origin. It does not itemize places and lanes; install into a throwaway session and read
   it with `net_overview` when you must know.
3. `hub_install {source?, name, version, targetModelId?, targetSessionId?}`: where a package lands
   is always the model and session you name. Installed lanes of net packages arrive stopped.
4. Start what you want live, re-set credentials, check `list_executors` for command lanes.

## Remotes: two kinds

`hub_add_remote {name, url, kind?, branch?}` registers a source; `hub_search {remote}`,
`hub_show {remote}` and `hub_install {source: name}` use it; `hub_remotes` lists them.

- **peer** (default): another AgenticOS instance's base URL. You see and install its PUBLIC
  artifacts, and only when its operator enabled the public catalog
  (`AGENTICOS_HUB_PUBLIC_CATALOG=true`); without it the peer answers 404. Publishing to your own
  hub never exposes anything by itself.
- **repo**: a git repository (https, ssh or `git@` URL, `branch` default main) or an absolute
  directory path laid out like the node's own package tree,
  `packages/<name>/versions/<version>.json` plus `packages/<name>/package.json` and a generated
  `index.json`. The master keeps a checkout under `~/.agenticos/hub/remotes/<name>`, refreshes it
  at most every five minutes (`hub_sync_remote` forces it; a directory is read in place) and
  installs straight from the files. Nothing in a repository is served publicly, so this is how
  private packages travel: put the artifact in with `pack.mjs publish --repo <dir>` or the
  repository's `tools/nethub.mjs add`, commit, push; every registered runtime sees it on its next
  sync. `AGENTICOS_HUB_REMOTES=repo:nethub=<url>#main,peer:staging=https://host:8083` registers
  remotes at start.

The layout mirror is deliberate: the same artifact JSON moves between a repository, a peer and
the local hub (`/root/packages/<name>/versions/<version>`) without translation. An installed
artifact keeps the visibility it carried, so a private one never reaches the public catalog.

## Where NetHub lives

NetHub is a CLIENT-side surface (MCP and CLI to the master's hub API). In-net agent transitions
use `PACKAGE_SEARCH` / `PACKAGE_PUBLISH` / `PACKAGE_INSTALL`. Everything is content-addressed:
a tool re-registered on a fresh install lands at the URN the catalog already points at.
`EXPORT_PNML` exports the drawing only; NetHub preserves runtime behavior.
