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

The MCP token comes from the lane's credential `AGENTICNETS_MCP_TOKEN` (`HA_MCP_TOKEN_ENV` names
another). The script prints one JSON object: `ok`, `exitCode`, `profileId`, `mode`, `model`,
`report` (the parsed `CODER_RESULT:` line; `HA_RESULT_KEY` names another key), `text`, `stderr`,
`durationSec`, `costUsd`, `turns`, and `error` when it failed. The argument `check` instead of `run` reports whether the
profile's binary is on the executor's PATH.

## Profiles

`{profileId, title, family: claude-code | codex, mode: read-only | write, command: [argv with {model},
{allowedTools}, {disallowedTools}, {maxTurns}], promptVia: stdin | argv, resultFormat: claude-json |
text, defaultModel, allowedTools, disallowedTools, maxTurns, timeoutMin, mcp}`. `${...}` placeholders
are accepted too, so profiles written for the Steward's `p-steward-coders` read the same way.

## Prove it

```bash
python3 verify/test_headless_agent.py      # the rules, with fake claude/codex binaries
node ../tools/pack.mjs package --dir .     # the NetHub artifact in dist/
```
