# Steward: a self-improving net that stewards the model it lives in

The Steward is a capability pack whose job is the model it is installed in. It measures the
model's nets and lanes through the runtime's own MCP, proposes the next increment to a person,
writes a bounded change spec, lets a policy gate and the person decide, applies the approved
change through a headless coder inside a clone of the pack repository, verifies and installs
the new pack version, rolls back on failure, and learns from every release. The person always
routes: nothing is applied without an answer, an approval or an autonomy level that allows it.

Every change the Steward makes is a change to this pack (nets, scripts, seeds, the application).
The pack is code in a repository; the previous version is the rollback. Whatever it becomes
(a model steward, a reporter, a developer persona) is a chain of small, verified pack versions.

## The four nets

| Net | Lanes | What it does |
|---|---|---|
| `steward-setup` | infra tick (hourly), setup command | Measures the executor host (agents, node, git, MCP readiness, disk), stores the MCP token in the vault for the Steward's lanes, clones or pulls the pack repository, pauses and resumes the Steward. |
| `steward-observe` | observe cron (daily), observe command | `net_stats`, `list_transitions`, `scheduler_status`, `usage_report` and place counts become a health token, one lane token per lane, a map of sessions and nets and a daily budget entry. Starts an iteration when nothing waits for the person. |
| `steward-loop` | 13 lanes | Iteration trigger to brief, propose (one-shot agent: a choice, an interview or a request for the goal), the person's answer to a spec brief, spec (one-shot agent, closed grammar), policy gate (deterministic), approval to coder, coder (headless, in the clone), verify (protected set, manifest invariants, publish, install, lint, smoke, rollback), rollback, release (merge, tag, brain). |
| `steward-brain` | 6 lanes | After every release: signals, a curation (one-shot or headless), facts with source and confidence, the plan, decision proposals, questions for the person; applying a curation starts the next iteration. |

## The closed grammar

A spec is exactly one of: `tune` (an inscription, a prompt, a schedule, a capacity), `view`
(a designtime drawing), `crystallise` (an agent lane becomes a map or command lane),
`add-lane`, `remove-lane`, `add-net`, `add-script`, `app` (the application). The gate refuses
anything else, anything that touches the protected set, and anything outside the charter's scope.

## The protected set

The Steward never changes what governs it: the charter, the coders, prompts, responses,
decisions, refused and budget places; every lane of the loop, the observe and the setup nets;
the charter seed; and in the application the stores for charter, coders, prompts, responses,
specs, decisions, runs, health and journal plus the actions `set-charter`, `respond`,
`approve-spec`, `reject-spec`, `rollback`, `pause` and `resume`. Verification compares the
compiled inscriptions of the protected lanes against the base branch and fails the run when
one changed.

## Autonomy levels (charter `autonomyLevel`)

| Level | The Steward may |
|---|---|
| 1 | observe only |
| 2 | propose only; nothing is applied |
| 3 | apply with the person's approval (default) |
| 4 | apply `tune` and `view` alone; everything else with approval |
| 5 | also `crystallise` alone |

The daily budget (`dailyBudgetUsd`) is measured from the model's usage report plus the coder's
reported cost; once exhausted, the gate asks before every change.

## Install

```bash
cd capabilities
python3 tools/inline-shared.py steward stewardlib
node tools/pack.mjs build --dir steward
node tools/pack.mjs package --dir steward       # dist/steward-<version>.capability.json
# publish to the runtime's hub, then install into a model (creates the model's places, lanes, scripts, seeds, app)
curl -X PUT http://127.0.0.1:8083/api/hub/capabilities/steward/versions/<version> \
  -H "Authorization: Bearer <admin jwt>" -H "Content-Type: application/json" \
  --data-binary @steward/dist/steward-<version>.capability.json
curl -X POST http://127.0.0.1:8083/api/hub/install -H "Authorization: Bearer <admin jwt>" \
  -H "Content-Type: application/json" -d '{"source":"local","name":"steward","version":"<version>","targetModelId":"steward"}'
```

Then open the Steward application in Studio:

1. **Setup**: save the charter (goal, principles, scope, autonomy, budget), the repository
   (where this pack lives; the Steward clones it under `home`) and the coder (Claude Code with
   Opus 5 or Fable 5.1, or Codex). Check infrastructure, then **Provision** (stores the MCP
   token for the lanes, clones the repository).
2. **Next step**: observe now, or ask the Steward for the next step. It asks for the goal first.
   Every later step is a choice, an interview or a spec to approve.
3. **Work**: runs with build, verification checks and a rollback button per released version.
4. **Health**, **Brain**, **Journal**: what was measured, what it knows and plans, what every lane did.

Lanes the installer leaves in `STARTING` are re-armed by the verify step (stop and start).

## Facts measured on 2026-09-09 (Desktop Lite 2.59.0)

- Install: 4 nets, 23 lanes, 8 scripts, 27 stores, one application; a manual observation
  measured 23 lanes and started the first iteration; the propose lane asked for the goal 9 s later.
- Provision stores the MCP token for 10 command lanes and clones the repository in one command.
- A pause stops every lane except the setup lane, so resume can run through the same net.

## Files

```
capability.yaml           pack manifest (nets, scripts, seeds, credential, app, verify)
nets/*.net.json           compact sources; *.pnml.json + *.inscriptions.json are built
assets/stewardlib.py      shared library, inlined into every script between the markers
assets/steward-*.py       infra, observe, context, gate, apply, verify, release, brain
seeds/                    the charter (protected) and the coder definitions
app/                      agenticos.app.json + ui/main.mjs (one vanilla web component)
views/                    designtime view nets (steward-full and one per stage)
verify/smoke.json         the smoke cases
```
