# Recipes

`SD="${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts"`. Run `bash "$SD/anos.sh" preflight` first.

## Inspect a stack
```bash
bash "$SD/net-inspect.sh" <modelId>                       # transitions + states + schedules
bash "$SD/net-inspect.sh" <modelId> <sessionId>           # + nets in the session
bash "$SD/net-inspect.sh" <modelId> <sessionId> <netId>   # + places/transitions/arcs + live token counts
bash "$SD/anos.sh" arcql <modelId> 'FROM $ ORDER BY $.ts DESC LIMIT 5'
```

## Read / add / delete tokens
```bash
bash "$SD/place-tokens.sh" get    <modelId> <place>
bash "$SD/place-tokens.sh" count  <modelId> <place>
bash "$SD/place-tokens.sh" post   <modelId> <place> '{"status":"active","note":"hello"}'
bash "$SD/place-tokens.sh" delete <modelId> <place> <tokenId>
```

## Token surgery via events (when the runtime delete is not enough)
Runtime places are stored as nodes; delete a token with a `deleteLeaf` event carrying a non-blank `name` +
`parentId` (the place's node id). Read the token first to get its `_meta.id`, `_meta.name`, `_meta.parentId`:
```bash
bash "$SD/anos.sh" events <modelId> '{"events":[{"eventType":"deleteLeaf","parentId":"<placeNodeId>","id":"<tokenId>","name":"<tokenName>"}]}'
```

## Fire + diagnose a transition
```bash
bash "$SD/fire-transition.sh" <modelId> <transitionId>    # STOP -> fireOnce -> START (handles 409)
bash "$SD/diagnose.sh"        <modelId> <transitionId>    # state + error + recent events
bash "$SD/anos.sh" master POST /api/dryrun/transitions/<transitionId> '{"modelId":"<modelId>"}'
```

## Capacity drain (transition stopped firing, target place full)
```bash
bash "$SD/place-tokens.sh" count  <modelId> <targetPlace>          # >= capacity?
bash "$SD/place-tokens.sh" get    <modelId> <targetPlace>          # pick tokenIds
bash "$SD/place-tokens.sh" delete <modelId> <targetPlace> <id>     # drain a few, or raise the postset capacity
```

## Drive a persona
```bash
bash "$SD/drive-persona.sh" universal <modelId> "list the running transitions and flag any in error"
bash "$SD/drive-persona.sh" operator  <modelId> "why is t-forum-poll not firing?"
bash "$SD/drive-persona.sh" persona    <modelId> "build me a net that watches an RSS feed and files new items"
```

## Build a tool-net with Forge
```bash
bash "$SD/forge-run.sh" <modelId> "a tool that GETs a URL and returns the JSON body"
```

## Set a transition inscription (authoring)
Prefer the `agenticos-net-designer` agent. Raw:
```bash
bash "$SD/anos.sh" master POST /api/transitions/assign '{"modelId":"<m>","transitionId":"t-x","agentId":"agentic-net-executor-default","inscription":{ ...see transition-templates.md... },"credentials":{}}'
bash "$SD/anos.sh" master POST /api/transitions/t-x/start '{"modelId":"<m>"}'
```
Remember: after re-assigning an inscription the transition is stopped; START it again.
