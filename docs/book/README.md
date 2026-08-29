# The Agentic-Nets Book

This evolving book explains Agentic-Nets as a product model and an engineering
discipline. It is intentionally separate from installation and API reference:
the root [README](../../README.md) gets a new user to a running system, while
these chapters explain why the system is structured this way and how to design
with it.

## Contents

### [Chapter 1: What Agentic-Nets Is](chapter-01-what-agentic-nets-is.md)

Agentic-Nets as a governed, event-sourced operating runtime for persistent,
evolving processes:

- From workflow execution to living processes
- Persistent state outside temporary model context
- AI as one execution mechanism rather than the runtime itself
- The policy envelope around every action
- MCP as a programmable control plane
- Multiple cooperating process, persona, and tool nets
- Applications as projections over a live runtime
- Event history, evidence-based improvement, and crystallization

Start here if you are evaluating the project or need its complete mental model.

### [Chapter 2: Graph Engineering](chapter-02-graph-engineering.md)

The discipline of treating the harness as an explicit, executable graph:

- Places as state contracts, tokens as work, transitions as capabilities
- Hardened lanes with validation, QA, bounded rework, and human escape
- Testing, debugging, profiling, versioning, and distributing process graphs
- Giving AI a powerful but bounded role inside deterministic structure
- Improving the graph from retained execution evidence

Start here after Chapter 1 if you want to build or review real systems.

## Core principles

The chapters develop three principles:

> **The runtime owns the state. The AI uses the state.**

> **Agentic-Nets owns the process. AI supplies intelligence to the process.**

> **Use intelligence where uncertainty requires judgment. Use deterministic
> execution everywhere else.**

The goal is not maximum LLM usage. The goal is a process whose state,
permissions, evidence, and control structure survive whichever model currently
supplies its reasoning.

## See the ideas running

- [Hardened Lane](https://agentic-nets.com/#/shared-net/bd685551-ed9b-48ff-bf0c-6c32520d6f68) —
  the central Graph Engineering example, live and read-only.
- [Token Flow Basics](https://agentic-nets.com/#/shared-net/f2663810-bcce-4ed2-9507-40f77b3be04c) —
  the smallest useful structure.
- [Seven Transition Types](https://agentic-nets.com/#/shared-net/c1b98b10-c521-4b33-9318-7e68114fa3ec) —
  the complete execution vocabulary.
- [Crystallization](https://agentic-nets.com/#/shared-net/c989eac2-b6ef-4b35-a107-6ac3ef26d469) —
  the improvement loop represented as a net.

## Related reading

- [Documentation hub](../README.md)
- [Technical architecture](../../ARCHITECTURE.md)
- [Foundations and XML-Netze lineage](../../FOUNDATIONS.md)
- [Harness Control System whitepaper](../whitepaper/the-harness-control-system.html)
- [Net Application developer guide](../applications/DEVELOPER_GUIDE.md)
