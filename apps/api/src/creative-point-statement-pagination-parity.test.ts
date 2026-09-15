import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { creativePointsForTests, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

type Envelope = {
  request_id?: string
  trace_id?: string
  data: { result?: unknown } | unknown | null
  error: { code: string; details?: Record<string, unknown> } | null
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

function headers(token: string, workspaceId: string) {
  return { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' }
}

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'creative-point-statement-pagination-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('creative point statement HTTP/MCP pagination parity', () => {
  it('uses the same tenant-scoped keyset cursor on HTTP and MCP and preserves evidence', async () => {
    const workspaceId = `ws_points_statement_cursor_${Date.now()}`
    const actorId = `points-statement-cursor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `points-statement-store-${workspaceId}`, credentialRef: `vault://points-statement/${workspaceId}` })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } }))
    await creativePointsForTests.grant({ workspaceId, points: 100, sourceType: 'manual_adjustment', sourceId: `${workspaceId}_a`, idempotencyKey: `${workspaceId}_grant_a`, at: '2026-09-02T00:00:00.000Z' })
    await creativePointsForTests.grant({ workspaceId, points: 200, sourceType: 'manual_adjustment', sourceId: `${workspaceId}_b`, idempotencyKey: `${workspaceId}_grant_b`, at: '2026-09-02T00:01:00.000Z' })
    const base = await start()
    const common = headers('allow', workspaceId)

    const firstHttpResponse = await fetch(`${base}/v1/creative-points/statement?limit=1`, { headers: common })
    const firstHttp = await firstHttpResponse.json() as Envelope
    expect(firstHttpResponse.status, JSON.stringify(firstHttp)).toBe(200)
    const firstHttpResult = resultOf(firstHttp) as { entries: Array<{ id: string }>; next_cursor: string | null }
    expect(firstHttpResult.entries).toHaveLength(1)
    expect(firstHttpResult.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/u)

    const cursor = firstHttpResult.next_cursor!
    const [httpResponse, mcpResponse] = await Promise.all([
      fetch(`${base}/v1/creative-points/statement?limit=1&cursor=${encodeURIComponent(cursor)}`, { headers: common }),
      fetch(`${base}/mcp`, { method: 'POST', headers: { ...common, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'statement-cursor', method: 'creative-points.statement.list', params: { limit: '1', cursor } }) }),
    ])
    const http = await httpResponse.json() as Envelope
    const mcp = await mcpResponse.json() as Envelope
    expect(httpResponse.status, JSON.stringify(http)).toBe(200)
    expect(mcpResponse.status, JSON.stringify(mcp)).toBe(200)
    expect(http.error).toBeNull()
    expect(mcp.error).toBeNull()
    expect(resultOf(http)).toEqual(resultOf(mcp))
    expect(http.request_id).toMatch(/^req_/)
    expect(http.trace_id).toBe(http.request_id)
    expect(mcp.request_id).toMatch(/^req_/)
    expect(mcp.trace_id).toBe(mcp.request_id)
    expect((resultOf(http) as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('rejects malformed HTTP cursors before repository access', async () => {
    const workspaceId = `ws_points_statement_bad_cursor_${Date.now()}`
    const actorId = `points-statement-bad-cursor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `points-statement-bad-store-${workspaceId}`, credentialRef: `vault://points-statement-bad/${workspaceId}` })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } }))
    const base = await start()
    const response = await fetch(`${base}/v1/creative-points/statement?cursor=${encodeURIComponent(Buffer.from('{"createdAt":"not-a-date","id":"x"}').toString('base64url'))}`, { headers: headers('allow', workspaceId) })
    const body = await response.json() as Envelope
    expect(response.status).toBe(400)
    expect(body.error?.code).toBe('INVALID_REQUEST')
    expect(body.request_id).toMatch(/^req_/)
    expect(body.trace_id).toBe(body.request_id)
  })

  // Real loopback HTTP/MCP authorization over synthetic in-memory ledger records, not real payments.
  it.each(['operator', 'finance', 'merchant_admin'] as const)('enforces workspace statement authorization for %s on both surfaces', async role => {
    const workspaceId = `ws_statement_authz_${role}_${Date.now()}`
    const actorId = `statement-reader-${role}-${Date.now()}`
    const privateSourceId = `other-member-private-evidence-${workspaceId}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role, status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `statement-authz-store-${workspaceId}`, credentialRef: `vault://statement-authz/${workspaceId}` })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: [role], workbenches: ['workspace'] } }))
    await creativePointsForTests.grant({ workspaceId, points: 100, sourceType: 'synthetic_authorization_test', sourceId: privateSourceId, idempotencyKey: `${workspaceId}_grant`, metadata: { actor_id: 'another-member', synthetic: true }, at: '2026-09-02T00:00:00.000Z' })
    const base = await start()
    const common = headers('allow', workspaceId)
    const responses = await Promise.all([
      fetch(`${base}/v1/creative-points/statement`, { headers: common }),
      fetch(`${base}/mcp`, { method: 'POST', headers: { ...common, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `statement-authz-${role}`, method: 'creative-points.statement.list', params: {} }) }),
    ])
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<Envelope>))
    for (const [index, response] of responses.entries()) {
      const body = bodies[index]!
      expect(response.status, JSON.stringify(body)).toBe(role === 'operator' ? 403 : 200)
      expect(body.request_id).toMatch(/^req_/)
      expect(body.trace_id).toBe(body.request_id)
      if (role === 'operator') {
        expect(body.error?.code).toBe('FORBIDDEN')
        expect(body.data).toBeNull()
        expect(JSON.stringify(body)).not.toContain(privateSourceId)
        expect(JSON.stringify(body)).not.toContain('another-member')
      } else {
        expect(body.error).toBeNull()
        expect((resultOf(body) as { entries: unknown[] }).entries).toHaveLength(1)
        expect(JSON.stringify(resultOf(body))).toContain(privateSourceId)
      }
    }
    if (role !== 'operator') expect(resultOf(bodies[0]!)).toEqual(resultOf(bodies[1]!))
  })

  it('rejects cross-workspace statement reads on HTTP and MCP even for finance', async () => {
    const workspaceId = `ws_statement_scope_${Date.now()}`
    const otherWorkspaceId = `${workspaceId}_other`
    const actorId = `statement-finance-scope-${Date.now()}`
    const privateSourceId = `private-other-workspace-${otherWorkspaceId}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'finance', status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId: otherWorkspaceId, platform: 'taobao', remoteAccountId: `statement-other-store-${otherWorkspaceId}`, credentialRef: `vault://statement-other/${otherWorkspaceId}` })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['finance'], workbenches: ['workspace'] } }))
    await creativePointsForTests.grant({ workspaceId: otherWorkspaceId, points: 100, sourceType: 'synthetic_authorization_test', sourceId: privateSourceId, idempotencyKey: `${otherWorkspaceId}_grant`, at: '2026-09-02T00:00:00.000Z' })
    const base = await start()
    const common = headers('allow', otherWorkspaceId)
    const responses = await Promise.all([
      fetch(`${base}/v1/creative-points/statement`, { headers: common }),
      fetch(`${base}/mcp`, { method: 'POST', headers: { ...common, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'statement-cross-workspace', method: 'creative-points.statement.list', params: { workspace_id: otherWorkspaceId } }) }),
    ])
    for (const response of responses) {
      const body = await response.json() as Envelope
      expect(response.status, JSON.stringify(body)).toBe(403)
      expect(body.error?.code).toBe('FORBIDDEN')
      expect(body.data).toBeNull()
      expect(JSON.stringify(body)).not.toContain(privateSourceId)
      expect(body.request_id).toMatch(/^req_/)
      expect(body.trace_id).toBe(body.request_id)
    }
  })
})
