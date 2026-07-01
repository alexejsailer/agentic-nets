---
description: Run Forge — the AgenticOS tool-builder — to design, scaffold, and smoke-test a tool-net from a natural-language intent.
argument-hint: "<modelId> \"<intent>\""
allowed-tools: Bash(bash:*), Read
---
Start a Forge run and poll it to completion:

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/forge-run.sh" $ARGUMENTS
```

Report the final status (`done` / `failed`) and, if it finished, what tool-net Forge built and whether its
smoke test passed. Forge needs a live LLM provider configured on the master; if the run stalls at `queued`,
note that as the likely cause. See `references/personas.md` for how Forge fits the persona system.
