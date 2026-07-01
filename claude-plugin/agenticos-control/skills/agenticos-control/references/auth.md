# Auth + configuration

Two ways to reach a stack. `anos.sh` auto-detects: **gateway** when a secret is present, else **direct**.

## Direct (local dev, no auth)
Talk straight to master `:8082` and node `:8080`. This is the default when no gateway secret is set.
```bash
export AGENTICOS_AUTH=direct                 # optional; auto when no secret
export AGENTICOS_MASTER=http://localhost:8082
export AGENTICOS_NODE=http://localhost:8080
```
Note: on a Docker deployment, master/node are usually only reachable inside the backend network (not published
to the host). From the host, prefer gateway mode.

## Gateway (remote / production, OAuth2)
The gateway (`:8083`) issues a JWT via client-credentials and routes master under `/api/**` (node under
`/node-api/**`; the scripts route node work through master's `/api/proxy/...` so you rarely need it).
```bash
export AGENTICOS_GATEWAY_URL=http://your-host:8083
export AGENTICOS_ADMIN_SECRET="<the gateway admin secret>"      # OR:
export AGENTICOS_GATEWAY_SECRET_FILE=/path/to/admin-secret      # a file containing the secret
export AGENTICOS_CLIENT_ID=agenticos-admin                      # default
```
On a compose deployment the admin secret is generated on first gateway start and lives in the gateway data
volume (e.g. `data/gateway/jwt/admin-secret`, mounted read-only for the CLI/executor). Read it from there;
never paste it into a command line that gets logged. A `readonly` client also exists (GET-only scope).

## Full env-var table

| Var | Meaning | Default |
|-----|---------|---------|
| `AGENTICOS_MODE` | `cli` \| `curl` \| `auto` | `auto` (CLI if `agenticos` on PATH, else curl) |
| `AGENTICOS_AUTH` | `direct` \| `gateway` \| `auto` | `auto` (gateway if a secret is present) |
| `AGENTICOS_MASTER` | direct master base URL | `http://localhost:8082` |
| `AGENTICOS_NODE` | direct node base URL | `http://localhost:8080` |
| `AGENTICOS_GATEWAY_URL` (alias `AGENTICOS_GATEWAY`) | gateway base URL | `http://localhost:8083` |
| `AGENTICOS_CLIENT_ID` | OAuth2 client_id | `agenticos-admin` |
| `AGENTICOS_ADMIN_SECRET` | OAuth2 client_secret | — |
| `AGENTICOS_GATEWAY_SECRET_FILE` | file to read the secret from | — |
| `AGENTICOS_GATEWAY_SECRET` | alias for the secret | — |
| `AGENTICOS_MODEL` / `AGENTICOS_SESSION` | default model / session for scripts | — |
| `AGENTICOS_TIMEOUT` | per-request curl timeout (s) | `25` |
| `ANOS_DEBUG` | `1` prints request lines to stderr (never secrets) | `0` |

## Secret hygiene (enforced by anos.sh, follow it everywhere)
- Read the secret only from an env var or `AGENTICOS_GATEWAY_SECRET_FILE`. Never hardcode it in a script or command.
- The JWT is acquired in-process and **never written to disk**. `anos.sh` never prints the secret or the token,
  even with `ANOS_DEBUG=1`. Do not `echo` them yourself, and do not paste them into chat.
- `anos.sh preflight` reports auth status and reachability with no secrets, so it is safe to show.
