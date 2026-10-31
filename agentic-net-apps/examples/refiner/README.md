# Focus (package `refiner`)

Focus is the way of working on one feature of a model across its levels. In Studio it contributes the Focus view, the "Focus here" actions, the hand-over to the AI and the AI actions on a card; without it the Explorer shows the structure only. This package is its runtime, the AI side of the focus loop as an application in the model: a `request` hands the focus work over (kind refinement, structure or ground; a focus scope and a subject when wanted), the agent lane `t-refiner-pass` runs the pass through the Agentic-Nets MCP server and reports into `runs`. The Explorer's Focus view has the "Hand over to the AI" button and the MCP tool `hand_over` writes the same request; install it from the hub (Studio's Install button, MCP `hub_install`, or the `modeling` model profile, which also installs Interview and Curation); the master attaches its MCP server when it knows one. The lane ships stopped and is fired once per request.

Since 1.4.0 its prompts and coder profiles are tokens in the model: `prompts` (promptId `rules`, the coder kinds `refinement`, `structure`, `ground`, `look`, `explain`, `check`, `draft`, `diff`, and `refinement-pass`, the prompt of `t-refiner-pass`) and `coders` (seeded with Claude Code read-only). Both are seeds: an upgrade replaces a token you never edited and keeps an edited one. The coder runs in this package's own lanes (`t-refiner-coder-build`, `-run`, `-shape`) through the script of the `headless-agent` capability: the hand-over writes one task per request (action `delegate`, the composed prompt only), and the lanes take the folder, the profile and the MCP server from the newest `config` record. Focus refuses a profile whose mode is not read-only.

Packed with `npm run pack:refiner`; the master seeds the packed copy (`application-templates/refiner.json`).

## Guided rounds (1.9.0)

The Focus page starts from a plain-language goal. The headless agent discovers relevant nets and
layers; the person does not select nets, sessions or tags. The selected model areas are visible
for inspection. Refine seals that selection with
the answers, and the server rejects targets outside it. One headless request prepares ten
short, independent multiple-choice cards, with exactly one recommended option and a brief reason.
The UI shows one card at a time; choosing an answer saves it and immediately advances without a
new agent run. Supporting analysis is collapsed under "Why this question?". Follow-up rounds adapt
to the saved decisions. Free text and investigation remain available; investigating
the current decision preserves the remaining cards. Questions and responses
also appear in Interview. Answers are saved before any model edit. Pressing Refine seals the
answered questions and directly applies structured definitions, topology and organization changes.
Applied operations retain receipts; unfinished work can be retried, and the next round waits for
an explicit start. New rounds require the full ten-card batch before presenting the first card;
single-question replies cannot silently resume the old per-answer generation loop. Older saved
rounds retain their original behavior and offer a new ten-card round on the same topic.

After all ten answers, **Refine layers** updates model knowledge/nets under a read-only source
profile. **Implement** explicitly selects the matching write profile in the configured source folder,
runs checks and returns a work report. headless-agent 1.2.0 records file fingerprints before/after
the run, including after a failed agent; the report distinguishes those file changes from the agent's
reported checks and remaining work. Source-less rounds cannot implement. Implementation uses no MCP
server and never commits, pushes or deploys. A later layer refinement can use the same sealed answers.

Roles `rounds`, `round-jobs`, `round-commands`, `round-raw`, `round-results` extend the existing
review stores. `t-refiner-round-build`, `-run`, `-shape` execute the installed headless-agent runner
with a frozen profile and result key `FOCUS_ROUND_RESULT`. Claude searches the live model through
MCP, registers its chosen areas with `focus_round_scope`, then makes real model edits with
`focus_round_apply` after the person presses Refine. The server validates the sealed scope and
returns persistent operation receipts. Source files stay read-only. Codex retains the proposal
path without MCP. headless-agent 1.1.0 receives the context over stdin
(`run-context`) and stages a searchable model index plus per-net files, alongside the round's
answers. This removes the environment-variable size limit and forty-net gate. Sources are optional
and stay in their configured root; model evidence is staged outside it and removed after the run.
Prompts (`guided-round`) and both profiles remain upgrade-safe seed tokens.

The master coordinates rounds under `/api/explorer/{model}/rounds`, with `answer`, `refine`, and
`retry` sub-actions. MCP exposes `focus_round` and `focus_rounds` when review tools are enabled.
Model changes reuse Explorer's definition, organization, relation and fenced build services.
Explanatory topology stays design-only, stopped and unverified for execution. No runtime place is
deleted. New root abstractions must connect back to the topic through relations or refinements.
Pending work resumes when a saved round is read after restart. This workflow does not advance the
legacy model-wide digest watermark; its membership is the round's exact sealed answers.

MCP `focus_round` start needs only `roundId` and `topic`. An explicit scope remains optional for
clients that already have one. Existing rounds retain their saved boundaries.

The existing application MCP grant includes `t-refiner-round-run` and injects
`AGENTICNETS_MCP_URL` / `AGENTICNETS_MCP_TOKEN` as credentials. The runner writes a private MCP
configuration and starts `claude -p --mcp-config <temporary file> --strict-mcp-config` with an exact
tool allowlist. Question jobs can search/read/register scope; only refinement jobs receive the
MCP edit tool, whose server also requires the current request ID and sealed human answers. Neither
the token nor model context is placed in the prompt. This command net is internal to Focus; the
person supplies only a goal. A job starts one headless process, records its result, then exits.

Checks: `node --test examples/refiner/round-package.test.mjs`, `npm run pack:refiner`, and
`node tools/test-application-package.mjs --config examples/refiner/agenticos.app.json --file dist/packages/refiner-1.9.0.application.json`.
