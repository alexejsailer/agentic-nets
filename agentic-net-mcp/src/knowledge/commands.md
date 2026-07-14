# Command lanes: token schema + executors

Command transitions are the only kind that runs on an EXECUTOR (a separate polling service);
map/http/llm/agent run on the master. That split is why a model with zero executors can still run
http/llm nets — and why a command lane can look healthy while nothing executes it.

## The CommandToken schema (no shorthand — every field required)

```json
{"kind":"command","id":"unique-cmd-id","executor":"bash","command":"exec",
 "args":{"command":"echo hello","workingDir":"/absolute/path","timeoutMs":60000},
 "expect":"text"}
```

- `command` is the MODE (`"exec"` or `"script"`), NOT the shell string — the shell string is
  `args.command`. Mixing these up is the #1 command mistake.
- `args.workingDir` must be ABSOLUTE — the executor runs from its own directory, not your repo.
- Shorthand like `{cmd: "..."}` is rejected.

## The MAP→COMMAND pipeline (dynamic commands)

The command ACTION carries no `${...}` and no command text (allowed fields: type, inputPlace,
executorId, dispatch, await, timeoutMs, groupBy). Dynamic commands are built by an upstream map
whose template produces a full CommandToken; the command transition consumes and dispatches it.
Result arrives via emit `from: "@result"`: `batchResults[0].results[0].output.{exitCode,stdout,stderr}`.

## Executor selection

Resolution order: `action.executorId` → the persisted `assignedAgent` → the default executor
(`agentic-net-executor-default`). `"*"` offers the work to every polling executor — first token
reservation wins. With several executors ONLINE and no user preference, ASK which to target
(list_executors shows them).

## The "queued, no output" stall — check coverage FIRST

A command transition can be RUNNING with a full input queue and never fire: nothing is POLLING its
model. Executors only poll models the master advertises to them, and `allowedModels` (permission)
is not `models` (actually polling). Diagnosis in one call: `net_stats.executorCoverage` or
`list_executors.coverageForModel` — `covered:false` with `allowedButIdle:[...]` is the smoking
gun. Classic trigger: a master restart (self-heals within ~a minute on masters ≥ 2.27; on older
masters any lifecycle call — e.g. stop/start of one transition — re-registers the model).

## Spawning CLI agents (e.g. Claude Code) from a command lane

```
claude -p 'Fix the failing test in /repo/x' --allowedTools 'Read,Grep,Glob,Edit,Bash' --no-session-persistence < /dev/null
```
Rules: ALWAYS redirect stdin (`< /dev/null` — it blocks forever otherwise); least-privilege
`--allowedTools`; generous `timeoutMs` (minutes); the executor host must have the CLI installed.

## Executor output size

Executor stdout larger than ~128KB is offloaded to the blobstore; the result then carries a blob
URN — fetch it with READ_BLOB_TEXT instead of expecting inline stdout.
