---
description: Snapshot an AgenticOS model — transitions and their states/schedules, a session's nets, and a net's places with live token counts.
argument-hint: "<modelId> [sessionId] [netId]"
allowed-tools: Bash(bash:*), Read
---
Inspect the AgenticOS model. Run the bundled inspector and summarize the result for the user (flag any
transition in `error` state or unexpectedly `stopped`, and any place holding a surprising number of tokens):

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/net-inspect.sh" $ARGUMENTS
```

If it reports "unreachable", run `bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/anos.sh" preflight`
and help the user set direct or gateway env vars (see the `agenticos-control` skill's `references/auth.md`).
