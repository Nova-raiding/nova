import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'

async function runSmoke(mode: string, extra: Record<string, string> = {}) {
  const calls: string[] = []
  const platforms = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/') return res.end('<title>Merchant Studio</title><script src="/entry.js"></script>')
    if (req.url === '/entry.js') return res.end('/* owned smoke fixture */')
    const data = req.url === '/healthz' ? { writesEnabled: true, persistence: { ready: true } }
      : req.url === '/v1/platform-accounts' ? { items: platforms.map(platform => ({ platform, accountId: platform, state: 'ready', readEnabled: true })) }
      : req.url === '/v1/products' ? [{ id: 'owned-product', platform: 'jd', workspaceId: 'owned-workspace' }]
      : null
    if (req.method !== 'GET') {
      // A disposable API deliberately stops the workflow at its first write.
      // No credential, provider or billing service exists behind this server.
      res.statusCode = 409
      return res.end(JSON.stringify({ data: null, error: { message: 'owned fixture write reached' } }))
    }
    res.end(JSON.stringify({ data, error: null }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/merchant-studio-smoke.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', SMOKE_API_URL: origin, SMOKE_UI_URL: origin, SMOKE_WORKSPACE_ID: 'owned-workspace', SMOKE_API_TOKEN: 'fixture-only-token', SMOKE_MODE: mode, SMOKE_ALLOW_WRITES: 'true', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    const [code] = await once(child, 'close')
    return { code, output, calls }
  } finally {
    clearTimeout(timeout)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('merchant smoke runtime write boundary', () => {
  it('production observes accounts and products without writes even when write/full-flow flags are set', async () => {
    const result = await runSmoke('production', { SMOKE_REQUIRE_FULL_FLOW: 'true' })
    expect(result.code, result.output).toBe(0)
    expect(result.calls).toEqual(['GET /', 'GET /entry.js', 'GET /healthz', 'GET /v1/platform-accounts', 'GET /v1/products'])
    expect(JSON.parse(result.output)).toMatchObject({ status: 'PASS', productCount: 1, fullFlow: 'SKIPPED_READ_ONLY_PRODUCTION' })
  })
  it('rejects an unknown mode before contacting either runtime', async () => {
    const result = await runSmoke('prodution')
    expect(result.code).toBe(1)
    expect(result.calls).toEqual([])
    expect(result.output).toContain('SMOKE_MODE must be production or fixture')
  })
  it('retains explicitly selected disposable fixture workflow writes', async () => {
    const result = await runSmoke('fixture')
    expect(result.code).toBe(1)
    expect(result.calls).toContain('POST /mcp')
    expect(result.output).toContain('owned fixture write reached')
  })
})
