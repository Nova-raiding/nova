import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise(resolve => server.close(resolve))
}

async function ready(base, child) {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('health-only gateway exited before readiness')
    try { if ((await fetch(`${base}/healthz`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('health-only gateway did not become ready')
}

test('health-only mode starts without payment credentials and rejects every payment, callback and provider path', async () => {
  const receiptDirectory = mkdtempSync(join(tmpdir(), 'gateway-health-only-'))
  let providerCalls = 0
  let apiCalls = 0
  const provider = createServer((_req, res) => { providerCalls++; res.writeHead(500).end() })
  const api = createServer((_req, res) => { apiCalls++; res.writeHead(500).end() })
  const portHolder = createServer()
  let child
  try {
    const providerPort = await listen(provider)
    const apiPort = await listen(api)
    const gatewayPort = await listen(portHolder)
    await close(portHolder)
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('ALIPAY_') || key.startsWith('PAYMENT_')) delete environment[key]
    }
    Object.assign(environment, {
      PAYMENT_GATEWAY_HEALTH_ONLY: 'true', PORT: String(gatewayPort),
      ALIPAY_GATEWAY_URL: `http://127.0.0.1:${providerPort}/gateway.do`,
      PAYMENT_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      PAYMENT_PROTECTED_RECEIPT_DIR: receiptDirectory,
    })
    child = spawn(process.execPath, ['services/payment-gateway/index.mjs'], {
      cwd: process.cwd(), env: environment, stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${gatewayPort}`
    await ready(base, child)
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      ok: true, mode: 'health_only', supported_channels: [], channel_readiness: { alipay: { ready: false } },
    })
    for (const [method, path] of [
      ['POST', '/v1/checkout'], ['POST', '/v1/query'], ['POST', '/v1/refund'],
      ['POST', '/v1/refund/query'], ['POST', '/v1/notify/alipay'],
      ['GET', '/v1/checkout'], ['GET', '/unknown'], ['POST', '/healthz'],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ channel: 'alipay', order_id: 'would-not-be-used', amount_fen: 100 }) } : {}),
      })
      assert.equal(response.status, 503, `${method} ${path}`)
      assert.deepEqual(await response.json(), { error: 'PAYMENT_GATEWAY_HEALTH_ONLY' })
    }
    assert.equal(providerCalls, 0)
    assert.equal(apiCalls, 0)
    assert.deepEqual(readdirSync(receiptDirectory), [])
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    for (const server of [provider, api, portHolder]) if (server.listening) await close(server)
    rmSync(receiptDirectory, { recursive: true, force: true })
  }
})

test('an invalid health-only flag fails closed before listening', async () => {
  const portHolder = createServer()
  const port = await listen(portHolder)
  await close(portHolder)
  const environment = { ...process.env, PAYMENT_GATEWAY_HEALTH_ONLY: 'yes', PORT: String(port) }
  const child = spawn(process.execPath, ['services/payment-gateway/index.mjs'], {
    cwd: process.cwd(), env: environment, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise(resolve => child.once('exit', resolve))
  assert.notEqual(code, 0)
  assert.match(stderr, /PAYMENT_GATEWAY_HEALTH_ONLY must be true or false/u)
})
