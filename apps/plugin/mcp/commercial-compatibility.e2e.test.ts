import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The actual API runs in a dedicated Vitest worker with explicit test memory
// persistence. It is not a mock HTTP server and does not touch production cash.
const workspace = 'ws-commercial-stdio-matrix'
const token = 'commercial-stdio-test-token'
vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('DEPLOY_ENV', 'test')
vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { actor_id: 'stdio-actor', workspaces: [workspace], workbenches: ['workspace'] } }))
const { server, workspaceMembers, persistenceReady } = await import('../../api/src/server.js')
let base = ''
let temporary = ''
let legacyBridge = ''

async function stdio(bridge: string, name: string, args: Record<string, unknown> = {}) {
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: 'test', MERCHANT_MCP_BASE_URL: base, MERCHANT_WORKSPACE_ID: workspace,
      MERCHANT_MCP_TOKEN: token, MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_ATTEMPTS: '0',
      MERCHANT_ARTIFACT_DIR: join(temporary, 'artifacts') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  try {
    const result = new Promise<Record<string, any>>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bridge response timeout')), 20000)
      lines.once('line', line => { clearTimeout(timeout); try { resolveResult(JSON.parse(line)) } catch (error) { reject(error) } })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Bridge exited ${code}`)) } })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    return await result
  } finally { lines.close(); child.kill() }
}

beforeAll(async () => {
  await persistenceReady
  await workspaceMembers.upsert({ workspaceId: workspace, externalSubject: 'stdio-actor', displayName: 'stdio-actor', role: 'workspace_owner', status: 'active', invitedBy: 'stdio-test' })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API did not bind')
  base = `http://127.0.0.1:${address.port}`
  temporary = await mkdtemp(join(tmpdir(), 'commercial-stdio-matrix-'))
  const legacy = join(temporary, 'legacy-plugin')
  await cp(resolve('apps/plugin'), legacy, { recursive: true })
  // Historical entry point is kept byte-for-byte. The sibling credential
  // helpers are the compatibility dependencies shipped in this candidate.
  await writeFile(join(legacy, 'mcp/bridge.mjs'), execFileSync('git', ['show', 'HEAD:apps/plugin/mcp/bridge.mjs']))
  for (const path of ['package.json', '.codex-plugin/plugin.json']) await writeFile(join(legacy, path), execFileSync('git', ['show', `HEAD:apps/plugin/${path}`]))
  await mkdir(join(temporary, 'artifacts'))
  legacyBridge = join(legacy, 'mcp/bridge.mjs')
}, 30000)
afterAll(async () => {
  if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  if (temporary) await rm(temporary, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('commercial real stdio compatibility against actual local API', () => {
  it('current source Bridge reads the server-owned public catalog over authenticated stdio', async () => {
    const reply = await stdio(resolve('apps/plugin/mcp/bridge.mjs'), 'commercial.catalog.get')
    expect(reply.result).toMatchObject({ isError: false, structuredContent: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } })
  }, 30000)
  if (process.env.MERCHANT_INSTALLED_PLUGIN_DIR) it('the actual installed local cache Bridge keeps safe reads against this API', async () => {
    const reply = await stdio(join(process.env.MERCHANT_INSTALLED_PLUGIN_DIR!, 'mcp/bridge.mjs'), 'commercial.catalog.get')
    expect(reply.result).toMatchObject({ isError: false, structuredContent: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } })
  }, 30000)
  it('supported historical Bridge keeps its existing safe catalog read', async () => {
    const reply = await stdio(legacyBridge, 'commercial.catalog.get')
    expect(reply.result).toMatchObject({ isError: false, structuredContent: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } })
  }, 30000)
  it('historical no-quote upgrade is rejected by the actual API rather than charged at full price', async () => {
    const reply = await stdio(legacyBridge, 'commercial.order.create', { purchase_kind: 'upgrade', sku_code: 'growth', idempotency_key: 'legacy-upgrade-001', reason: '升级套餐' })
    expect(reply.result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_REQUEST' } })
    const response = await fetch(`${base}/v1/commercial/orders`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspace, 'content-type': 'application/json' }, body: JSON.stringify({ purchase_kind: 'upgrade', sku_code: 'growth', idempotency_key: 'legacy-http-001', reason: '升级套餐' }) })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_REQUEST')
  }, 30000)
})
