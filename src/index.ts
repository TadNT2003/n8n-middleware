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

app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - start}ms)`)
})

app.get('/health', (c) => c.json({ status: 'ok' }))

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
    body: c.req.raw.body,
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
  console.log(`n8n webhook middleware listening on :${info.port}`)
  console.log(`Proxying POST /webhook/* and /webhook-test/* → ${N8N_BASE_URL}`)
})
