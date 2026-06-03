# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Hot-reload dev server via tsx
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled build (dist/index.js)
```

There are no tests or lint commands configured.

## Architecture

A single-file HTTP proxy (`src/index.ts`) built on [Hono](https://hono.dev/) + `@hono/node-server`. Its only job: accept incoming POST requests at `/webhook/*` and `/webhook-test/*`, forward them verbatim to an internal n8n instance, and return the response. All other paths return 404. There is a `/health` endpoint for container health checks.

**Request path:**
```
Internet → Cloudflare Tunnel → Traefik → n8n-middleware (this service) → n8n (internal Docker network)
```

**Why it exists:** n8n runs on an internal Docker network with no public exposure. This middleware is the only publicly-reachable component; it restricts access to webhook paths only, adds `X-Forwarded-*` headers, and logs every request with timing.

**Key implementation details in `src/index.ts`:**
- `N8N_BASE_URL` env var is validated at startup — process exits if missing
- Proxy uses native `fetch()` with `duplex: 'half'` for streaming request bodies
- The proxy handler strips hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`) from proxied responses
- `PORT` defaults to `3000`; `N8N_MIDDLEWARE_HOST` is used by Traefik for routing rules

**Deployment** is via Docker Compose with a Traefik reverse proxy; see `docker-compose.yml` and `.env.example` for the full configuration surface. The Dockerfile is multi-stage: a `builder` image compiles TypeScript, then a minimal runtime image copies only `dist/` and `node_modules`.
