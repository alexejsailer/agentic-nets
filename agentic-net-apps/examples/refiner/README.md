# Focus (package `refiner`)

Focus is the way of working on one feature of a model across its levels. In Studio it contributes the Focus view, the "Focus here" actions, the hand-over to the AI and the AI actions on a card; without it the Explorer shows the structure only. This package is its runtime, the AI side of the focus loop as an application in the model: a `request` hands the focus work over (kind refinement, structure or ground; a focus scope and a subject when wanted), the agent lane `t-refiner-pass` runs the pass through the Agentic-Nets MCP server and reports into `runs`. The Explorer's Focus view has the "Hand over to the AI" button and the MCP tool `hand_over` writes the same request; install it from the hub (Studio's Install button, MCP `hub_install`, or the `modeling` model profile, which also installs Interview and Curation); the master attaches its MCP server when it knows one. The lane ships stopped and is fired once per request.

Since 1.4.0 its prompts and coder profiles are tokens in the model: `prompts` (promptId `rules`, the coder kinds `refinement`, `structure`, `ground`, `look`, `explain`, `check`, `draft`, `diff`, and `refinement-pass`, the prompt of `t-refiner-pass`) and `coders` (seeded with Claude Code read-only). Both are seeds: an upgrade replaces a token you never edited and keeps an edited one. The coder runs in this package's own lanes (`t-refiner-coder-build`, `-run`, `-shape`) through the script of the `headless-agent` capability: the hand-over writes one task per request (action `delegate`, the composed prompt only), and the lanes take the folder, the profile and the MCP server from the newest `config` record. Focus refuses a profile whose mode is not read-only.

Packed with `npm run pack:refiner`; the master seeds the packed copy (`application-templates/refiner.json`).

## Guided rounds (1.6.0)

The Focus page starts an adaptive interview for one topic across its relevant layers. Up to ten
questions, with an early finish, free text, and an investigation option. Questions and responses
also appear in Interview. Answers are saved before any model edit. Pressing Refine seals the
answered questions and directly applies structured definitions, topology and organization changes.
Applied operations retain receipts; unfinished work can be retried, and the next round waits for
an explicit start.

Roles `rounds`, `round-jobs`, `round-commands`, `round-raw`, `round-results` extend the existing
review stores. `t-refiner-round-build`, `-run`, `-shape` execute the installed headless-agent runner
with a frozen read-only profile, no MCP connection, and result key `FOCUS_ROUND_RESULT`. Claude Code
and Codex share the same proposal contract. Without sources, headless-agent 1.0.1 creates a temporary
`model-round.json` workspace. Prompts (`guided-round`) and both profiles remain upgrade-safe seed tokens.

The master coordinates rounds under `/api/explorer/{model}/rounds`, with `answer`, `refine`, and
`retry` sub-actions. MCP exposes `focus_round` and `focus_rounds` when review tools are enabled.
Model changes reuse Explorer's definition, organization, relation and fenced build services.
Explanatory topology stays design-only, stopped and unverified for execution. No runtime place is
deleted. New root abstractions must connect back to the topic through relations or refinements.
Pending work resumes when a saved round is read after restart. This workflow does not advance the
legacy model-wide digest watermark; its membership is the round's exact sealed answers.

1.6.1 hands the round context to the runner as JSON text (`json()`): a stored JSON string binds as an object,
and the executor leaves an object out of a command's environment.

Checks: `node --test examples/refiner/round-package.test.mjs`, `npm run pack:refiner`, and
`node tools/test-application-package.mjs --config examples/refiner/agenticos.app.json --file dist/packages/refiner-1.6.1.application.json`.
