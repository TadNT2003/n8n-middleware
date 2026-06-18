# Plan: n8n Webhook Middleware

## Context

The user's self-hosted n8n is exposed to the internet via Cloudflare Tunnel + Traefik. This makes n8n's webhooks publicly reachable, but also means n8n itself is public. The goal is to insert a thin middleware that owns the public webhook surface while n8n is restricted to the internal Docker network. The middleware sits on the public domain, proxies only `/webhook/*` and `/webhook-test/*` paths to n8n locally, and rejects everything else.

## Technology Stack

- **Framework**: [Hono](https://hono.dev/) v4 — ~14KB, TypeScript-first, runs on Node.js via `@hono/node-server`
- **Runtime**: Node.js 22 LTS (built-in `fetch`, no extra HTTP client needed)
- **Language**: TypeScript
- **Scope**: Webhooks-only proxy, open (no auth), standalone Docker Compose project

## File Structure

```
n8n-middleware/
├── src/
│   └── index.ts         ← main server
├── package.json
├── tsconfig.json
├── Dockerfile
├── .dockerignore
├── docker-compose.yml
├── .env.example
├── .gitignore
└── PLAN.md              ← this plan (excluded from git & Docker)
```

## File-by-File Plan

### `package.json`

```json
{
  "name": "n8n-webhook-middleware",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch --import tsx/esm src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@hono/node-server": "^2.0.4",
    "hono": "^4.12.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "sourceMap": false
  },
  "include": ["src"]
}
```

### `src/index.ts`

Core logic — validate env, register routes, proxy handler, 404 catch-all:

```typescript
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Context } from 'hono'

const N8N_BASE_URL = process.env.N8N_BASE_URL?.replace(/\/$/, '')
if (!N8N_BASE_URL) {
  console.error('FATAL: N8N_BASE_URL environment variable is not set')
  process.exit(1)
}
const PORT = Number(process.env.PORT ?? 3000)

const app = new Hono()

// Request logging
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - start}ms)`)
})

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }))

// Proxy to n8n — preserves method, headers, body, and query string
async function proxyToN8N(c: Context): Promise<Response> {
  const url = new URL(c.req.url)
  const targetUrl = `${N8N_BASE_URL}${url.pathname}${url.search}`

  const headers = new Headers(c.req.raw.headers)
  headers.set('x-forwarded-for', c.req.header('x-forwarded-for') ?? '')
  headers.set('x-forwarded-host', c.req.header('host') ?? '')
  headers.set('x-forwarded-proto', 'https')

  const upstream = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore — duplex required for streaming request bodies in Node.js fetch
    duplex: 'half',
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
}

app.post('/webhook/*', proxyToN8N)
app.post('/webhook-test/*', proxyToN8N)

app.notFound((c) => c.text('Not Found', 404))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Middleware listening on :${info.port}`)
  console.log(`Proxying /webhook/* and /webhook-test/* → ${N8N_BASE_URL}`)
})
```

### `Dockerfile`

Multi-stage build — compiler and devDeps stay in stage 1, only `dist/` and prod deps go into the runtime image.

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### `docker-compose.yml`

Standalone project — connects to n8n's Docker network and Traefik's network as **external** networks. The container does not expose a host port; Traefik routes directly to it.

```yaml
services:
  n8n-webhook-middleware:
    image: n8n-webhook-middleware:latest
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    env_file: .env
    networks:
      - n8n_network
      - traefik_network
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.n8n-webhooks.rule=(PathPrefix(`/webhook/`) || PathPrefix(`/webhook-test/`)) && Method(`POST`)"
      - "traefik.http.routers.n8n-webhooks.entrypoints=websecure"   # adjust if Cloudflare Tunnel hits 'web'
      - "traefik.http.routers.n8n-webhooks.tls=true"
      - "traefik.http.services.n8n-webhooks.loadbalancer.server.port=3000"
      - "traefik.docker.network=traefik_network"   # tell Traefik which network to use

networks:
  n8n_network:
    external: true
    name: n8n_network       # ← replace with actual name from `docker network ls`
  traefik_network:
    external: true
    name: traefik_network   # ← replace with actual name from `docker network ls`
```

> **Important before deploying**: run `docker network ls` to find the real network names (usually `<compose-project-name>_<network-key>`). Update both `name:` fields. Also check if the Traefik entrypoint is `web` (HTTP) instead of `websecure` — remove the `tls=true` label if Cloudflare Tunnel already terminates TLS before reaching Traefik.

### `.env.example`

```dotenv
# Internal Docker address of the n8n container (use service name as hostname)
N8N_BASE_URL=http://n8n:5678

# Port the middleware listens on (change only if you also update Dockerfile/Traefik labels)
PORT=3000
```

### `.gitignore`

```
node_modules/
dist/
.env
*.log
PLAN.md
```

### `.dockerignore`

```
node_modules/
dist/
.env
*.log
PLAN.md
.git/
*.md
```

## Implementation Order

1. Create `src/` directory
2. Write `package.json`
3. Run `npm install` → generates `package-lock.json`
4. Write `tsconfig.json` and `src/index.ts`
5. Run `npm run build` → verify no TypeScript errors
6. Write `Dockerfile` and `.dockerignore`
7. Run `docker build -t n8n-webhook-middleware:latest .` → verify image builds
8. Write `.env.example`, copy to `.env`, fill in values
9. Write `docker-compose.yml` (after finding real network names)
10. Write `.gitignore`
11. Copy plan to `PLAN.md` in project root
12. Run `docker compose up -d`

## Post-Deploy Steps

After the middleware is running, two changes are needed in the n8n stack:
1. **Remove n8n's public webhook Traefik router** (or narrow its rule to exclude `/webhook/*`), so Traefik only sends webhooks to the middleware.
2. **Update n8n's `WEBHOOK_URL` / `N8N_WEBHOOK_URL` env var** to point to the public domain — n8n uses this to generate callback URLs in workflow UI.

## Verification

```bash
# Container is healthy
docker compose ps

# Health endpoint
curl http://localhost:3000/health
# → {"status":"ok"}

# Non-webhook path returns 404
curl -v http://localhost:3000/anything

# Webhook proxies through (replace with a real webhook ID)
curl -X POST http://localhost:3000/webhook/test-id \
  -H "Content-Type: application/json" -d '{"hello":"world"}'

# Logs show structured entries
docker compose logs -f n8n-webhook-middleware
# → POST /webhook/test-id → 200 (42ms)

# Docker image size should be ~90-110 MB
docker image inspect n8n-webhook-middleware:latest --format='{{.Size}}'
```
