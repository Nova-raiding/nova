import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, operationAudits, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'

type Envelope = {
  request_id?: string
  trace_id?: string
  workspace_id?: string
  data: { result?: unknown } | unknown | null
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

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

async function callHttp(base: string, token: string, workspaceId: string, assetId: string) {
  const response = await fetch(`${base}/v1/brand-profile/extract`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ops-workbench': 'workspace',
      'x-workspace-id': workspaceId,
    },
    body: JSON.stringify({ asset_ids: [assetId] }),
  })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string, assetId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ops-workbench': 'workspace',
      'x-workspace-id': workspaceId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'brand.extract',
      params: { asset_ids_json: JSON.stringify([assetId]) },
    }),
  })
  return { response, body: await response.json() as Envelope }
}

function configureToken(token: string, workspaceId: string, actorId: string, extra: Record<string, unknown> = {}) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'], ...extra },
  }))
}

beforeEach(() => {
  // Keep strict production authorization semantics while the module-level
  // test bootstrap continues to use its in-memory persistence.
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'brand-extract-http-mcp-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('brand extraction HTTP/MCP parity', () => {
  it('returns the same local readiness blocker over both transports', async () => {
    const workspaceId = `ws_brand_extract_parity_${Date.now()}`
    const actorId = `brand-extract-parity-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const asset = service.registerAsset({ workspaceId, name: '品牌资料.json', mimeType: 'application/json', sizeBytes: 128, sha256: 'c'.repeat(64), storageKey: `quarantine/${workspaceId}/brand.json` })
    service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', source: 'parser', facts: { 品牌名称: '云朵轻户外', 品牌定位: '城市轻户外', 品牌调性: ['克制'], 品牌色: ['松石绿'] } })
    configureToken('brand-extract-allow-token', workspaceId, actorId)
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-extract-allow-token', workspaceId, asset.id),
      callMcp(base, 'brand-extract-allow-token', workspaceId, asset.id),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(503)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(503)
    expect(http.body.data).toBeNull()
    expect(mcp.body.data).toBeNull()
    expect(http.body.error).toMatchObject({ code: 'COMMERCIAL_OPERATION_DISABLED' })
    expect(mcp.body.error).toMatchObject({ code: 'COMMERCIAL_OPERATION_DISABLED' })
    expect(http.body.error?.details?.next_actions).toEqual(['commercial.access.get', 'creative-points.balance.get'])
    expect(mcp.body.error?.details?.next_actions).toEqual(['commercial.access.get', 'creative-points.balance.get'])
    for (const body of [http.body, mcp.body]) {
      expect(body.request_id).toMatch(/^req_/)
      expect(body.trace_id).toBe(body.request_id)
      expect(body.workspace_id).toBe(workspaceId)
    }
    expect(service.getBrandProfile(workspaceId)).toBeUndefined()
  })

  it('denies the same explicit capability over both transports without exposing asset evidence', async () => {
    const workspaceId = `ws_brand_extract_deny_${Date.now()}`
    const actorId = `brand-extract-deny-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const asset = service.registerAsset({ workspaceId, name: '私有品牌资料.json', mimeType: 'application/json', sizeBytes: 128, sha256: 'd'.repeat(64), storageKey: `quarantine/${workspaceId}/private.json` })
    service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', source: 'parser', facts: { 品牌名称: '不可泄露' } })
    configureToken('brand-extract-deny-token', workspaceId, actorId, { denied_capabilities: ['customer.content.update'] })
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-extract-deny-token', workspaceId, asset.id),
      callMcp(base, 'brand-extract-deny-token', workspaceId, asset.id),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: {
          capability: 'customer.content.update',
          reason_code: 'AUTHZ_EXPLICIT_DENY',
          decision_id: expect.any(String),
          policy_version: AUTHZ_POLICY_VERSION,
          workbench: 'workspace',
        },
      })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(JSON.stringify(result.body)).not.toContain(asset.id)
      expect(JSON.stringify(result.body)).not.toContain('不可泄露')
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    const audits = await operationAudits.list(workspaceId)
    const denialAudits = audits.filter(audit => audit.action === 'authz.decision' && audit.actorId === actorId)
    expect(denialAudits).toHaveLength(2)
    for (const audit of denialAudits) {
      expect(audit.after).toMatchObject({
        capability: 'customer.content.update',
        result: 'deny',
        reason_code: 'AUTHZ_EXPLICIT_DENY',
        policy_version: AUTHZ_POLICY_VERSION,
        decision_id: expect.any(String),
        request_id: expect.stringMatching(/^req_/),
        trace_id: expect.stringMatching(/^req_/),
      })
    }
  })

  it('fails closed for a foreign authenticated workspace on both transports', async () => {
    const workspaceId = `ws_brand_extract_scope_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const actorId = `brand-extract-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    const asset = service.registerAsset({ workspaceId, name: '品牌资料.json', mimeType: 'application/json', sizeBytes: 128, sha256: 'e'.repeat(64), storageKey: `quarantine/${workspaceId}/scope.json` })
    configureToken('brand-extract-scope-token', workspaceId, actorId)
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-extract-scope-token', foreignWorkspaceId, asset.id),
      callMcp(base, 'brand-extract-scope-token', foreignWorkspaceId, asset.id),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error?.code).toBe('FORBIDDEN')
      expect(result.body.workspace_id).toBe(foreignWorkspaceId)
      expect(JSON.stringify(result.body)).not.toContain(actorId)
      expect(JSON.stringify(result.body)).not.toContain(asset.id)
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
  })
})
