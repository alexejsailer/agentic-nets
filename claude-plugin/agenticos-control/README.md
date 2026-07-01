# agenticos-control

A Claude Code plugin that lets any Claude Code session **fully control an AgenticOS / AgenticNetOS stack**:
inspect Agentic-Nets, read and edit places/tokens, drive the designtime + runtime REST APIs, fire and diagnose
transitions, author nets, drive the built-in personas (Universal Assistant / Genesis / Forge), and export net
diagrams. It is **CLI-first** (uses the public `agenticos` CLI when present) with a **curl fallback** that works
in either **direct** mode (local dev, no auth) or **gateway** mode (remote, OAuth2).

## What you get

- **Skill `agenticos-control`** — the control knowledge (REST surface, capability model, personas, ArcQL,
  transition templates, auth, recipes, diagram export) plus a dispatcher and helper scripts.
- **Agents** — `agenticos-net-designer` (build/author nets) and `agenticos-net-operator` (diagnose/fix running nets).
- **Commands** — `/agenticos-inspect`, `/agenticos-doctor`, `/agenticos-fire`, `/agenticos-persona`,
  `/agenticos-forge`, `/agenticos-export`.

## Install

```
/plugin marketplace add alexejsailer/agentic-nets
/plugin install agenticos-control@agentic-nets
```
(or, from a local clone: `/plugin marketplace add /path/to/agentic-nets`).

## Point it at a stack

`anos.sh` auto-detects: **gateway** when a secret is present, otherwise **direct**.

```bash
# Local dev (direct, no auth) — defaults to localhost:8082/8080
# nothing to set, or:
export AGENTICOS_MASTER=http://localhost:8082 AGENTICOS_NODE=http://localhost:8080

# Remote / production (gateway OAuth2)
export AGENTICOS_GATEWAY_URL=http://your-host:8083
export AGENTICOS_GATEWAY_SECRET_FILE=/path/to/gateway/admin-secret   # or AGENTICOS_ADMIN_SECRET=...
```

Then in Claude Code: `/agenticos-doctor` (preflight), `/agenticos-inspect <modelId>`, etc.

### Environment variables

| Var | Meaning | Default |
|-----|---------|---------|
| `AGENTICOS_MODE` | `cli` \| `curl` \| `auto` | `auto` |
| `AGENTICOS_AUTH` | `direct` \| `gateway` \| `auto` | `auto` |
| `AGENTICOS_MASTER` / `AGENTICOS_NODE` | direct base URLs | `:8082` / `:8080` |
| `AGENTICOS_GATEWAY_URL` | gateway base URL | `:8083` |
| `AGENTICOS_CLIENT_ID` | OAuth2 client id | `agenticos-admin` |
| `AGENTICOS_ADMIN_SECRET` / `AGENTICOS_GATEWAY_SECRET_FILE` | OAuth2 secret (env or file) | — |
| `AGENTICOS_MODEL` / `AGENTICOS_SESSION` | script defaults | — |

**Secrets** are read only from env / a `*_FILE`; the JWT is held in-process and never written to disk; the
secret and token are never printed (even with `ANOS_DEBUG=1`). See `skills/agenticos-control/references/auth.md`.

## License

Business Source License 1.1 (`BUSL-1.1`) — free for non-production use; converts to Apache 2.0 on 2030-02-22.
See `LICENSE`. BETA software, provided as-is with no warranty.
