---
description: Fire an AgenticOS transition once (STOP -> fireOnce -> START; handles the 409-while-running case), then report.
argument-hint: "<modelId> <transitionId>"
allowed-tools: Bash(bash:*), Read
---
Fire the transition once and report what happened:

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/fire-transition.sh" $ARGUMENTS
```

Then summarize: did the fire succeed, what did it emit, and was the transition restarted. If the fire failed
with a "running state" message, note that the STOP had not taken effect and re-run. For deeper analysis run
`/agenticos-doctor <modelId> <transitionId>`.
