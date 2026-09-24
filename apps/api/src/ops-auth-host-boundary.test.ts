import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { productionReadinessDiagnostics, route } from './server.js'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
})

async function listen() {
  const server = createServer((req, res) => {
    void route(req, res).catch(error => {
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: typeof error === 'object' && error && 'code' in error ? error.code : 'INTERNAL_ERROR' } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('password-only Ops host boundary', () => {
  it('fails production identity readiness closed when the Ops origin is absent or unsafe', () => {
    const base = { NODE_ENV: 'production', OPS_AUTH_MODE: 'password', SESSION_ID_HASH_SECRET: 'secret', OPS_DATABASE_URL: 'postgres://ops/db', MERCHANT_BEARER_HOSTNAME: 'merchant.example.test', MCP_INTEGRATION_MODE: 'local_stdio', PUBLIC_APP_BASE_URL: 'https://merchant.example.test' }
    expect(productionReadinessDiagnostics(base).gates.identity?.reasons).toContain('public_ops_base_url_invalid')
    expect(productionReadinessDiagnostics({ ...base, PUBLIC_OPS_BASE_URL: 'https://user:pass@ops.example.test' }).gates.identity?.reasons).toContain('public_ops_base_url_invalid')
    expect(productionReadinessDiagnostics({ ...base, PUBLIC_OPS_BASE_URL: 'https://ops.example.test/path' }).gates.identity?.reasons).toContain('public_ops_base_url_invalid')
    expect(productionReadinessDiagnostics({ ...base, PUBLIC_OPS_BASE_URL: 'https://ops.example.test' }).gates.identity?.reasons).not.toContain('public_ops_base_url_invalid')
  })

  it('rejects bearer credentials on the configured Ops host using the trusted forwarded host', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VITEST', 'true')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('OPS_AUTH_MODE', 'password')
    vi.stubEnv('PUBLIC_OPS_BASE_URL', 'https://ops.example.test')
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', 'merchant.example.test')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'test-token': { actor_id: 'actor', workspaces: ['ws_test'], roles: ['workspace_owner'] } }))
    const base = await listen()

    const ops = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer test-token', host: 'api.internal.test', 'x-forwarded-host': 'ops.example.test', 'x-forwarded-proto': 'https' } })
    expect(ops.status).toBe(401)
    expect((await ops.json() as { error?: { code?: string } }).error?.code).toBe('UNAUTHENTICATED')
  })
})
