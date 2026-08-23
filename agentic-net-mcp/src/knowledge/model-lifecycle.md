# Model lifecycle: active, inactive, cataloged

Two independent axes decide what a model does: whether master fires its transitions, and
whether node holds it in memory. Confusing them is the usual cause of "I switched it off and
it came back".

- **ACTIVE** — loaded, master polls and fires it, writes accepted.
- **INACTIVE** — loaded and readable, writes rejected, master stops polling. Transition
  statuses are preserved, so reactivating resumes exactly where it stopped.
- **CATALOGED** — on disk, indexed, NOT in memory. No reads until loaded.
- **ERROR** — a load failed; the failed registration lingers, so this needs an explicit retry.

LOADING/UNLOADING/DELETING are transitional: wait them out, never act on them.

## The four verbs

On node (`/node-api/...` through the gateway):

| Intent | Call |
|---|---|
| Stop firing, keep readable | `POST /admin/models/{id}/deactivate` |
| Resume firing | `POST /admin/models/{id}/activate` |
| Free the memory | `POST /admin/models/{id}/unload` |
| Bring it back | `POST /admin/models/{id}/load` |

`activate` and `deactivate` are strict: each returns 400 unless the model is in the exact
opposite state. You cannot `activate` a CATALOGED model — that is a `load`. The error body
names the current state.

`load` on an already-loaded model is a deliberate no-op; replaying persistence over a live
mediator would reset it to empty. ERROR is the one case that genuinely retries.

## Unload alone silently reverses itself

Master caches node's ACTIVE-model list about 10 seconds. Unload a model master still believes
is active and its next poll asks node about it, node lazily re-creates it on access, and it is
ACTIVE again roughly a second later. Both calls return success, so the response never reveals
it was undone.

To catalogue:

1. `deactivate` — master drops it from the polled set on its next refresh.
2. Wait 15s or more.
3. `unload` — now nothing is touching it, so CATALOGED sticks.
4. Re-read after another 30s, not immediately. Back to ACTIVE means something is still reading
   it; find that caller before retrying.

A model with no registered transitions is not polled, so a bare unload happens to work for it.
That is the absence of a poller, not a different rule.

## A CATALOGED model reports zeros that do not mean empty

Status for an unloaded model comes from the catalog, which has no in-memory numbers: it returns
`currentVersion: 0` and `elementCount: 0` whatever is on disk. A model showing version 0 with no
transitions may hold a large event history.

Load it and re-read before judging. Never call a CATALOGED model empty, disposable, or
corrupted from its unloaded reading. For the same reason, a tool's first call against a
CATALOGED model can return a confident wrong answer — check `state` first.

`autoLoad` (`PUT /admin/catalog/{id}/autoload`) only controls the startup scan. It does not
prevent a runtime reload and is never why a model resurrected while the process was running.

## Activating starts things

Loading hands master everything marked running or starting, and those lanes fire on the next
poll. Before activating a model you have not inspected: load it, immediately list its
transitions, and stop the LLM and agent lanes you do not want spending tokens. In the other
order, the first fires have already happened.
