# Net definitions and the hierarchy of nets

A model's nets form a **hierarchy of abstractions**: a net at one level stands for complexity drawn
out at the level below. The runtime stays flat; the hierarchy is designtime data only.

## The hierarchy

- **Refinement is the subnet relation.** A parent's transition (or place) is refined by a child
  net whose **ports carry the SAME ids** as the element's preset and postset places, so both share
  those places at runtime. Two forms: an inline page in the element (`subnet: {net}`), or a
  reference to a persistent net via the element attributes `subnetSession` + `subnetNet`.
- **The abstract element never fires.** It has no inscription; the child's ordinary transitions do
  the work. A higher-level summary comes from a normal transition reading the lower output ports.
- **Design-only elements** (`designOnly: "true"`) never run (e.g. the lowest level of a model that documents something); `sync_net` keeps them.
- **Depth** is the distance from a root. **Levels** are optional named bands (product, service,
  implementation) a net can be pinned to; nets with neither sit in "unassigned".
- Refinements are checked: `ok` (ports match the element), `portMismatch`, `targetMissing`, or
  `pending` (child empty).
- Shared places are the horizontal coupling between peers; refinement is the vertical one.
  Explicit relations (`explains`, `depends-on`, `references`) add meaning between any two nets.
  A closed list between nets; a `kind:"link"` transition is the other system: two places, any
  relation word. Neither fires.
- `explore_model` shows it all: keys `session::netId`, depth, shared places with
  readers and writers, interface (input/output/internal places), organization, execution state,
  relations.

## Definitions

A definition is a persistent net that exists **before** its topology: name, description (what it
does, stored on the net), interactions in words, proposed ports, levels above and below,
acceptance, `references` (doc, code, trace, data, record, web or a domain word, with a uri), and a revision history. It may already sit
under its parent element. Status `draft` → `ready` (buildable) → `realized`; `archived` keeps it
but hides it from active work. Revising writes revision+1 and keeps the status, so a realized net
with a newer definition shows **changes pending** and can be rebuilt.

`update_net_definition` actions: `create` (optionally from a `templateId`; explicit args win),
`revise`, `ready`, `request_build`, `organize` (layer, domain, responsible, tags on any net),
`relate` (mode add, remove or replace), `archive`, `unarchive`. Templates: `list_net_definition_templates`,
`net_definition_templates`. Read with `list_net_definitions`, `get_net_definition` (`nextActions`).

## Review

The Curation application records agreement on any subject (`session::net`, `session::net#elementId`,
a level id): `confirm` (revision, optional `sourceHash`), `flag` (stale, unclear, wrong, contradiction,
unmeasured, too-coarse, level-below-changed, level-above-changed; open until `resolve`). Interview
questions take the same `subjectKey`. `review_model` folds both per net and element. `refine_model`
is the worklist top-down and bottom-up (unrefined transitions, failed refinements, open definitions,
nets below nothing, flags, questions, never confirmed), each item with a ready-made question;
`curate_model` asks, answers (and confirms or flags in the same call), confirms, flags, resolves. The
prompt `question-round` is one way to drive them; any MCP client can run the loop by tools alone.

Focus and refinement alternate: `focus_digest` returns what the person answered, confirmed, flagged, deferred or resolved since the last `pass` record (grouped by level and subject, plus the open questions); the `refinement-pass` prompt applies it top-down (revise definitions, carry changes down, resolve settled flags, raise the next questions) and records the pass with `curate_model {action:"pass", consumedUntil}`. A card raised for the person carries `evidence` (what was read or measured), `reasoning` (the argument and the recommendation) and options with a description each; a question without them is not asked. Cards have an audience: open questions and open flags are for the person (`refine_model {for:"person"}`); unrefined, unverified, draft and unconfirmed cards are for the AI (`for:"model"`, prompt `structure-pass`). The person can raise an own question (`curate_model raise`) or reshape one (`reshape`). `ground_model` lists, for every bottom-level net, the chain above it with claims and confirmations; the `ground-model` prompt reads the sources and confirms, corrects or asks per node. Implementation is a separate step, `implement-from-model`, an interview on one confirmed lowest-layer net; it never starts anything by itself.


## Building one

The client's own model reasons; no server-side LLM is needed. Use the `realize-net-definition`
prompt:

1. **Request**: `update_net_definition {action:"request_build"}`. One open build per definition.
   `policy.activate:true` starts the result on completion; default stopped.
2. **Claim**: `claim_net_definition {action:"claim", owner}` returns `leaseGeneration`; pass
   `owner` + `leaseGeneration` on every later call (stale writers are rejected). Renew during long
   work. An expired lease lets another client claim and resume from the last checkpoint.
3. **Ask** what materially changes behaviour: `application_action` on `interview` action `ask`
   with a NEW `promptId` (never reused), `question`, `options`, `multiSelect`, `allowFreeText`, and
   `subjectKind:"net-definition"`, `subjectKey:"session::net"`, `subjectRevision`, `buildId`.
   Then checkpoint `state:"awaiting-answers"` (releases the lease). Answers from the Explorer or
   your chat land in the same tokens; a question is answered once.
4. **Plan**: checkpoint `state:"planning"` with `plan {revision, summary, assumptions,
   reusedPlaces, topology, acceptance}`; the server hashes the reused places' readers and writers.
5. **Apply**: `record_net_build {action:"apply", places, transitions, arcs?, remove?}`, one atomic
   write: designtime elements, missing runtime places (tokens never touched), validated
   inscriptions (errors reject it all). Diff-based, so a retry changes nothing; nothing starts.
   `boundary-changed` means re-plan.
6. **Verify** by role: executable nets get `verify_inscription`, `dry_run_transition`,
   `net_overview`; explanatory nets only references and navigation. Work tokens are not test input.
7. **Complete** with `verification {passed, evidence}` (realized at that revision), or **fail**
   (earlier realizations stay intact).

## Conflicts and recovery

| Code | Meaning | Do |
|---|---|---|
| `lease-lost` / `lease-expired` | another client holds the build | stop; reread |
| `superseded` | the definition has a newer revision | stop; a new build is needed |
| `cancel-requested` | someone cancelled | settle, release with `cancelled` |
| `boundary-changed` | a reused place changed | re-plan, then apply |
| `validation-failed` | an inscription is wrong | fix the findings, apply again |
| `transition-running` | a removal hit a running lane | stop it first |
| `build-open` | a build is already open | claim that one |

After an uncertain failure, reread `get_net_definition` and the build before retrying. Never
create a second net for one definition, never delete a reused shared place.
