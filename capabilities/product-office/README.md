# Product office

The product office manages a product that is developed by service teams inside one model. It is the
top of the hierarchy: one product manager persona, the product charter (goal, principles, constraints,
services), the roadmap across teams, the registry of teams, the inbox of everything that waits for the
person, the product-level spec catalog, a daily digest and a brain.

Teams are `service-team` packs installed once per service (`targetSessionId: <service>`); each team
registers itself here when provisioned and pushes its status rows, its questions, its approvals and its
merge decisions into the office places. The person works in two apps: the office app (route `product`)
for the product and the allocation across teams, and one team app per service (route `#/applications/
<service>?model=<model>`) for the four personas of that service.

| Net | Lanes | What it does |
|---|---|---|
| `office-setup` | `t-office-infra-tick` (hourly), `t-office-setup-cmd` | health, provision (MCP token), register-team, pause, resume |
| `office-plan` | `t-office-iterate-prep`, `t-office-plan-cmd`, `t-office-plan` (one-shot), `t-office-answer-prep`, `t-office-revise-prep` | an iteration becomes a planning brief; the product manager proposes the next roadmap step (allocate an iteration to a team with a direction, or install a team), asks for the product goal, or interviews; the person's answer allocates an iteration to the team (an iterate token in the team's place) and records the roadmap item |
| `office-digest` | `t-office-digest-cron` (daily), `t-office-digest-cmd` | the digest across teams from their status rows and the open inbox |
| `office-brain` | observe, curate, apply | after a team's release: facts, plan across teams, decision proposals, questions, ideas |

## Rules

- The product manager never invents a service: it proposes only for services listed in the charter and
  teams registered in `p-product-teams`.
- The office allocates one iteration per team at a time; the team's product owner turns the direction into
  a requirement, and everything after that (spec, acceptance, context pack, code, verification, review,
  merge) happens in the team's nets with the person's approvals.
- Every change in every team has a spec; the office keeps the product-level list of all specs
  (`p-product-specs`) and the teams keep the catalogs that mirror their code.

## Install

```bash
node tools/pack.mjs build --dir product-office && node tools/pack.mjs package --dir product-office
# publish dist/product-office-<version>.capability.json, then:
POST /api/hub/install {"source":"local","name":"product-office","version":"<v>","targetModelId":"agenticnets-product","targetSessionId":"product"}
```

Then in the office app: set the product (goal, principles, services), **Provision** (MCP token for the
office lanes), and **Ask for the next step**. Install a `service-team` pack per service; each team's
provision registers it here.

## Files

`capability.yaml`, `nets/*.net.json`, `assets/*.py` (`officelib.py` inlined with
`python3 tools/inline-shared.py product-office officelib`), `seeds/` (charter, coders), `app/`.
