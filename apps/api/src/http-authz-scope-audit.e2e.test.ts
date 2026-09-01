import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server, workspaceMembers } from './server.js'

type Envelope = {
  data: unknown | null
  error: { code: string; details?: Record<string, unknown> } | null
  request_id?: string
  trace_id?: string
}

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

describe('HTTP authorization scope conflict audit', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'http-scope-audit-test-secret')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('records shared decision evidence when path and query resource identities conflict', async () => {
    const workspaceId = `ws_http_scope_audit_${Date.now()}`
    const actorId = `http-scope-audit-actor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'http-scope-audit-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'http-scope-audit-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()

    const response = await fetch(`${base}/v1/products/path_product_${workspaceId}?product_id=query_product_${workspaceId}`, {
      headers: { authorization: 'Bearer http-scope-audit-token', 'x-workspace-id': workspaceId },
    })
    const body = await response.json() as Envelope

    expect(response.status).toBe(403)
    expect(body.data).toBeNull()
    expect(body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', decision_id: expect.any(String), policy_version: expect.any(String) },
    })
    expect(body.request_id).toMatch(/^req_/)
    expect(body.trace_id).toBe(body.request_id)

    const records = await operationAudits.list(workspaceId, 50)
    const decision = records.find(record => record.action === 'authz.decision' && record.resourceId === 'catalog.search')
    expect(decision?.after).toMatchObject({
      decision_id: body.error?.details?.decision_id,
      request_id: body.request_id,
      trace_id: body.trace_id,
      policy_version: body.error?.details?.policy_version,
      result: 'deny',
      reason_code: 'AUTHZ_SCOPE_MISMATCH',
    })
    expect(JSON.stringify(decision?.after)).not.toContain(`query_product_${workspaceId}`)
  })
})
