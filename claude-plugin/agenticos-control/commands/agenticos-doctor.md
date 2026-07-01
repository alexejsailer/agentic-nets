---
description: Preflight an AgenticOS connection (resolved mode/auth/targets + reachability, no secrets); optionally diagnose one transition.
argument-hint: "[modelId] [transitionId]"
allowed-tools: Bash(bash:*), Read
---
First show the connection preflight (safe, prints no secrets):

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/anos.sh" preflight
```

If a `modelId` and `transitionId` were provided in `$ARGUMENTS`, then also diagnose that transition:

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/diagnose.sh" $ARGUMENTS
```

Interpret the output: state whether the stack is reachable and in which mode/auth, and for a transition call
out its status, any `error`, whether it is `ready`/`firing`, and likely causes (capacity gate, missing input
tokens, stopped upstream). If unreachable, guide the user to set the env vars in `references/auth.md`.
