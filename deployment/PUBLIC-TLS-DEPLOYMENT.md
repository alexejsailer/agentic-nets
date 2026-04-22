# Public TLS deployment — Apache + Let's Encrypt in front of the compose stack

How to expose an Agentic-Nets deployment at `https://<your-domain>/` with a
real TLS cert and no public port numbers visible.

This is written for a Debian/Ubuntu host where Apache2 + certbot are already
installed and port 80/443 are reachable from the internet. The same recipe
works for any public domain.

---

## Architecture

```
  public internet
        │
        ▼  443 (TLS)
   ┌─────────┐     proxy_http       ┌──────────────┐
   │ Apache2 │ ─── /         ────►  │ gui     :4200│  (docker)
   │  (host) │ ─── /api      ────►  │ gateway :8083│  (docker)
   │         │ ─── /node-api ────►  │ gateway :8083│  (docker)
   └─────────┘     proxy_wstunnel   └──────────────┘
                                           │
                                           ▼
                                    (internal docker network:
                                     master, node, vault, executor)
```

The gateway fronts master + node, so only the gateway is exposed — master
and node stay on the internal docker network. Apache terminates TLS and
reverse-proxies on loopback; the docker containers bind to `127.0.0.1`
so nothing is reachable from the internet except the Apache ports.

---

## Prerequisites

- Apache2 with `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, `mod_rewrite`,
  `mod_ssl`, `mod_headers` enabled.
- `certbot` installed (deb or snap; both work).
- DNS `A` (or `AAAA`) records for your apex and `www.` both pointing at the
  host.
- The docker compose stack running with at least `agentic-net-gui` (port 4200)
  and `agentic-net-gateway` (port 8083) healthy. Confirm from the host with
  `curl -sI http://127.0.0.1:4200/ | head -1` → `200 OK`.

---

## Phase 1 — Enable Apache modules

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
sudo systemctl reload apache2
```

---

## Phase 2 — Write the apex vhost

Create `/etc/apache2/sites-available/<your-domain>.conf` (replace
`<your-domain>` below):

```apache
<VirtualHost *:80>
    ServerName   <your-domain>
    ServerAlias  www.<your-domain>

    ProxyPreserveHost On
    ProxyRequests     Off
    ProxyTimeout      300

    # WebSocket upgrade — MUST come before the generic ProxyPass /
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/(.*)$ ws://127.0.0.1:4200/$1 [P,L]

    # Public API → gateway (JWT + routing to master/node)
    ProxyPass        /api         http://127.0.0.1:8083/api
    ProxyPassReverse /api         http://127.0.0.1:8083/api
    ProxyPass        /node-api    http://127.0.0.1:8083/node-api
    ProxyPassReverse /node-api    http://127.0.0.1:8083/node-api

    # Everything else → GUI
    ProxyPass        /  http://127.0.0.1:4200/
    ProxyPassReverse /  http://127.0.0.1:4200/

    ErrorLog  ${APACHE_LOG_DIR}/<your-domain>-error.log
    CustomLog ${APACHE_LOG_DIR}/<your-domain>-access.log combined
</VirtualHost>
```

Enable and reload:

```bash
sudo a2ensite <your-domain>.conf
sudo apache2ctl configtest            # must say "Syntax OK"
sudo systemctl reload apache2

# Sanity check — should 200 OK through Apache already, still plain HTTP
curl -sI -H 'Host: <your-domain>' http://127.0.0.1/ | head -3
```

The reason we define the vhost as `:80` first and let certbot clone it
into a `:443` variant is so that **all the `ProxyPass` rules automatically
carry over** to the TLS vhost without us writing them twice.

---

## Phase 3 — Issue TLS via certbot

```bash
sudo certbot --apache \
  -d <your-domain> -d www.<your-domain> \
  --redirect --agree-tos --no-eff-email \
  -m <your-email>
```

What certbot does for you:
- Issues a single cert for apex + `www`.
- Generates `/etc/apache2/sites-available/<your-domain>-le-ssl.conf` with a
  `*:443` vhost that inherits the `:80` vhost's `ProxyPass` rules + adds
  `SSLEngine on`, the cert paths, and `Include letsencrypt-options-ssl-apache.conf`.
- Rewrites the `:80` vhost to `Redirect permanent / https://<your-domain>/`.
- Registers a renewal job (systemd timer for deb-certbot; snapd's internal
  timer for snap-certbot — `certbot renew --dry-run` should succeed either way).

---

## Phase 4 — Lock container ports to loopback

Currently `agentic-net-gui` and `agentic-net-gateway` bind to `0.0.0.0:*`,
which means the world can still reach them on `http://host:4200` /
`http://host:8083` even after Apache goes up. Fix by prefixing the port
bindings with `127.0.0.1:`.

Override the port bindings in your compose file (or via a compose `override.yml`):

```yaml
services:
  agentic-net-gateway:
    ports:
      - "127.0.0.1:${AGENTIC_NET_GATEWAY_PORT:-8083}:8083"
  agentic-net-gui:
    ports:
      - "127.0.0.1:${AGENTIC_NET_GUI_PORT:-4200}:4200"
```

Then:

```bash
cd /opt/agenticos         # or wherever your compose file lives
docker compose --env-file .env up -d agentic-net-gui agentic-net-gateway
```

The services restart; only localhost on the host can reach the container
ports now.

> The two **public-repo** compose files
> (`deployment/docker-compose.yml`, `deployment/docker-compose.hub-only.yml`)
> intentionally still bind to `0.0.0.0`, because people running the stack
> locally often want LAN access from a phone or other device. The loopback
> change is only for production deployments that sit behind a reverse proxy.

---

## Phase 4.5 — Allow your public origin in CORS (REQUIRED for browser login)

The default CORS whitelist in `.env.template` only allows
`http://localhost:*` and `http://127.0.0.1:*`. As soon as you reach the GUI
through your real domain the browser sends
`Origin: https://<your-domain>`, the gateway and master reject it with
`HTTP 403 "Invalid CORS request"`, and **the login button silently fails**.

Edit `.env` and add your public origin to **both** CORS lists:

```bash
# .env  (your deployment's environment file)
GATEWAY_CORS_ALLOWED_ORIGIN_PATTERNS=http://localhost:*,http://127.0.0.1:*,https://<your-domain>
AGENTICOS_CORS_ALLOWED_ORIGIN_PATTERNS=http://localhost:*,http://127.0.0.1:*,https://<your-domain>
```

Recreate the gateway + master so they pick up the new env (executor and
GUI don't need a restart, they don't enforce CORS):

```bash
docker compose up -d --force-recreate --no-deps agentic-net-gateway agentic-net-master
```

Verify the fix mimicking what the browser does (note the `Origin` header):

```bash
curl -sS -X POST https://<your-domain>/oauth2/token \
  -H 'Origin: https://<your-domain>' \
  -d 'grant_type=client_credentials&client_id=agenticos-admin&client_secret=<your-admin-secret>&scope=admin'
```

A JSON body with `access_token` = success. `Invalid CORS request` = the
origin is still not in the whitelist (typo, missing scheme, or the gateway
didn't actually pick up the new env — re-check with `docker exec
<container>-gateway printenv GATEWAY_CORS_ALLOWED_ORIGIN_PATTERNS`).

---

## Phase 5 — Verify

```bash
# From anywhere on the internet:
curl -sI https://<your-domain>/           # 200 OK, Server: nginx/... (GUI)
curl -sI http://<your-domain>/            # 301 → https (certbot's redirect)
curl -sI https://<your-domain>/api/health/ping   # 200 (gateway via Apache)
curl -sI https://www.<your-domain>/       # 200 OK

# From your laptop, raw container ports must be refused:
nc -vz -w 4 <host-ip> 4200                # Connection refused
nc -vz -w 4 <host-ip> 8083                # Connection refused

# On the host:
ss -tlnp | grep -E ':(4200|8083)\b'       # both lines show 127.0.0.1, not 0.0.0.0
sudo certbot renew --dry-run              # confirms renewal is wired up
```

Browser check: load `https://<your-domain>/#/docs`, open DevTools → Network.
All XHRs should go to `https://<your-domain>/api/...` and `.../node-api/...`.
If any hit `localhost:8082` or similar, the GUI image was built for local
dev — rebuild with the production Dockerfile.

---

## Coexisting with other vhosts

Other vhosts on the same Apache (mailing list, blog, etc.) are unaffected as
long as they live on **different subdomains** (e.g. `list.<your-domain>`).
Apache's NameVirtualHost matching on `ServerName` keeps them isolated; the
new apex cert is scoped to apex + `www` only.

If another vhost already answers for the apex, you have to decide whether
to merge paths (GUI at `/`, other thing at `/some-prefix/`) or move one of
them to a subdomain before applying Phase 2.

---

## Troubleshooting

**`502 Proxy Error`** — the container isn't listening yet. Check
`docker compose ps` and `curl http://127.0.0.1:4200/` from the host. Usually
a transient startup issue; wait for the healthcheck.

**`421 Misdirected Request`** — HTTP/2 routing bug, usually from a stale
cert. Check `certbot certificates` and re-run Phase 3 with `--force-renewal`
if you just changed the domain list.

**XHRs hit `localhost:*` in the browser** — the running GUI image was
built for dev, not prod. Rebuild the GUI with the production Dockerfile
and `docker compose up -d agentic-net-gui`.

**Login button does nothing / `403 Invalid CORS request` in DevTools** —
your public origin isn't in the gateway's allow-list. See Phase 4.5
above.

**WebSocket disconnects** — verify `mod_proxy_wstunnel` is loaded
(`apache2ctl -M | grep wstunnel`) and the `RewriteRule` for `Upgrade:
websocket` is **above** the generic `ProxyPass /`.
