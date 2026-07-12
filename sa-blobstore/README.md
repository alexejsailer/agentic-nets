# sa-blobstore

Small distributed blob store used by AgenticNets for large payloads that shouldn't live inside the event-sourced tree (generated articles, screenshots, file attachments, large tool outputs). Referenced from tokens by `blob://` URNs.

**Port**: `8090` (HTTP)

## What it does

- Content-addressed storage with optional replication across configured peers.
- CRUD over HTTP; blobs referenced by opaque URN so tokens stay small.
- Pluggable storage path; defaults to filesystem under `./target/blobstore-data`.

## Security & operations — read before deploying

The blobstore has **no built-in authentication**: every endpoint (upload, download,
overwrite, delete) is anonymous. Its confidentiality model rests on two things —
network isolation and unguessable ids — so how you deploy it matters.

- **Keep it on a trusted internal network.** In the bundled compose it sits only on the
  `agenticnetos-backend` network, is host-published on `127.0.0.1` by default, and is **not**
  routed by the gateway — so nothing external can reach it. Do not move it onto a client-facing
  network or bind it to a public interface without putting auth in front of it.

- **TLS is mandatory for any deployment reachable beyond a single trusted host.** The service
  speaks plain HTTP and does no transport encryption itself. If the blobstore is exposed across
  hosts, over a VPN boundary, or anywhere outside one machine's loopback, you **must** front it
  with an HTTPS/TLS terminating reverse proxy (and, given there is no auth, add an auth layer at
  that proxy too). Never send blob traffic — which can include large command output — over the
  network in clear text.

- **Blob ids are the access capability — they are CSPRNG-generated and unguessable.** With no
  auth, whoever holds a blob's id can read it, so the id must be infeasible to guess. Server-
  generated ids come from `java.security.SecureRandom`: the default `timestamp` strategy is
  `YYYY-MM-DD/<192-bit random token>` and the `uuid` strategy is a random UUIDv4. There is no
  list/enumerate endpoint, so ids cannot be discovered by scanning. **Exception:** the
  `content-hash` strategy (`sha256/<hash>`) is deterministic from the content — anyone who can
  guess the plaintext can reconstruct the id and confirm the blob exists. Use it only for
  non-confidential, dedup-friendly content (tool-catalog scripts and OpenAPI specs); never for
  secret payloads. Treat every URN as a bearer capability and don't log it where it shouldn't
  leak.

- **Storage is ephemeral unless you mount a volume.** Blobs are written under `STORAGE_PATH`
  (`/app/data` in the container). If that path is **not** on a named/host volume, every blob is
  lost when the container is recreated — including durable content such as tool-catalog script
  artifacts, whose catalog entries would then dangle at a missing URN. For anything beyond a
  throwaway dev run, mount `STORAGE_PATH` to a persistent volume.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `SA_BLOBSTORE_CLUSTER_NODE_ID` | `node1` | This node's identifier |
| `SA_BLOBSTORE_CLUSTER_NODES` | *(comma-list)* | Peer URLs for replication |
| `SA_BLOBSTORE_CLUSTER_MIN_REPLICAS` | `1` | Minimum replicas per blob |
| `SA_BLOBSTORE_CLUSTER_MAX_REPLICAS` | `2` | Maximum replicas per blob |
| `SA_BLOBSTORE_STORAGE_PATH` | `./target/blobstore-data` | Backing filesystem path |
| `SA_BLOBSTORE_CLUSTER_HEALTH_CHECK_INTERVAL` | `30000` | Peer heartbeat (ms) |

## Run

```bash
# Local (single-node)
cd sa-blobstore
./mvnw spring-boot:run

# Docker — mount STORAGE_PATH (/app/data) to a named volume so blobs survive recreation
docker run --rm -p 127.0.0.1:8090:8080 \
  -e STORAGE_PATH=/app/data \
  -v agenticos-blobs:/app/data \
  alexejsailer/agenticnetos-blobstore:latest
```

## API sketch

Base path `/api/blobs`; blobs referenced by `urn:agenticos:blob:<id>`.

```
POST   /api/blobs                → auto-generated id; returns { blobId, urn, sha256, size }
                                   (X-Id-Strategy: timestamp (default) | uuid | content-hash)
POST   /api/blobs/{id}           → upload with a caller-chosen id (overwrites if it exists)
GET    /api/blobs/{id}           → streaming bytes
HEAD   /api/blobs/{id}           → existence / content-length / etag
DELETE /api/blobs/{id}           → evict
```

## Integration

Master agents reference blobs via tokens like `{"type":"article","body":"blob://..."}`; the GUI's blob sidebar resolves URNs and renders previews.
