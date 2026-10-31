# headless-agent

One runner for every package that runs a coder: a headless CLI agent (Claude Code or Codex), once,
in a folder, under a profile. The Focus application's coder is its first user; packs with their own
copy of the headless-run code (the Steward, Hermann, the product office and the service team) can
adopt it in their own time.

## What it enforces

The **runner**, not the profile, makes read-only true:

| | read-only | write |
|---|---|---|
| Claude Code | only `Read`, `Grep`, `Glob` (plus the MCP tools the caller allows); `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` always disallowed; bypass flags refused | the profile's tools |
| Codex | always `--sandbox read-only`; no MCP server | the profile's sandbox; no MCP server |

An MCP server reaches the agent only as a private config file (mode 600, deleted after the run),
limited to the tools the caller names; a call without an allowlist is refused. Every `*_MCP_TOKEN`
variable and every `HA_*` input is removed from the agent's environment.

## Use

A package keeps its profiles as tokens (copy one from `p-headless-agent-profiles`) and renders a
command token in its own lane:

```json
{"kind": "command", "id": "<requestId>", "executor": "script", "command": "invoke", "expect": "json",
 "args": {"toolId": "headless-agent", "argv": ["run"], "timeoutMs": 1800000,
          "env": {"HA_PROFILE": "<the profile token's data as JSON>", "HA_ROOT": "~/src/project",
                  "HA_PROMPT": "<the task, ending with: print one line CODER_RESULT: {json}>",
                  "HA_MCP_URL": "http://127.0.0.1:8091/mcp", "HA_MCP_TOOLS": "explore_model,curate_model"}}}
```

In a published package every value inside `env` must be a template (`${...}`): the importer
redacts each literal string there as a possible secret. Keep fixed values (the folder, the profile,
the tool list) in a record the lane reads through a second preset, as Focus does with its config.

The MCP token comes from the lane's credential `AGENTICNETS_MCP_TOKEN` (`HA_MCP_TOKEN_ENV` names
another). For an MCP-enabled profile, a granted lane's `AGENTICNETS_MCP_URL` supplies the server
address when `HA_MCP_URL` is absent. Both granted values are removed from the CLI's environment;
the URL/token go in the private MCP config only. Read-only mode concerns source files; explicitly
allowed MCP tools can edit the model. The script prints one JSON object: `ok`, `exitCode`, `profileId`, `mode`, `model`,
`report` (the parsed `CODER_RESULT:` line; `HA_RESULT_KEY` names another key), `text`, `stderr`,
`durationSec`, `costUsd`, `turns`, and `error` when it failed. The argument `check` instead of `run` reports whether the
profile's binary is on the executor's PATH.

For large model context, use `argv: ["run-context"]` and `args.input: <round JSON object>`.
The runner reads up to 32 MB from stdin and stages a private temporary `model-round.json`, a
`model-index.json` and separate per-net JSON files. The prompt gets only `MODEL_CONTEXT_DIR`,
so the agent searches the index and reads the relevant files itself. With a configured source
root its working directory stays there; model-only rounds work in the temporary folder.
All context files are removed after execution, including failure/timeout. No model payload is
passed in environment variables or CLI arguments. `HA_CONTEXT_JSON` remains supported for older
callers. Focus 1.7.0 uses this handoff with runner 1.1.0 to discover nets from a natural-language
topic without asking the person to choose technical IDs or limiting the model to forty nets.

## Profiles

Focus 1.9.0 uses the runner's implementation context (`job.phase: implement`) only after an explicit
Implement action. Runner 1.2.0 requires a write profile and an existing source root, records source
file SHA-256 values before and after, and returns `workspace {captured,root,changes,preExistingChanges}`
even when the CLI fails after editing. Git projects use tracked and unignored files; other folders
exclude common dependency/build directories. The audit supports up to 20,000 files / 512 MB.
No source contents are stored in the audit. Claude implementation uses a strict empty MCP config;
model refinement uses a separate read-only profile. Code checks in the agent's report remain
agent-reported; the executor's file evidence is independent of that report.

`{profileId, title, family: claude-code | codex, mode: read-only | write, command: [argv with {model},
{allowedTools}, {disallowedTools}, {maxTurns}], promptVia: stdin | argv, resultFormat: claude-json |
text, defaultModel, allowedTools, disallowedTools, maxTurns, timeoutMin, mcp}`. `${...}` placeholders
are accepted too, so profiles written for the Steward's `p-steward-coders` read the same way.

## Prove it

```bash
python3 verify/test_headless_agent.py      # the rules, with fake claude/codex binaries
node ../tools/pack.mjs package --dir .     # the NetHub artifact in dist/
```

## Model-only jobs (1.0.1)

A caller can omit `HA_ROOT` and supply `HA_CONTEXT_JSON`. The runner creates a temporary workspace,
writes that JSON as `model-round.json`, runs the same profile there and removes the workspace on
completion or failure. A source-backed call keeps its configured folder and writes no context file
there. Use `HA_RESULT_KEY` to select an application result marker (Focus uses `FOCUS_ROUND_RESULT`).
The normal read-only and credential isolation rules still apply.
