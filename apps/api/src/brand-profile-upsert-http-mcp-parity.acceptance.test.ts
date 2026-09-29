import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, operationAudits, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

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
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function headers(token: string, workspaceId: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ops-workbench': 'workspace', 'x-workspace-id': workspaceId }
}

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/brand-profile`, {
    method: 'PUT',
    headers: headers(token, workspaceId),
    body: JSON.stringify({ name: 'Parity Brand', positioning: '可审计写入', audience: '务实商家', tone: ['清晰', '克制'], forbidden_terms: ['虚假承诺'], source: 'http-parity-test' }),
  })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(token, workspaceId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'brand.upsert',
      params: {
        name: 'Parity Brand',
        positioning: '可审计写入',
        audience: '务实商家',
        tone_json: JSON.stringify(['清晰', '克制']),
        forbidden_terms_json: JSON.stringify(['虚假承诺']),
        source: 'mcp-parity-test',
      },
    }),
  })
  return { response, body: await response.json() as Envelope }
}

async function callMcpMethod(base: string, token: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(token, workspaceId),
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  return { response, body: await response.json() as Envelope }
}

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

function comparableProfile(body: Envelope) {
  const profile = resultOf(body) as Record<string, unknown>
  return { name: profile.name, positioning: profile.positioning, audience: profile.audience, tone: profile.tone, forbiddenTerms: profile.forbiddenTerms }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'brand-profile-upsert-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('brand profile upsert HTTP/MCP parity', () => {
  it('versions MCP brand facts, records conflicting candidate provenance, and denies a foreign workspace', async () => {
    const workspaceId = `ws_brand_upsert_version_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const actorId = `brand-upsert-version-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'brand-upsert-acceptance' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-upsert-version-store-${workspaceId}`, credentialRef: `vault://brand-upsert/${workspaceId}` })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-upsert-version-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const first = await callMcpMethod(base, 'brand-upsert-version-token', workspaceId, 'brand.upsert', {
      name: '来源验收品牌', positioning: '原始定位', source: 'qa://brand/manual-v1',
    })
    expect(first.response.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.error).toBeNull()
    expect(resultOf(first.body)).toMatchObject({ workspaceId, name: '来源验收品牌', positioning: '原始定位', revision: 1 })

    const candidate = await callMcpMethod(base, 'brand-upsert-version-token', workspaceId, 'brand.upsert', {
      name: '来源验收品牌', positioning: '候选定位', source: 'qa://brand/candidate-v2',
    })
    expect(candidate.response.status, JSON.stringify(candidate.body)).toBe(200)
    expect(candidate.body.error).toBeNull()
    expect(resultOf(candidate.body)).toMatchObject({
      positioning: '原始定位', revision: 2,
      conflicts: [expect.objectContaining({ field: 'positioning', candidateValue: '候选定位', source: 'qa://brand/candidate-v2', state: 'pending' })],
    })

    const resolved = await callMcpMethod(base, 'brand-upsert-version-token', workspaceId, 'brand.upsert', {
      name: '来源验收品牌', positioning: '候选定位', source: 'qa://brand/confirmed-v3',
      conflict_resolutions_json: JSON.stringify({ positioning: 'candidate' }),
    })
    expect(resolved.response.status, JSON.stringify(resolved.body)).toBe(200)
    expect(resolved.body.error).toBeNull()
    expect(resultOf(resolved.body)).toMatchObject({ positioning: '候选定位', revision: 3 })
    expect(resultOf(resolved.body)).not.toHaveProperty('conflicts')
    const readBack = await callMcpMethod(base, 'brand-upsert-version-token', workspaceId, 'brand.get', {})
    expect(readBack.body.error).toBeNull()
    expect(resultOf(readBack.body)).toMatchObject({ workspaceId, positioning: '候选定位', revision: 3 })

    const foreign = await callMcpMethod(base, 'brand-upsert-version-token', foreignWorkspaceId, 'brand.upsert', {
      name: '不应写入的外租户品牌', source: 'qa://brand/foreign',
    })
    expect(foreign.response.status).toBe(403)
    expect(foreign.body.error?.code).toBe('FORBIDDEN')
    expect(service.getBrandProfile(foreignWorkspaceId)).toBeUndefined()
    expect(service.getBrandProfile(workspaceId)).toMatchObject({ name: '来源验收品牌', positioning: '候选定位', revision: 3 })
  })

  it('writes the same authenticated workspace facts through HTTP and MCP', async () => {
    const httpWorkspaceId = `ws_brand_upsert_http_${Date.now()}`
    const mcpWorkspaceId = `${httpWorkspaceId}_mcp`
    const httpActorId = `brand-upsert-http-${Date.now()}`
    const mcpActorId = `brand-upsert-mcp-${Date.now()}`
    for (const [workspaceId, actorId] of [[httpWorkspaceId, httpActorId], [mcpWorkspaceId, mcpActorId]] as const) {
      await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
      service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-upsert-store-${workspaceId}`, credentialRef: `vault://brand-upsert/${workspaceId}` })
      await grantCreativePointsForTests(workspaceId)
      grantContinuousFeatureEntitlementForTests(workspaceId)
    }
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-upsert-http-token': { workspaces: [httpWorkspaceId], actor_id: httpActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
      'brand-upsert-mcp-token': { workspaces: [mcpWorkspaceId], actor_id: mcpActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-upsert-http-token', httpWorkspaceId),
      callMcp(base, 'brand-upsert-mcp-token', mcpWorkspaceId),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(200)
      expect(result.body.error).toBeNull()
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }
    expect(comparableProfile(http.body)).toEqual(comparableProfile(mcp.body))
    expect(service.getBrandProfile(httpWorkspaceId)).toMatchObject({ name: 'Parity Brand', positioning: '可审计写入' })
    expect(service.getBrandProfile(mcpWorkspaceId)).toMatchObject({ name: 'Parity Brand', positioning: '可审计写入' })
  })

  it('denies an explicit write capability over both transports before mutating the workspace', async () => {
    const workspaceId = `ws_brand_upsert_deny_${Date.now()}`
    const actorId = `brand-upsert-deny-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-upsert-store-${workspaceId}`, credentialRef: `vault://brand-upsert/${workspaceId}` })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-upsert-deny-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], denied_capabilities: ['customer.content.update'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-upsert-deny-token', workspaceId),
      callMcp(base, 'brand-upsert-deny-token', workspaceId),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN', details: { capability: 'customer.content.update', policy_version: AUTHZ_POLICY_VERSION } })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    expect(service.getBrandProfile(workspaceId)).toBeUndefined()
    const audits = await operationAudits.list(workspaceId)
    expect(audits.filter(audit => audit.action === 'brand_profile.updated')).toHaveLength(0)
  })

  it('links an HTTP-saved profile to the same tenant brand-unit consumed by batch production', async () => {
    const workspaceId = `ws_brand_profile_batch_link_${Date.now()}`
    const actorId = `brand-profile-batch-link-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'batch-link-acceptance' })
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `batch-link-store-${workspaceId}`, credentialRef: `vault://batch-link/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '品牌档案关联商品', stock: 1 })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-profile-batch-link-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const saved = await callHttp(base, 'brand-profile-batch-link-token', workspaceId)
    expect(saved.response.status, JSON.stringify(saved.body)).toBe(200)
    const savedProfile = saved.body.data as Record<string, unknown>
    expect(savedProfile.brandUnitId).toBe(`brand_${workspaceId}`)
    expect((savedProfile.brandUnit as Record<string, unknown>).id).toBe(savedProfile.brandUnitId)

    const listed = await callMcpMethod(base, 'brand-profile-batch-link-token', workspaceId, 'brand-unit.list', { brand_id: savedProfile.brandUnitId })
    expect(listed.body.error).toBeNull()
    expect((listed.body.data as { result: { items: Array<{ id: string; workspaceId: string }> } }).result.items).toEqual([
      expect.objectContaining({ id: `brand_${workspaceId}`, workspaceId }),
    ])

    const bound = await callMcpMethod(base, 'brand-profile-batch-link-token', workspaceId, 'brand-unit.bind-store', { brand_id: savedProfile.brandUnitId, platform: 'taobao', account_id: account.id })
    expect(bound.body.error).toBeNull()
    const batch = await callMcpMethod(base, 'brand-profile-batch-link-token', workspaceId, 'campaign.batch.create', {
      brand_id: savedProfile.brandUnitId,
      platform: 'taobao',
      account_id: account.id,
      product_ids_json: JSON.stringify([product.id]),
    })
    expect(batch.body.error).toBeNull()
    expect((batch.body.data as { result: { brandId: string } }).result.brandId).toBe(savedProfile.brandUnitId)

    const foreignWorkspaceId = `${workspaceId}_foreign`
    await workspaceMembers.upsert({ workspaceId: foreignWorkspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'batch-link-acceptance' })
    const foreign = await callMcpMethod(base, 'brand-profile-batch-link-token', foreignWorkspaceId, 'brand-unit.list', { brand_id: savedProfile.brandUnitId })
    // The authorization layer must stop the request before resource lookup;
    // do not disclose whether the same deterministic id exists elsewhere.
    expect(foreign.body.error?.code).toBe('FORBIDDEN')
  })
})
