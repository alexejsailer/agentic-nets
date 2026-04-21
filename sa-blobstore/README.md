# sa-blobstore

Small distributed blob store used by AgenticNets for large payloads that shouldn't live inside the event-sourced tree (generated articles, screenshots, file attachments, large tool outputs). Referenced from tokens by `blob://` URNs.

**Port**: `8090` (HTTP)

## What it does

- Content-addressed storage with optional replication across configured peers.
- CRUD over HTTP; blobs referenced by opaque URN so tokens stay small.
- Pluggable storage path; defaults to filesystem under `./target/blobstore-data`.

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

# Docker
docker run --rm -p 8090:8090 \
  -v agenticos-blobs:/app/target/blobstore-data \
  alexejsailer/agenticnetos-blobstore:2.1.8
```

## API sketch

```
PUT  /blobs              → returns { urn: "blob://..." }
GET  /blobs/{urn}        → streaming bytes
HEAD /blobs/{urn}        → existence / content-length / etag
DELETE /blobs/{urn}      → evict
```

## Integration

Master agents reference blobs via tokens like `{"type":"article","body":"blob://..."}`; the GUI's blob sidebar resolves URNs and renders previews.
