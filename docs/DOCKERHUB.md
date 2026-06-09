# n8n Webhook Middleware

A lightweight HTTP proxy that keeps a self-hosted [n8n](https://n8n.io/) instance off the public internet while selectively exposing its webhook endpoints — and optionally its web interface and REST API.

Built on [Hono](https://hono.dev/) v4 + Node.js 22 LTS. Single-file, no external HTTP client, ~90–110 MB image.

---

## How it works

```
Internet → Cloudflare Tunnel → Traefik → n8n-middleware → n8n (internal network)
```

n8n runs on an internal Docker network with no public exposure. This container is the only publicly-reachable component. By default it accepts only `POST /webhook/*` and `POST /webhook-test/*`, forwarding them verbatim to n8n. All other paths return `404`.

---

## Features

- **Webhook-only by default** — non-webhook traffic never reaches n8n
- **GitHub signature verification** — optional HMAC-SHA256 validation via `GITHUB_WEBHOOK_SECRET`; invalid or unsigned requests are rejected with `401` before reaching n8n
- **Configurable UI exposure** — set `N8N_EXPOSE_UI=true` to proxy the full n8n web interface through the middleware
- **Configurable API exposure** — set `N8N_EXPOSE_API=true` to proxy the n8n REST API (`/api/*`) through the middleware
- **Health endpoint** — `GET /health` returns `{"status":"ok"}` for container health checks
- **X-Forwarded headers** — sets `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` so n8n sees the real client origin
- **Streaming proxy** — request and response bodies are streamed without buffering (body is buffered only when GitHub signature verification is active)

---

## Quick start

### Docker Compose (recommended)

```yaml
services:
  n8n-webhook-middleware:
    image: <your-image>:latest
    restart: unless-stopped
    env_file: .env
    expose:
      - "3000"
    networks:
      - traefik_reverse_proxy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.n8n-webhooks-proxy.rule=(PathPrefix(`/webhook/`) || PathPrefix(`/webhook-test/`)) && Method(`POST`) && Host(`${N8N_MIDDLEWARE_HOST}`)"
      - "traefik.http.routers.n8n-webhooks-proxy.entrypoints=web,websecure"
      - "traefik.http.routers.n8n-webhooks-proxy.tls=true"
      - "traefik.http.services.n8n-webhooks-proxy.loadbalancer.server.port=3000"
      - "traefik.http.routers.n8n-all-proxy.rule=Host(`${N8N_MIDDLEWARE_HOST}`)"
      - "traefik.http.routers.n8n-all-proxy.entrypoints=web,websecure"
      - "traefik.http.routers.n8n-all-proxy.tls=true"
      - "traefik.http.routers.n8n-all-proxy.service=n8n-webhooks-proxy"

networks:
  traefik_reverse_proxy:
    external: true
```

---

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `N8N_BASE_URL` | Yes | — | Internal URL of the n8n container, e.g. `http://n8n:5678` |
| `N8N_MIDDLEWARE_HOST` | Yes | — | Public hostname Traefik routes to this container, e.g. `n8n.mydomain.com` |
| `PORT` | No | `3000` | Port the server listens on inside the container |
| `GITHUB_WEBHOOK_SECRET` | No | — | If set, all webhook requests must carry a valid `X-Hub-Signature-256` header |
| `N8N_EXPOSE_UI` | No | `false` | Proxy all non-`/api/*` paths to n8n (web interface, static assets, `/rest/*`) |
| `N8N_EXPOSE_API` | No | `false` | Proxy `/api/*` paths to n8n (public REST API) |

> `N8N_BASE_URL` is validated at startup — the container exits immediately if it is missing.

---

## Routes

| Method | Path | Condition | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health` | Always | Returns `{"status":"ok"}` |
| `POST` | `/webhook/*` | Always | GitHub signature check (if secret set) → proxy to n8n |
| `POST` | `/webhook-test/*` | Always | GitHub signature check (if secret set) → proxy to n8n |
| Any | non-`/api/*` paths | `N8N_EXPOSE_UI=true` | Proxy to n8n |
| Any | `/api/*` | `N8N_EXPOSE_API=true` | Proxy to n8n |
| Any | Anything else | — | `404 Not Found` |

---

## GitHub webhook verification

When `GITHUB_WEBHOOK_SECRET` is set, the middleware verifies every incoming webhook request before forwarding it:

1. Checks for the `X-Hub-Signature-256` header — returns `401` if missing
2. Computes `sha256=<HMAC-SHA256(secret, body)>` and compares using constant-time equality
3. Returns `401 Invalid signature` on mismatch; forwards to n8n on success

This matches the [GitHub webhook security specification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

---

## Known limitations

- **WebSockets are not supported.** The n8n UI uses WebSocket connections for live execution status. These will fail when proxied through this middleware. Workflow execution itself is unaffected; only the real-time UI indicator does not work.

---

## Building from source

```bash
git clone <repo>
cd n8n-middleware
docker build -t n8n-webhook-middleware .
```

The Dockerfile uses a two-stage build: a `builder` stage compiles TypeScript, and a minimal `node:22-alpine` runtime stage copies only `dist/` and production `node_modules`. The TypeScript compiler is not present in the final image.
