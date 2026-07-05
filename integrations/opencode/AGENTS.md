# Working with AgenticNetOS from OpenCode

You are connected to an **AgenticNetOS** backend through the `agenticnets` MCP server.
AgenticNetOS is a Petri-net workflow OS: **places** hold JSON **tokens**, **transitions**
consume tokens, act (transform / LLM / HTTP / shell / agent), and emit results. Nets are
persistent, event-sourced, and can run autonomously (scheduled transitions) after you
disconnect. Everything here survives the session and is queryable.

## What you can do through the `agenticnets` tools

- **Persist working memory** — `memory_write` (capture), `memory_recall`, `memory_graph`,
  `memory_link`. Use this to remember decisions and facts across sessions.
- **Build & run nets** — `create_net`, `add_place`, `add_transition` (map/llm/http/command/
  agent/link), `fire_once`, `start_transition`, `set_schedule`. The full platform tool
  catalog is also present as native UPPERCASE tools (`CREATE_TRANSITION`, `SET_INSCRIPTION`,
  `QUERY_TOKENS`, `OBSERVE_MODEL`, event-line and knowledge tools, ...).
- **Reuse capability at zero LLM cost** — `scaffold_tool_net` / `invoke_tool_net`. When you
  work out a repeatable procedure (a shell/HTTP/LLM step), crystallize it into a tool-net so
  next time it is a single deterministic call.
- **Drive the platform agents** — `invoke_agent` runs one of the built-in agents and returns
  its result: `builder` (authors nets/inscriptions and deploys them), `operator` (diagnoses
  and repairs running nets), `genesis` (user-personal work), `domain-expert`, `chronicle`.
  This is the same agent loop and tool framework the AgenticNetOS GUI's Universal Assistant
  uses — so from OpenCode you can say "have the builder create a net that ..." and get it built.
- **Share & install** — NetHub `hub_search` / `hub_show` / `hub_install` / `hub_publish` to
  pull in nets/sessions/whole models others built, or publish your own.

## The discipline that makes this compound

The point of AgenticNetOS is that your work **accumulates into reusable software**, not just
chat. So:

1. When you solve something with a concrete sequence of steps (commands, HTTP calls), and it
   is worth repeating, **crystallize it into a tool-net** (`scaffold_tool_net` with the right
   `transitionKind`, then `invoke_tool_net`). Prefer invoking an existing tool-net over
   re-reasoning a known procedure.
2. When a task needs autonomous, multi-step platform work, **delegate to `invoke_agent`**
   rather than doing it by hand tool-by-tool.
3. **Record decisions** with `memory_write` so the next session (and scheduled nets) can build
   on them.

Use OpenCode's own file/shell/edit tools for local code work; use the `agenticnets` tools to
build, run, and remember the net-side of your world.
