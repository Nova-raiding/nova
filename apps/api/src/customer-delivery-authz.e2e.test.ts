import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { server } from './server.js'

type Rpc<T = unknown> = { data: { result: T } | null; error: { code: string; details?: Record<string, unknown> } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function call<T>(base: string, token: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  })
  return { response, body: await response.json() as Rpc<T> }
}

describe('customer delivery platform authorization and API flow', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    process.env.MCP_AUTHZ_MODE = 'enforce'
    process.env.SESSION_ID_HASH_SECRET = 'customer-delivery-authz-test-secret'
    process.env.API_AUTH_TOKENS = JSON.stringify({
      'customer-delivery-platform-token': { actor_id: 'customer-delivery-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
      'customer-delivery-workspace-token': { actor_id: 'customer-delivery-merchant', roles: ['operator'], workbenches: ['workspace'], workspaces: ['ws_delivery_authz'] },
    })
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.API_AUTH_TOKENS
    delete process.env.MCP_AUTHZ_MODE
    delete process.env.SESSION_ID_HASH_SECRET
  })

  it('allows platform operator to list and create against an explicit target workspace', async () => {
    const base = await start()
    const target = `ws_delivery_authz_${Date.now()}`
    const listed = await call<{ items: unknown[] }>(base, 'customer-delivery-platform-token', 'ops.customer-delivery.list', { target_workspace_id: target })
    expect(listed.response.status).toBe(200)
    expect(listed.body.error).toBeNull()
    expect(Array.isArray(listed.body.data?.result.items)).toBe(true)

    const created = await call<{ id: string; companyName: string }>(base, 'customer-delivery-platform-token', 'ops.customer-delivery.create', { target_workspace_id: target, company_name: `Authz 客户 ${Date.now()}` })
    expect(created.response.status).toBe(200)
    expect(created.body.error).toBeNull()
    expect(created.body.data?.result.companyName).toContain('Authz 客户')
  })

  it('denies a workspace operator from invoking platform customer delivery methods', async () => {
    const base = await start()
    const denied = await call(base, 'customer-delivery-workspace-token', 'ops.customer-delivery.list', { target_workspace_id: 'ws_delivery_authz' })
    expect(denied.response.status).toBe(403)
    expect(denied.body.error?.code).toBe('FORBIDDEN')
  })

  it('rejects a missing or conflicting target workspace before dispatch', async () => {
    const base = await start()
    const missing = await call(base, 'customer-delivery-platform-token', 'ops.customer-delivery.list', {})
    expect(missing.response.status).toBe(400)
    expect(missing.body.error?.code).toBe('WORKSPACE_SCOPE_REQUIRED')
    const conflict = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer customer-delivery-platform-token', 'content-type': 'application/json', 'x-workspace-id': 'ws_other' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'conflict', method: 'ops.customer-delivery.list', params: { target_workspace_id: 'ws_delivery_authz' } }),
    })
    const body = await conflict.json() as Rpc
    expect(conflict.status).toBe(403)
    expect(['WORKSPACE_SCOPE_MISMATCH', 'FORBIDDEN']).toContain(body.error?.code)
  })
})
