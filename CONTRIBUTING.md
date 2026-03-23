# Contributing to AgenticOS Agentic-Nets

Thank you for your interest in contributing to AgenticOS. This document provides guidelines for contributing to the open-source components of the project.

## License

This repository is licensed under the **Business Source License 1.1** (BSL 1.1). On **2030-02-22**, it converts to **Apache License 2.0**. By submitting a contribution, you agree that your contribution will be licensed under the same terms.

See [LICENSE.md](LICENSE.md) for the full license text.

> **Note**: The closed-source services (node, master, gui) are not part of this repository. They are distributed as Docker Hub images under [PROPRIETARY-EULA.md](PROPRIETARY-EULA.md).

## Development Environment

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Java | 21 (Temurin recommended) | Gateway, Executor, Vault, Blobstore |
| Maven | 3.9+ (bundled via `mvnw`) | Java build tool |
| Node.js | 22+ | CLI, Chat |
| npm | 10+ | Node package manager |
| Docker | 24+ | Container builds and local deployment |
| Docker Compose | 2.20+ | Multi-service orchestration |

### Setup

```bash
git clone https://github.com/alexejsailer/agentic-nets.git
cd agentic-nets
```

## Building

### Java Services

Each Java service uses the Maven wrapper (`mvnw`), so no global Maven installation is needed.

```bash
# Build a single service
cd agentic-net-gateway && ./mvnw clean package -DskipTests

# Build all Java services
for svc in agentic-net-gateway agentic-net-executor agentic-net-vault sa-blobstore; do
  (cd "$svc" && ./mvnw clean package -DskipTests)
done
```

### TypeScript Services

```bash
# Build CLI (must be built first — chat depends on it)
cd agentic-net-cli && npm install && npx tsup

# Build Chat
cd agentic-net-chat && npm install && npx tsup
```

> **Important**: `agentic-net-chat` depends on `agentic-net-cli` via a `file:../agentic-net-cli` link. Always build CLI before Chat.

## Running Locally

```bash
cd deployment
cp .env.template .env
# Edit .env with your configuration (LLM provider, API keys, etc.)

# Option A: All pre-built images from Docker Hub
docker compose -f docker-compose.hub-only.yml up -d

# Option B: Hybrid — build open-source locally, closed-source from Hub
docker compose up -d
```

See [deployment/.env.template](deployment/.env.template) for available configuration options.

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

<optional body>
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Build, CI, or tooling changes |
| `perf` | Performance improvement |

### Scopes

Use the service name as scope: `gateway`, `executor`, `vault`, `cli`, `chat`, `blobstore`, `deployment`, `monitoring`.

### Examples

```
feat(executor): add timeout configuration for command transitions
fix(gateway): handle expired JWT refresh correctly
docs(cli): update provider configuration examples
chore(deployment): bump Java base image to 21.0.5
```

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Build** all affected services to verify your changes compile.
3. **Test** locally using Docker Compose to verify integration.
4. **Commit** with a conventional commit message.
5. **Push** to your fork and open a Pull Request against `main`.
6. Fill in the PR template completely.
7. Wait for CI to pass (Java build, TypeScript build, Docker smoke test).
8. A maintainer will review and merge your PR.

### PR Guidelines

- Keep PRs focused on a single concern.
- If your change affects multiple services, explain the cross-service impact in the PR description.
- Update documentation if you change public APIs or configuration.
- Do not include secrets, API keys, or `.env` files in your commits.
