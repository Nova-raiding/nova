import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { AlertReceiverError, MAX_ALERT_BODY_BYTES, receiveSignedAlert } from './receiver.js'
import { PostgresAlertReceiptStore } from './postgres-store.js'

const secretValue = (name: string) => {
  const direct = process.env[name]?.trim()
  const file = process.env[`${name}_FILE`]?.trim()
  if (direct && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`)
  if (file) return readFileSync(file, 'utf8').trim()
  return direct
}
const databaseUrl = secretValue('ALERT_RECEIVER_DATABASE_URL')
const secret = secretValue('ALERT_RECEIVER_HMAC_SECRET')
if (!databaseUrl || !secret) throw new Error('alert receiver database URL and HMAC secret are required through direct or _FILE configuration')
const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.ALERT_RECEIVER_DB_POOL_MAX ?? 5) })
const store = new PostgresAlertReceiptStore(pool)
const server = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0]
  try {
    if (req.method === 'GET' && path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); return }
    if (req.method === 'GET' && path === '/readyz') { await store.health(); res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}'); return }
    if (req.method !== 'POST' || path !== '/internal/v1/alerts') { res.writeHead(404).end(); return }
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > MAX_ALERT_BODY_BYTES) throw new AlertReceiverError('ALERT_BODY_INVALID', 413, 'alert body is too large'); chunks.push(bytes) }
    const result = await receiveSignedAlert({ headers: req.headers, rawBody: Buffer.concat(chunks), secret, store })
    res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result))
  } catch (error) {
    const known = error instanceof AlertReceiverError
    const status = known ? error.status : 503
    const code = known ? error.code : 'ALERT_RECEIVER_UNAVAILABLE'
    console.error(JSON.stringify({ event: 'alert_receiver.rejected', code, status, request_id: req.headers['x-request-id'] ?? null }))
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: { code, message: known ? error.message : 'alert receiver unavailable' } }))
  }
})
server.listen(Number(process.env.ALERT_RECEIVER_PORT ?? 8791), process.env.ALERT_RECEIVER_BIND_HOST ?? '127.0.0.1')
server.once('close', () => void pool.end())
for (const signal of ['SIGTERM', 'SIGINT'] as const) server.once(signal, () => server.close())
