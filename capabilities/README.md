# Capabilities

A **capability pack** is a versioned, installable unit of skill for AgenticNetOS: a persona plus a
deterministic pipeline, packaged as nets, that takes one task token in natural language and returns
one verified result token. Packs live in this directory as plain files - you can read them, diff
them, review them in a PR, and install them into any AgenticNetOS installation.

Capabilities are **code, not prompts**: every pack ships its nets, its seed knowledge, its policy
defaults, and a smoke test. CI installs each pack into a scratch model and proves its lanes fire
before a change merges.

## Installing

From NetHub (the curated channel):

```
hub_install token-janitor@1.0.0
```

From this repository, or **any GitHub repository that follows the contract**:

```
hub_add_remote git+https://github.com/alexejsailer/agentic-nets#capabilities
hub_install token-janitor@1.0.0

# or a one-shot install from any repo, pinned to a ref:
hub_install git+https://github.com/someone/their-packs#v2.1.0//cool-pack
```

Git installs record the resolved commit SHA in the installation's `capabilities.lock`, so an
install is reproducible and an upgrade is a diff, not a guess.

## Using an installed pack

```
find_capabilities "clean up tokens"   -> discovers the pack + its delegation contract
delegate {capability: "token-janitor", request: "clear stale tokens from p-inbox in net-lab"}
```

The result token comes back correlated. Your session never loads the pack's interior - that is the
point.

## Contents

| Pack | Domain | What it does |
|------|--------|--------------|
| [`token-janitor`](token-janitor/) | platform-maintenance | NL-delegated token deletion: an agent decides the strategy, a deterministic pipeline measures, executes, re-measures and reports. Born interactively, exported to files. |
| [`place-inspector`](place-inspector/) | observability | NL-delegated read-only place inspection (count / sample - two live strategies behind one dispatch). Born as files, installed onto the runtime as written. |

## Authoring a pack

Read [`CONTRACT.md`](CONTRACT.md). It defines the runtime shape (front door, routing knowledge,
plan tokens, verdict lanes), the on-disk format (`capability.yaml` + layout), and the lifecycle
(export, publish, install, upgrade). `token-janitor/` is the reference implementation.
