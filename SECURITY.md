# Security Policy

## Status

AgenticNetOS is **BETA software**. It is actively developed and the security model is still evolving. Do not use it to run untrusted agent code against sensitive data or production systems without additional isolation.

## Reporting a Vulnerability

Please report security vulnerabilities privately. Do **not** open public GitHub issues for security problems.

- **Email**: alexejsailer@gmail.com
- **Subject**: `SECURITY — agentic-nets — <short title>`

Include:
- Affected service(s) and version (`AGENTICNETOS_VERSION`)
- Deployment mode (hub-only compose, hybrid, bare-metal)
- Reproduction steps
- Impact assessment and any suggested fix

You can expect an acknowledgement within 72 hours and a status update within 7 days.

## Supported Versions

Only the latest minor release receives security fixes. See [CHANGELOG.md](CHANGELOG.md) for the current version.

## Threat Model Highlights

The coordination fabric lets autonomous agents take actions. Specific areas to be aware of:

### 1. Agent role boundaries (`rwxhl`)
Agent transitions declare a capability role. Misconfigured roles are the most likely path to privilege escalation within a net. Default agents to the least capability that works. Treat `x` (execute) and `h` (HTTP) as the high-risk flags.

### 2. Command executor
`agentic-net-executor` runs shell commands via `ProcessBuilder("bash", "-c", …)` with the operating-system privileges of the container. Never run the executor on a host that can reach services it should not. Containerization is the enforcement boundary.

### 3. Gateway admin secret
`agentic-net-gateway` auto-generates an admin secret on first startup and stores it at `./data/gateway/jwt/admin-secret`. Treat this file as root-equivalent credential — anyone with read access can acquire an admin JWT. The CLI and chat containers mount this file read-only.

### 4. Vault / OpenBao
`agentic-net-vault` wraps OpenBao in dev mode when run from the bundled compose. For shared or internet-facing deployments, replace the dev root token and switch to AppRole auth. See [agentic-net-vault/README.md](agentic-net-vault/README.md).

### 5. Public exposure
The compose file binds services to `127.0.0.1` by default. When exposing to a network, front the gateway with Apache/Nginx + TLS (see [deployment/PUBLIC-TLS-DEPLOYMENT.md](deployment/PUBLIC-TLS-DEPLOYMENT.md)) and lock the gateway to a single public port.

### 6. LLM injection
Tokens in places can reach LLM-backed agents. Treat token content as untrusted input and design agent prompts with explicit grounding rules (see Pattern 6 in the builder agent knowledge).

## Disclosure Policy

Validated issues are disclosed coordinated with a fix release. Reporters are credited in the CHANGELOG unless anonymity is requested.
