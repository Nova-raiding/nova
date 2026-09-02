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
})
