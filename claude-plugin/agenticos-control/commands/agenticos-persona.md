---
description: Drive an AgenticOS persona (Universal Assistant, Persona, operator, builder, or any personaId) and stream its reply.
argument-hint: "<universal|persona|operator|builder|personaId> <modelId> \"<prompt>\""
allowed-tools: Bash(bash:*), Read
---
Drive the persona and stream its response:

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/drive-persona.sh" $ARGUMENTS
```

Relay the persona's reply and any tool activity it performed. The persona runs inside the net with its own
capability role (see `references/personas.md`); `persona` may build a net, the Universal Assistant may act or
delegate. This needs a live LLM provider on the master; if the stream is empty, say so and suggest checking the
master's LLM configuration.
