# Community platform

A shared AgenticNets for many people. Each person gets an account (a tenant key), connects their own
MCP client, and builds and runs nets in their own models. The platform has no AI of its own: every
llm and agent lane is served by the person's connected client, and command lanes run only on
executors the person registers.

## What keeps people apart

| Fence | Where | What it does |
|---|---|---|
| Accounts and keys | gateway | A tenant key `ant_<tenant>_<hex>` signs in without a client id. Keys are stored as hashes; rotating a key or disabling an account stops its tokens at the next request. |
| Model prefix | gateway | A tenant owns the models whose id starts with `<tenant>-`. Every route a tenant may use is listed with where its model travels (path, query, body); everything else is refused. Inscription hosts and tool parameters that name another model are refused. Model lists come back filtered; a quota caps the number of models. |
| Second check | master, node | The gateway marks each request with the tenant; master and node refuse any other tenant's model on their own. |
| Community mode | master | AI off whatever else is configured; a model's command lanes go only to its tenant's executors; every inscription an executor receives has its hosts pinned to the lane's own model; `svc://` and private-network targets are refused; the platform's own MCP token is never granted. |
| MCP | MCP server | No shared secret: each request's bearer is the person's key and is served by that person's own context (own models, own token). Operator tools are not offered. |

## Run it

```bash
cd deployment
cp community/.env.community.template community/.env.community   # fill in fresh secrets
docker compose -p agenticos-community --env-file community/.env.community \
  -f docker-compose.community.yml up -d
```

Put TLS in front (`community/apache-community.conf.example`): `/oauth2`, `/api` and `/node-api` go to
the gateway, `/mcp` to the MCP server, everything else to Studio. Nothing else is published; the
services bind to loopback and talk on their own networks.

Memory: node and master are capped at 1.5 GiB each, gateway 768 MiB, vault and blobstore 512 MiB,
MCP 384 MiB, Studio 256 MiB (limits, not measured use).

## Accounts

With `AGENTICOS_TENANCY_SIGNUP=invite`, people sign up in Studio (or `POST /oauth2/register`) with an
invite code from `AGENTICOS_TENANCY_INVITE_CODES`; `open` lets anyone sign up; `off` means the
operator issues every key. The operator manages accounts with the admin token:

```bash
GW=https://community.example.com
ADMIN=$(curl -s -X POST $GW/oauth2/token -d grant_type=client_credentials \
  -d client_id=agenticos-admin -d client_secret="$(cat data/gateway/jwt/admin-secret)" | jq -r .access_token)

curl -s -H "Authorization: Bearer $ADMIN" $GW/api/tenants                                   # list
curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"tenant":"alice","modelsMax":5}' $GW/api/tenants                                       # create: key shown once
curl -s -X POST -H "Authorization: Bearer $ADMIN" $GW/api/tenants/alice/rotate                # new key
curl -s -X POST -H "Authorization: Bearer $ADMIN" $GW/api/tenants/alice/disable               # stop at once
curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"laptop"}' $GW/api/tenants/alice/executors                                      # executor key
```

Tenant ids are 3 to 24 lower-case letters and digits, starting with a letter. The registry lives in
`data/gateway/jwt/tenants.json` (hashes only). Removing a tenant leaves its models in place; nobody
else can open them.

## For the people who connect

**Connect an MCP client** (Claude Code shown; Cursor, Codex and Claude Desktop take the same URL and header):

```bash
claude mcp add --transport http agenticnets https://community.example.com/mcp \
  --header "Authorization: Bearer ant_alice_…"
```

On the first connection the platform creates `alice-main`. `create_model` adds more (the prefix is
added for you), up to the account's quota. Studio at the same address signs in with the same key.

**You are the reasoner.** This platform runs no AI. Agent and llm transitions in your nets wait for
you: `list_external_fires` shows the ready ones, `prepare_external_fire` gives you the exact prompt
and bindings, `complete_external_fire` writes your answer through the lane's own emit rules.

**Bring your own executor** for command lanes. Ask the operator for an executor key, then run the
executor anywhere that can reach the platform over HTTPS (it only polls out):

```bash
EXECUTOR_UPSTREAM_URL=https://community.example.com \
EXECUTOR_AUTH_CLIENT_ID=agenticos-executor \
EXECUTOR_AUTH_CLIENT_SECRET=axe_alice_laptop_… \
EXECUTOR_ID=alice-laptop \
EXECUTOR_MODELS=alice-main,alice-research \
java -jar agentic-net-executor.jar      # or the agenticnetos-executor image
```

`EXECUTOR_ID` must be `<tenant>-<name>` and `EXECUTOR_MODELS` must list your models (no `*`). Point a
command lane at it with `executorId: "alice-laptop"`. The executor runs commands with the rights of
the machine it runs on: run it where that is what you want.

## Proving the fence

The fence is tested on a live stack before every release: two fresh tenants are driven through
accounts, models and quota, every route family, the executor protocol, the master's lane hand-out
and host pinning, key rotation, the MCP server per tenant, an llm lane served end to end by a
tenant's own client, and a real executor running a tenant's command lane (76 checks, all passing on
2026-10-31).
