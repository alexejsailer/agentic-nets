# Net definitions and the hierarchy of nets

A model's nets form a **hierarchy of abstractions**: a net at one level stands for complexity that
is drawn out at the level below. The runtime stays flat; the hierarchy is designtime data only.

## The hierarchy

- **Refinement is the subnet relation.** An element of a parent net (a transition, or a place) is
  refined by a child net. The child's **ports carry the SAME ids** as the parent element's preset
  and postset places, so parent and child share those places at runtime. Two forms exist: an inline
  page stored inside the parent element (`subnet: {net}`), or a reference to a separate persistent
  net through the element attributes `subnetSession` + `subnetNet`.
- **The abstract element never fires.** It carries no inscription; the work happens in the child's
  ordinary transitions. A summary at a higher level is produced by a normal transition that reads
  the lower level's output ports.
- **Depth** is the distance from a root net. **Levels** are optional named bands
  (e.g. product, service, implementation) a net can be pinned to; nets with neither parent nor
  level sit in an "unassigned" band.
- A refinement is checked: `ok` (ports match the parent element), `portMismatch`,
  `targetMissing`, or `pending` (the child has nothing drawn yet).
- Shared places remain the horizontal coupling between peers; refinement is the vertical relation.
- `explore_model` shows all of it: qualified keys `session::netId`, depth, interface
  (input/output/internal places), shared places with readers and writers.

## Definitions

A definition is a persistent net that exists **before** its places and transitions: name,
description (what the net does, stored on the net itself), interactions with other nets in words,
proposed ports, levels above and below, acceptance criteria, and a revision history. It may already
sit under its parent element. Status: `draft` → `ready` (eligible for a build) → `realized`.
Revising writes revision+1 and returns a ready or realized definition to draft; a realized net
whose definition is newer shows **changes pending**.

Tools: `list_net_definitions`, `get_net_definition` (with `nextActions`), `update_net_definition`
(`create`, `revise`, `ready`, `request_build`).

## Building one

The connected client's own model does the reasoning; no server-side LLM is needed. Use the
`realize-net-definition` prompt. The protocol:

1. **Request** (person or client): `update_net_definition {action:"request_build"}`. One open
   build per definition. `policy.activate:true` starts the result on completion; default stopped.
2. **Claim**: `claim_net_definition {action:"claim", owner}` returns `leaseGeneration`. Every
   later call passes `owner` + `leaseGeneration`; master rejects stale writers. Renew during long
   work. Leases expire; another client may then claim and resume from the last checkpoint.
3. **Ask** what materially changes behaviour: `application_action` on `interview` action `ask`
   with a NEW `promptId` (never reused), `question`, `options`, `multiSelect`, `allowFreeText`, and
   `subjectKind:"net-definition"`, `subjectKey:"session::net"`, `subjectRevision`, `buildId`.
   Then `record_net_build {action:"checkpoint", state:"awaiting-answers"}`: that releases the
   lease. The person answers in the Explorer or in your chat; both land in the same tokens. A
   question can be answered once; a second answer is refused.
4. **Plan**: checkpoint `state:"planning"` with `plan {revision, summary, assumptions,
   reusedPlaces, topology, acceptance}`. The server hashes the reused places' readers and writers.
5. **Apply**: `record_net_build {action:"apply", places, transitions, arcs?, remove?}`. One atomic
   write into the definition net: designtime elements, missing runtime places (tokens are never
   touched), inscriptions (validated; errors reject the whole write). Diff-based, so a retry after a
   lost response changes nothing. Nothing is started. A changed boundary answers `boundary-changed`:
   re-plan.
6. **Verify** by role: an executable net gets `verify_inscription`, `dry_run_transition`,
   `net_overview`; an explanatory or context net is checked for references and navigation only.
   Existing work tokens are not test inputs.
7. **Complete** with `verification {passed, evidence}` (the definition becomes realized at that
   revision), or **fail** with the error (earlier realizations stay intact).

## Conflicts and recovery

| Code | Meaning | Do |
|---|---|---|
| `lease-lost` / `lease-expired` | another client holds the build now | stop; reread |
| `superseded` | the definition got a newer revision | stop; a new build is needed |
| `cancel-requested` | someone cancelled | settle, then release with `cancelled` |
| `boundary-changed` | a reused place changed underneath | re-plan, then apply |
| `validation-failed` | an inscription is wrong | fix the findings, apply again |
| `transition-running` | a removal hit a running lane | stop it first |
| `build-open` | a build is already open | claim that one |

After an uncertain failure, reread `get_net_definition` and the build before retrying. Never
create a second net for the same definition, and never delete a reused shared place.
