# Net applications: Protocol, Interview, Goals, Persona Kanban, Approval Room

A net application is a first-class `kind:"application"` NetHub package. It carries an ordinary
session runtime, an `applicationManifest`, and optionally a verified browser UI module. The
manifest maps semantic STORE ROLES to places and declares ACTIONS with input schemas. There is no
application database or application transition kind — the page is a projection over the same
event-sourced tokens your nets read and write.

Consequence for you: never hardcode a `p-*` id for these. Ask the manifest.

## Discover, install, use

1. `application_list` — what is already installed in this model, with roles, actions, surface.
2. `application_describe {name}` — role→placeId map and the action input schemas.
3. `application_action {name, action, input}` — master resolves the role to the real place,
   validates required input, and appends an event-sourced token.

Not installed yet? `hub_search {kind:"application"}` lists the packages and
`hub_install {name, version:"latest"}` installs one (default session `application-<name>`). It
stays an ordinary session: `net_overview` shows the places, ArcQL queries the tokens.

| Application | Stores | Use it for |
|---|---|---|
| protocol | entries | The readable narrative of long-running work |
| interview | requests, prompts, responses, decisions | Anything you need a human to decide |
| goals | goals, progress, outcomes | User-owned outcomes and evidence of progress |
| persona-kanban | cards, activity | Shared, claimable work for humans and Persona agents |
| approval-room | requests, decisions, evidence | Independent approval, rejection, change requests, and durable evidence |

Approval Room's identity-relative decision and safe-retry protocol has its own
`agenticnets://docs/approvals` topic.

## The Persona Kanban contract

`persona-kanban` is the worked open-source application example. Its `cards` role is canonical
current task state; `activity` is the append-only audit trail. The installed descriptor includes
an `agentProtocol` object with the task/assignee fields, ready and terminal statuses, polling
guidance, lifecycle actions, and separation-of-duty rules.

A worker Persona should:

1. discover the application and resolve `cards` instead of guessing `p-kanban-cards`;
2. query `kind=="kanban-task" && status=="ready"`, restricted to unassigned work or its exact id;
3. re-read and call `claimTask` with that stable Persona id;
4. use `addComment` for meaningful progress, blockers, and evidence;
5. call `requestReview` with the result; an independent reviewer calls `approveTask`;
6. re-read the card after every action and verify the new state.

`createTask` requires a stable `taskId`, title, and `createdBy`. Guarded actions reject duplicate
task ids and invalid lifecycle state before their activity event is appended. A blocked Persona
should record the blocker and either retain explicit ownership or call `releaseTask`; work must not
silently disappear inside an agent conversation.

## The Interview contract

Interview is TWO-WAY. Agents ask; the human answers, attaches a note, reshapes a badly framed
question, or raises one of their own.

**ask** → role `prompts`. `promptId` and `question` required. Optional: `header` (short chip
label), `context`, `source`, `options`, `multiSelect` (false = single choice, the default),
`allowFreeText` (default true), `supersedes`, `requestId`, `batchId`. Options are plain strings or
`{value, label, description, recommended}` objects.

**respond** → role `responses`. `promptId` required. `intent` is `answer` (default), `revise`, or
`reject`; plus `selected`, `text`, `notes`, `revisedQuestion`.

**raise** → role `requests`. The HUMAN's own question: `requestId`, `question`, `context`,
`priority`. Nobody is watching this store unless you build a lane that does.

**decide** → role `decisions`. An explicit decision derived from an interview.

Every discriminator is a scalar, so the agent side is plain ArcQL — no glue code.

## Asking a human without holding a lease

A transition fire must not wait for a person. Split it in two:

```jsonc
// 1. the asking fire: append the prompt, append your own checkpoint, then finish
//    checkpoint token: {promptId:"q-17", task:"…", resumeWith:"…"}

// 2. the resuming lane: join the answer with the checkpoint
"presets": {
  "answer":  {"placeId":"p-interview-responses",
              "arcql":"FROM $ WHERE $.intent!=\"revise\"", "consume": true},
  "waiting": {"placeId":"p-<persona>-waiting", "arcql":"FROM $", "consume": true}
}

// 3. the revision lane: the human reshaped the question — ask again
"presets": {"revision": {"placeId":"p-interview-responses",
             "arcql":"FROM $ WHERE $.intent==\"revise\"", "consume": true}}
//    → ask() again with supersedes:"<old promptId>" and the new wording

// 4. the inbound lane: questions the human raised on their own
"presets": {"req": {"placeId":"p-interview-requests",
             "arcql":"FROM $ WHERE $.kind==\"interview-request\"", "consume": true}}
//    → answer with a prompt carrying the same requestId
```

Carry ONE `promptId` (or `requestId`) across prompt, checkpoint, response, and result. That single
correlation key is what turns four independent token appends into a conversation.

Schedule the asking lane (`set_schedule`) and the persona interviews the owner unattended — a
daily standup that waits for a human without blocking on one.

## Gotchas

- **Arrays are stringified.** Maps and lists become JSON strings in leaf properties on the action
  path, so `options` and `selected` come back as strings. Studio parses both; ArcQL cannot treat
  them as arrays. Keep anything you need to query as a scalar.
- **A prompt counts as answered** purely because some response carries its `promptId`. Reusing a
  `promptId` marks the new prompt answered on arrival — always mint a fresh one. On masters ≥ 2.45
  `respond` with intent answer/reject ALSO settles the prompt token's `status` (open →
  answered/rejected) via a declared action effect, so settled-ness survives automation consuming
  the response token. Older masters: `status` never leaves "open" — track via decision tokens.
- **Direct writes bypass action defaults.** A net lane emitting straight into an application place
  gets no `kind` stamp, no schema check, and Studio may render it degraded or drop it silently.
  `application_describe` returns each store's `writeContract` (expectedKind + correlation fields) —
  carry those on every direct write.
- **`createdAt` orders the view.** The action sets it; a net emitting straight to the place must
  set `createdAt` or `ts` itself or the prompt sorts last.
- **An answer is information, not authorization.** "Yes, sounds good" is not approval for a
  destructive or outbound side effect; keep that gate explicit and separate.
- **Singleton per model.** One Interview net per model; install it into whichever session you like.
- **Discovery errors are not empty registries.** Report/retry; never infer that no apps exist.

## Building your own

Author the process as a normal session net with stable role names and small correlatable tokens,
then package it with `agentic-net-apps`. Every MCP client can discover the stores and drive the
actions. A manifest-only package uses Studio's generic store/action view; a compiled Web Component
is dynamically mounted without rebuilding the closed GUI.
