---
description: Export an AgenticOS net (structure JSON, or PNML XML with --xml) to a file in your working directory.
argument-hint: "<modelId> <sessionId> <netId> [outPath] [--xml]"
allowed-tools: Bash(bash:*), Read
---
Export the net to a file:

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts/export-pnml.sh" $ARGUMENTS
```

Confirm where it was written and summarize the net (place / transition / arc counts). If the user wants a
picture, offer to render a dark diagram from the JSON export using the snippet in `references/diagram-export.md`
(circles = places, rounded boxes = transitions, arrows = arcs). Write any rendered image to the user's
directory, never inside the plugin.
