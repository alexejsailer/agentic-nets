# Service team

A team of four personas for one service of a product, installed once per service into the product's
model. The product office (`capabilities/product-office`) sits above the teams: it allocates iterations,
collects everything that waits for the person and keeps the product-level spec catalog.

| Persona | Owns | Lanes |
|---|---|---|
| Product owner | requirements; asks the person what the service needs next | `iterate-prep`, `po-cmd`, `propose`, `prompt-prep`, `answer-prep`, `revise-prep`, `requirement` |
| Architect | decisions and the spec catalog that mirrors the code; the context pack for the coder; the policy gate | `design-prep`, `arch-cmd`, `design`, `spec-gate-prep`, `pack-prep` |
| QA | acceptance criteria with runnable checks; verification on the real suites with evidence; the weekly readiness audit | `acceptance-prep`, `qa-cmd`, `acceptance`, `audit-cron` |
| Developer | implementation through a coding agent on a branch; the review; the merge on the person's decision | `approve-prep`, `dev-cmd`, `review`, `merge-ask-prep`, `merge-prep`, `changes-prep` |
| Brain | after a merge: facts, plan, decision proposals, questions, ideas; reports the release to the office | `brain-observe-cmd`, `curate`, `curate-cmd`, `apply-prep`, `answer-knowledge-prep`, `brain-apply-cmd` |
| Setup | health, provision (MCP token, repository clone, registration with the office), pause, resume | `infra-tick`, `setup-cmd` |

## The rules the nets enforce

- **Every change has a spec before it is implemented.** The developer's lane refuses a run without an
  approved spec and a context pack; the context pack is assembled only after QA wrote the acceptance
  criteria for that spec.
- **Nets create context; only the coding agent behind a command transition writes code.** The one-shot
  agent lanes (propose, requirement, design, acceptance, review) answer contracts; the coder gets one
  context pack (requirement, spec, acceptance, decisions, constraints) and nothing else.
- **Branches only; the person merges.** The coder commits on `<service>/<specId>` in the team's own
  clone (`<office home>/<service>/<repo>`); nothing is pushed. The person's merge decision runs the merge
  command: no fast-forward into the clone's main, the branch fetched into the workspace repository, and
  the workspace main merged only when its tree is clean and on main.
- **Everything waiting for the person is mirrored into the office inbox** with a link into the team app.

## The spec catalog

`net-team-specs` holds the catalog root. The architect's `catalog` command mirrors the code structure of
the service into it: one place per module (`p-<service>-spec-<module>`), a link transition
`contains` from the root to every module, and an index token per module (files, specs). Specs live in
the specs place with their module path; the team app draws the tree; the office lists every spec at the
product level.

## Install

```bash
node tools/pack.mjs build --dir service-team && node tools/pack.mjs package --dir service-team
# publish dist/service-team-<version>.capability.json to the hub, then, per service:
POST /api/hub/install {"source":"local","name":"service-team","version":"<v>","targetModelId":"agenticnets-product","targetSessionId":"node"}
```

`instancePolicy: multiple` makes the hub prefix every id with the session: `p-node-team-*`,
`t-node-team-*`, `net-node-team-*`. The scripts learn their namespace from an argv element: the charter place id (`p-team-charter` in the
sources, rewritten to `p-<service>-team-charter` at install) that every map template and app command action
appends to its argv. A literal in a template's environment would be scrubbed at publish, so argv is the only
channel.

Then, in the team app's Setup tab (or with a command token): **Provision** stores the runtime's MCP
token for the eight command lanes, clones the workspace repository into the team's home and registers
the team with the product office. The charter's `service`, `repo`, `repoDir`, test and build commands are
filled from the install namespace; the goal is the person's.

## Files

- `capability.yaml`, `nets/*.net.json` (compact sources), `assets/*.py` (scripts; `teamlib.py` is inlined
  with `python3 tools/inline-shared.py service-team teamlib` after every edit), `seeds/p-team-charter.json`,
  `app/` (the team app, one instance per service), `verify/smoke.json`.
