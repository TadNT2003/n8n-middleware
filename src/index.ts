import { createHmac, timingSafeEqual } from 'node:crypto'
import * as net from 'node:net'
import type * as http from 'node:http'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'

const n8nBaseUrl = process.env.N8N_BASE_URL?.replace(/\/$/, '')
if (!n8nBaseUrl) {
  console.error('FATAL: N8N_BASE_URL environment variable is not set')
  process.exit(1)
}

const N8N_BASE_URL: string = n8nBaseUrl
const PORT = Number(process.env.PORT ?? 3000)
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET
const EXPOSE_UI  = process.env.N8N_EXPOSE_UI?.toLowerCase()  === 'true'
const EXPOSE_API = process.env.N8N_EXPOSE_API?.toLowerCase() === 'true'

type Variables = { rawBody: ArrayBuffer }

const app = new Hono<{ Variables: Variables }>()

app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - start}ms)`)
})

app.get('/health', (c) => c.json({ status: 'ok' }))

async function verifyGithubSignature(c: Context<{ Variables: Variables }>, next: Next): Promise<Response | void> {
  if (!GITHUB_WEBHOOK_SECRET) {
    return next()
  }

  const signature = c.req.header('x-hub-signature-256')
  if (!signature) {
    return c.text('Missing X-Hub-Signature-256 header', 401)
  }

  const body = await c.req.arrayBuffer()
  const expected = 'sha256=' + createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(Buffer.from(body))
    .digest('hex')

  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)

  // timingSafeEqual requires equal-length buffers; length mismatch itself signals a bad signature
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return c.text('Invalid signature', 401)
  }

  c.set('rawBody', body)
  return next()
}

async function proxyToN8N(c: Context<{ Variables: Variables }>): Promise<Response> {
  const url = new URL(c.req.url)
  const targetUrl = `${N8N_BASE_URL}${url.pathname}${url.search}`

  const headers = new Headers(c.req.raw.headers)
  headers.set('x-forwarded-for', c.req.header('x-forwarded-for') ?? '')
  headers.set('x-forwarded-host', c.req.header('host') ?? '')
  headers.set('x-forwarded-proto', 'https')

  // Use buffered body from signature verification when available (body stream already consumed)
  const rawBody = c.get('rawBody')
  const body = rawBody !== undefined ? rawBody : c.req.raw.body

  const upstream = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body,
    // @ts-ignore — duplex required for streaming request bodies in Node.js fetch
    duplex: 'half',
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
}

app.post('/webhook/*', verifyGithubSignature, proxyToN8N)
app.post('/webhook-test/*', verifyGithubSignature, proxyToN8N)

if (EXPOSE_UI) {
  // Proxy all non-API paths: SPA, static assets, and /rest/* (n8n's internal API used by the UI)
  app.all('*', (c, next) => {
    if (c.req.path.startsWith('/api/')) return next()
    return proxyToN8N(c)
  })
}

if (EXPOSE_API) {
  app.all('/api/*', proxyToN8N)
}

app.notFound((c) => c.text('Not Found', 404))

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`n8n webhook middleware listening on :${info.port}`)
  console.log(`Proxying POST /webhook/* and /webhook-test/* → ${N8N_BASE_URL}`)
  if (EXPOSE_UI)  console.log('WARNING: N8N_EXPOSE_UI=true  — n8n web interface is publicly accessible')
  if (EXPOSE_API) console.log('WARNING: N8N_EXPOSE_API=true — n8n REST API (/api/*) is publicly accessible')
})

// WebSocket proxy: tunnel upgrade requests directly to n8n over raw TCP.
// fetch() is HTTP-only, so upgrade requests must be handled at the server level.
if (EXPOSE_UI || EXPOSE_API) {
  const n8nUrl = new URL(N8N_BASE_URL)
  const targetHost = n8nUrl.hostname
  const targetPort = parseInt(n8nUrl.port) || (n8nUrl.protocol === 'https:' ? 443 : 80)

  ;(server as unknown as http.Server).on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const reqPath = req.url ?? '/'
    const isApiPath = reqPath.startsWith('/api/')
    const allowed = (EXPOSE_UI && !isApiPath) || (EXPOSE_API && isApiPath)

    if (!allowed) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const proxySocket = net.connect(targetPort, targetHost, () => {
      const forwardedHeaders: Record<string, string | string[]> = { ...req.headers as Record<string, string | string[]> }
      forwardedHeaders['x-forwarded-for'] = req.headers['x-forwarded-for'] ?? ''
      forwardedHeaders['x-forwarded-host'] = req.headers['host'] ?? ''
      forwardedHeaders['x-forwarded-proto'] = 'https'

      let raw = `${req.method} ${reqPath} HTTP/1.1\r\n`
      for (const [key, value] of Object.entries(forwardedHeaders)) {
        if (Array.isArray(value)) {
          for (const v of value) raw += `${key}: ${v}\r\n`
        } else if (value !== undefined) {
          raw += `${key}: ${value}\r\n`
        }
      }
      raw += '\r\n'

      proxySocket.write(raw)
      if (head.length > 0) proxySocket.write(head)

      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
    })

    proxySocket.on('error', (err) => {
      console.error(`WebSocket proxy error ${reqPath}:`, err.message)
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.destroy()
      }
    })
    socket.on('error', () => proxySocket.destroy())
  })
}
