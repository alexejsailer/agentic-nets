# Safe Product Team: a worked persona-team example

Safe Product Team is a product-delivery example. A user describes a product outcome
to one Product Manager persona; narrow specialists move a correlated story through places;
review and approval stay explicit; the Protocol view narrates progress. It demonstrates persona,
context, approval, and observability without defining other domains. The team is an Agentic-Net,
not a group chat: work survives disconnects, every mutation is event-sourced, and any lane can be
stopped or inspected independently.

Invoke the MCP prompt `start-safe-product-team`. With a healthy server provider it installs the
versioned reasoning-only Agent Hub team. For CLI-backed or connected-client operation it deploys
the deterministic `dev-team` backbone and composes bounded personas around it. Both paths verify
the result and record the deployment in `p-protocol`. Use `design-persona-team` instead when the
domain is not product delivery.

## Core team and authority

- **Product Manager** — sole user-facing inbox; shapes intent into a story and acceptance criteria.
- **Architect** — adds the smallest viable design, affected components, constraints, and risks.
- **Developer** — proposes the implementation; in the CLI/connected playbook an approved execution
  adapter may edit only declared repositories/worktrees and produce change + test evidence.
- **Reviewer / QA** — independently checks acceptance criteria and returns
  `approved|needs-work|blocked`; never silently fixes its own finding.
- **Release Guardian** — owns the final approval verdict. Commit, push, deploy, publish, and other
  external side effects require repository policy plus an approval token and are performed by a
  separately reviewed adapter, never by the reasoning-only Agent Hub package.
- **Chronicle** — turns status/evidence into readable reports and Protocol entries. It observes and
  summarizes; it does not change product state.

Add a Domain Expert when the product has durable business or technical knowledge. Add Operations or
Security only when the product needs those gates. More personas are not automatically safer: begin
with the smallest separation of duties that produces independent evidence.

## One story, one identity, visible hand-offs

Every story carries one `_correlationId` (normally also `storyId`) from intake to done. Each hand-off
is a token in a named place, never prose hidden in a conversation. A useful canonical shape is:

```json
{
  "storyId": "STORY-001",
  "_correlationId": "STORY-001",
  "title": "Add readiness endpoint",
  "acceptanceCriteria": ["returns 200", "covered by a test"],
  "repositoryId": "product-api",
  "status": "architecture|development|review|approval|done|blocked",
  "evidence": [],
  "history": []
}
```

Use deterministic `map`/`pass` lanes for copying identifiers, routing verdicts, enforcing WIP, and
moving approved work. Use `agent` lanes only for judgment. Capacity on ready/in-progress/review
places is real backpressure: a fast producer cannot bury the reviewer.

## Repository context is a contract, not a prompt guess

In the token-free `dev-team` backbone, keep a model-scoped registry such as
`p-team-repositories`. In the Agent Hub package, put the same objects in
`p-spt-product-context.data.repositories`. Each repository should declare:

```json
{
  "repositoryId": "product-api",
  "repoUrl": "https://example.invalid/product-api.git",
  "workingDir": "/workspace/product-api",
  "defaultBranch": "main",
  "writeScope": ["src", "tests", "docs"],
  "buildCommand": "./mvnw package",
  "testCommand": "./mvnw test",
  "pushPolicy": "approval-required",
  "deployPolicy": "approval-required"
}
```

Omit unknown fields and keep execution stopped until they are supplied. Never invent a path or
command. Never store credentials in the token; store transition credentials in Vault and put only
credential key names or policy in portable configuration. For several repositories, keep separate
tokens and make every story name `repositoryId` rather than concatenating paths in persona prompts.

Package stable repository/domain structure as `kind=context`: stores can hold repositories,
architecture, glossary, conventions, decisions, incidents, and lessons. Attach it to the team with
typed `link` transitions. Links are structure and never fire.

## Three observability layers

The product USP is not merely that a team runs; it is that its operation can be reconstructed and
improved.

1. **Event trail** — complete low-level truth. Every token mutation, binding, fire, emission, and
   lifecycle change is event-sourced. Query with `event_trail`, normally filtered by transition or
   `_correlationId`.
2. **Status board** — machine-readable current/aggregate state: story, persona, stage, outcome,
   duration, evidence reference, and timestamp. Use it for metrics and stuck-work detection.
3. **Protocol** — readable operational narrative in `p-protocol`, rendered by Studio. Each persona
   records meaningful milestones, decisions, approvals, warnings, and failures through a net emit
   or `protocol_write`; `protocol_tail` reads it from MCP.

Protocol is not a replacement for history. It is the curated explanation over the immutable event
record. A forum, issue tracker, chat, or email can still be attached as an optional frontend, but
the team must report into its own Protocol first so its operation remains self-contained.

## Reasoning backend

Call `readiness` and `llm_health` before creating personas:

- healthy server provider: ordinary agent lanes run unattended;
- reachable Claude Code/Codex on Desktop: explicit CLI-backed persona lanes run unattended;
- connected-client: work waits safely and runs while the MCP client is present;
- no reasoning backend: deploy the deterministic backbone and configuration stopped.

State the choice and offline behavior. A command lane is appropriate for a fixed build/test/git
operation; a CLI-backed `agent` lane is the complete bounded persona loop. Do not disguise a
headless model call as an ordinary deterministic command in user-facing reports.

## Templates, packages, and MCP playbooks

These layers solve different problems:

- **MCP prompt** (`start-safe-product-team`) guides the connected model through a safe,
  environment-aware deployment; MCP need not stay connected once master-owned lanes run.
- **Built-in template** (`deploy_template dev-team`) supplies a portable deterministic backbone.
- **Agent Hub `kind=agent`** ships this team as `safe-product-team`, singleton per model so
  `p-protocol` remains canonical: manifest, typed product/repository and approval schemas, entry
  inbox/outbox, start plan. It installs stopped and reasoning-only: configure, verify, then arm;
  execution requires a separately reviewed adapter.
- **`kind=context`** packages domain context and typed links; **`kind=toolnet`** packages reusable
  execution. Packaging details, token policy, and the design-time-PNML publishing caveat:
  docs/nethub.

## Learning without hidden self-modification

After each story, link outcome and feedback to the story, context version, commands, tests, and
persona version that produced it. Let a curator propose a lesson; let a reviewer approve it before
it enters shared context. When the same successful procedure repeats, use `crystallize_session` or
`scaffold_tool_net` to propose deterministic replay. Compare it against historical evidence,
smoke-test it, record the promotion in Protocol, and retain the old path for rollback.

Useful operating questions are: Which persona creates rework? Where does work wait longest? Which
context version improved approval rate? Which agent step is now stable enough to crystallize? The
event trail, status board, Protocol, and `usage_report` answer different parts of that story.
