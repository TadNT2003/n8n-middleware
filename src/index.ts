import { createHmac, timingSafeEqual } from 'node:crypto'
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
const EXPOSE_ALL = process.env.N8N_EXPOSE_ALL?.toLowerCase() === 'true'

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

if (EXPOSE_ALL) {
  app.all('*', proxyToN8N)
}

app.notFound((c) => c.text('Not Found', 404))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`n8n webhook middleware listening on :${info.port}`)
  console.log(`Proxying POST /webhook/* and /webhook-test/* → ${N8N_BASE_URL}`)
  if (EXPOSE_ALL) {
    console.log('WARNING: N8N_EXPOSE_ALL=true — all paths are proxied to n8n (full UI/API exposed)')
  }
})
