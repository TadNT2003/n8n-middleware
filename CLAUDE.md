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

A single-file HTTP proxy (`src/index.ts`) built on [Hono](https://hono.dev/) + `@hono/node-server`. By default it accepts only `POST /webhook/*` and `POST /webhook-test/*`, forwarding them verbatim to an internal n8n instance; all other paths return 404. When `N8N_EXPOSE_UI=true`, a catch-all route proxies all non-`/api/*` paths (SPA, static assets, `/rest/*`). When `N8N_EXPOSE_API=true`, `/api/*` paths are proxied. Both flags are independent and can be combined. There is a `/health` endpoint for container health checks.

**Request path:**

```text
Internet → Cloudflare Tunnel → Traefik → n8n-middleware (this service) → n8n (internal Docker network)
```

**Why it exists:** n8n runs on an internal Docker network with no public exposure. This middleware is the only publicly-reachable component; it restricts access to webhook paths only, adds `X-Forwarded-*` headers, and logs every request with timing.

**Key implementation details in `src/index.ts`:**

- `N8N_BASE_URL` env var is validated at startup — process exits if missing
- Proxy uses native `fetch()` with `duplex: 'half'` for streaming request bodies
- The proxy handler strips hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`) from proxied responses
- `PORT` defaults to `3000`; `N8N_MIDDLEWARE_HOST` is used by Traefik for routing rules
- WebSocket upgrades are handled via an `upgrade` event listener on the Node.js HTTP server; `fetch()` cannot handle these, so they are tunneled over a raw TCP connection (`node:net`) to n8n — only active when `EXPOSE_UI` or `EXPOSE_API` is true, with the same path-based access rules as HTTP

**Deployment** is via Docker Compose with a Traefik reverse proxy; see `docker-compose.yml` and `.env.example` for the full configuration surface. The Dockerfile is multi-stage: a `builder` image compiles TypeScript, then a minimal runtime image copies only `dist/` and `node_modules`.
