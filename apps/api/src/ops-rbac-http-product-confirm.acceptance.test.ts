import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'

type RpcBody = {
  request_id?: string
  trace_id?: string
  data: { result: unknown } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function confirm(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/products/http-confirm-product/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
    },
    body: JSON.stringify({}),
  })
  return { response, body: await response.json() as RpcBody }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-http-product-confirm-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC real HTTP product facts confirmation', () => {
  it('allows the registered route before business preconditions and denies an explicit capability deny', async () => {
    const workspaceId = `ws_ops_http_product_confirm_${Date.now()}`
    const allowedActorId = `ops-http-product-confirm-allowed-${Date.now()}`
    const deniedActorId = `ops-http-product-confirm-denied-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: allowedActorId, displayName: 'HTTP confirmation operator', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: 'HTTP confirmation denied operator', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'ops-http-product-confirm-allowed-token': { workspaces: [workspaceId], actor_id: allowedActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
      'ops-http-product-confirm-denied-token': { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['merchant_admin'], denied_capabilities: ['customer.content.update'], workbenches: ['workspace'] },
    }))
    const base = await start()

    const allowed = await confirm(base, 'ops-http-product-confirm-allowed-token', workspaceId)
    // Authorization runs before onboarding and product lookup. A fresh local
    // production workspace therefore reaches the deterministic business gate.
    expect(allowed.response.status).toBe(428)
    expect(allowed.body.data).toBeNull()
    expect(allowed.body.error).toMatchObject({ code: 'STORE_ONBOARDING_REQUIRED' })
    expect(allowed.body.request_id).toMatch(/^req_/)
    expect(allowed.body.trace_id).toBe(allowed.body.request_id)

    const denied = await confirm(base, 'ops-http-product-confirm-denied-token', workspaceId)
    expect(denied.response.status).toBe(403)
    expect(denied.body.data).toBeNull()
    expect(denied.body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: {
        reason_code: 'AUTHZ_EXPLICIT_DENY',
        decision_id: expect.any(String),
        policy_version: AUTHZ_POLICY_VERSION,
      },
    })
    expect(denied.body.error?.details).not.toHaveProperty('product_id')
    expect(denied.body.request_id).toMatch(/^req_/)
    expect(denied.body.trace_id).toBe(denied.body.request_id)
  })
})
