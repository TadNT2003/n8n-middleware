# n8n Webhook Middleware

A lightweight HTTP proxy that sits in front of a self-hosted [n8n](https://n8n.io/) instance. By default it exposes **only** webhook endpoints to the public internet; everything else returns 404. Optionally the n8n web interface (`N8N_EXPOSE_UI`) and public REST API (`N8N_EXPOSE_API`) can be selectively enabled. Incoming webhook requests can be verified against a GitHub HMAC signature (`GITHUB_WEBHOOK_SECRET`).

## Why this exists

A typical self-hosted n8n setup behind Traefik + Cloudflare Tunnel puts the entire n8n UI and API on a public domain. Even with Cloudflare Access policies protecting the UI, the webhook paths (`/webhook/*`) must remain open — which means n8n itself has to be reachable from the internet.

This middleware solves that by becoming the only public-facing component. n8n is moved to the internal Docker network; the middleware receives incoming webhook POST requests and proxies them to n8n locally. Everything else returns 404.

```text
Internet
  │  POST /webhook/<id>
  ▼
Cloudflare Tunnel
  │
  ▼
Traefik (traefik_reverse_proxy network)
  │  matches: Host + PathPrefix(/webhook/) + Method(POST)
  ▼
n8n-webhook-middleware  ←── this service
  │  http://n8n:5678/webhook/<id>
  ▼
n8n (internal network only)
```

## Stack

| | |
| --- | --- |
| Framework | [Hono](https://hono.dev/) v4 — ~14 KB, TypeScript-first |
| Runtime | Node.js 22 LTS (built-in `fetch`, no extra HTTP client) |
| Language | TypeScript, compiled to ESM |
| Image base | `node:22-alpine` (multi-stage build) |

## Routes

| Method | Path | Condition | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health` | always | Returns `{"status":"ok"}` |
| `POST` | `/webhook/*` | always | GitHub signature check (if secret set) → proxied to n8n |
| `POST` | `/webhook-test/*` | always | GitHub signature check (if secret set) → proxied to n8n |
| any | non-`/api/*` paths | `N8N_EXPOSE_UI=true` | Proxied to n8n — HTTP and WebSocket |
| any | `/api/*` | `N8N_EXPOSE_API=true` | Proxied to n8n — HTTP and WebSocket |
| any | anything else | — | `404 Not Found` |

The `n8n-webhooks-proxy` Traefik router (POST + webhook paths only) and the `n8n-all-proxy` Traefik router (all methods/paths) are both always declared in `docker-compose.yml`. The middleware itself is the access gate — when `N8N_EXPOSE_UI` and `N8N_EXPOSE_API` are both false, non-webhook traffic still returns 404 even though Traefik routes it to the container.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```dotenv
# Internal Docker address of the n8n container.
# The hostname is the service name in the n8n Docker Compose stack.
N8N_BASE_URL=http://n8n:5678

# Port the middleware listens on inside the container (default: 3000).
PORT=3000

# Public hostname Traefik uses to match incoming requests.
# Plain hostname only — no protocol, no trailing slash.
# Example: n8n.mydomain.com
N8N_MIDDLEWARE_HOST=n8n.mydomain.com
```

> `N8N_MIDDLEWARE_HOST` must be a bare hostname (e.g. `n8n.mydomain.com`), not a URL. Traefik's `Host()` rule does not accept `http://` prefixes.

## Deployment

### Prerequisites

- Docker + Docker Compose v2
- An existing Traefik container attached to the `traefik_reverse_proxy` Docker network (or whatever your Traefik network is named — update the `networks` block in `docker-compose.yml` to match)
- The n8n container must be reachable from this service by its Docker service name (they must share a Docker network, or n8n's hostname must be resolvable)

### 1. Build the image

```bash
docker compose build
```

The multi-stage Dockerfile compiles TypeScript in a builder stage and produces a lean runtime image (~90–110 MB). The TypeScript compiler and dev dependencies are not included in the final image.

### 2. Configure `.env`

```bash
cp .env.example .env
# edit .env with your actual values
```

### 3. Start the service

```bash
docker compose up -d
docker compose ps   # wait for 'healthy'
```

### 4. Verify locally

```bash
# Health check
curl http://localhost:${PORT}/health
# → {"status":"ok"}

# Non-webhook path must return 404
curl -v http://localhost:${PORT}/anything

# Webhook proxy (replace with a real workflow webhook ID)
curl -X POST http://localhost:${PORT}/webhook/your-id \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

### 5. Tail logs

```bash
docker compose logs -f n8n-webhook-middleware
# POST /webhook/your-id → 200 (38ms)
```

## Traefik integration

The `docker-compose.yml` labels configure a Traefik router named `n8n-webhooks-proxy`:

```yaml
rule: (PathPrefix(`/webhook/`) || PathPrefix(`/webhook-test/`)) && Method(`POST`) && Host(`<N8N_MIDDLEWARE_HOST>`)
entrypoints: web, websecure
tls: true
```

Traefik reads these labels automatically via the Docker provider. No static Traefik config changes are needed.

**After deploying this middleware**, update your n8n Compose stack:

1. **Remove or narrow the webhook router on n8n** — if n8n's Traefik labels currently route `/webhook/*` to it, remove that rule (or restrict it to internal-only entrypoints). Otherwise Traefik will load-balance between the middleware and n8n directly.

2. **Update n8n's `N8N_WEBHOOK_URL` environment variable** — n8n uses this to build the callback URLs it shows in the workflow editor. It should still point to your public domain so the generated URLs are correct:

   ```dotenv
   N8N_WEBHOOK_URL=https://n8n.mydomain.com/
   ```

## Local development

Run the server with hot-reload (no Docker required):

```bash
npm install
cp .env.example .env   # set N8N_BASE_URL to a reachable n8n instance
npm run dev
```

`tsx` watches `src/` and restarts on changes. The server starts on `PORT` (default `3000`).

To compile and run the production build locally:

```bash
npm run build
npm start
```

## Project structure

```text
n8n-middleware/
├── src/
│   └── index.ts          # Hono server — proxy logic, logging, health check
├── package.json
├── tsconfig.json
├── Dockerfile            # multi-stage: builder (tsc) → runtime (node:22-alpine)
├── .dockerignore
├── docker-compose.yml    # standalone stack, external Traefik network
├── .env.example
└── .gitignore
```

## How the proxy works

Each incoming `POST /webhook/*` request is forwarded to n8n as-is:

- **Body** is streamed directly (no buffering) — handles large JSON payloads and binary data correctly
- **Headers** are forwarded, with `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto: https` set/chained so n8n sees the real client origin
- **Query string** is preserved — some webhook senders include parameters in the URL
- **Response** (status, headers, body) is streamed back to the caller unchanged
