import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { MemoryBrandUnitRepository } from '../../../packages/persistence/src/brand-unit-repository.js'
import { MemoryAssetParseRepository } from '../../../packages/persistence/src/asset-parse-repository.js'
import type { ProviderBeforeRequest } from '../../../packages/ai/src/provider-request.js'
import type { ImageFactsExtractor } from '../../../packages/ai/src/image-facts.js'

const transport = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  waiting: Promise.resolve() as Promise<void>,
  provider: vi.fn(async () => ({ format: 'image_ocr', title: 'Controlled image facts' })),
  denied: vi.fn<(error: unknown) => void>(),
}))

vi.mock('../../../packages/ai/src/image-facts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/ai/src/image-facts.js')>(),
  createImageFactsExtractorFromEnv: (_env: unknown, _usage: unknown, beforeRequest?: ProviderBeforeRequest): ImageFactsExtractor => ({
    extract: async input => {
      transport.entered?.()
      await transport.waiting
      if (!beforeRequest) throw new Error('Actual OCR beforeRequest hook was not wired')
      try { await beforeRequest({ operation: 'ocr', workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId }) }
      catch (error) {
        transport.denied(error)
        if (error && typeof error === 'object') Object.assign(error, { ocrPreDispatch: true })
        throw error
      }
      return transport.provider()
    },
  }),
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type Envelope = { data: { id?: string; scanStatus?: string; result?: { parseStatus: string; extractedFacts?: Record<string, unknown> } } | null; error: { code: string; message?: string } | null }
let api: typeof import('./server.js')
let base = ''
const approvedOcrRate = { rateCardId: 'resource-recheck-ocr-approved', version: 1, actionCode: 'ocr.extract' as const,
  unit: 'request' as const, pricingMode: 'variable' as const, variableFormula: { kind: 'cost_cny_x2_ceil_min1' as const },
  checksum: 'c'.repeat(64), effectiveAt: '2026-09-25T00:00:00.000Z' }

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST']) if (process.env[key]) throw new Error(`Use safe-tests: inherited ${key} is forbidden`)
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'resource-recheck-controlled-session-secret')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
  vi.stubEnv('MODEL_DAILY_CNY_LIMIT', '20')
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '2')
  vi.stubEnv('MODEL_COST_ESTIMATE_VERSION', 'resource-recheck-test-v1')
  vi.stubEnv('MODEL_OCR_MAX_REQUEST_CNY', '0.10')
  vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance')
  vi.stubEnv('LOCAL_COMPOSE', 'true')
  vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  api = await import('./server.js')
  await api.persistenceReady
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('Resource recheck listener did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  try { if (api?.server.listening) await new Promise<void>(resolve => { api.server.close(() => resolve()); api.server.closeAllConnections() }) }
  finally { api?.setAuthorizationRepositoryForTests(); api?.setAssetParseRuntimeForTests(); vi.unstubAllEnvs() }
})

// Real strict registered-token authentication, socket upload and asset.parse,
// local isolated object storage, real parser fallback and actual API dispatch
// hook. Scan/points/repositories and the final OCR transport are controlled;
// this is not production scanning, PostgreSQL/RLS or real provider evidence.
describe('inline OCR rechecks exact resource permissions after preflight', () => {
  it.each(['unchanged', 'editor downgraded', 'asset detached', 'asset moved to another brand'] as const)('resource %s cannot hide behind an unchanged identity revision or operator role', async change => {
    const suffix = randomUUID()
    const workspaceId = `ws_resource_recheck_${suffix}`
    const owner = `owner_${suffix}`
    const actor = `operator_${suffix}`
    const ownerToken = `owner_token_${suffix}`
    const token = `operator_token_${suffix}`
    const brandId = `brand_${suffix}`
    const persistence = await api.persistenceReady
    api.setApprovedOcrRateForTests(approvedOcrRate)
    expect(persistence.mode).toBe('memory')
    const previousBrands = persistence.brandUnits
    const brands = new MemoryBrandUnitRepository()
    const authz = new MemoryAuthorizationRepository()
    const parses = new MemoryAssetParseRepository()
    persistence.brandUnits = brands
    api.setAuthorizationRepositoryForTests(authz)
    api.setAssetParseRuntimeForTests({ repository: parses })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [ownerToken]: { actor_id: owner, roles: ['workspace_owner'], workbenches: ['workspace'], workspaces: [workspaceId] },
      [token]: { actor_id: actor, roles: ['operator'], workbenches: ['workspace'], workspaces: [workspaceId] },
    }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: owner, displayName: 'Controlled uploader', role: 'workspace_owner', status: 'active', invitedBy: 'resource-test' })
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: 'Controlled parser', role: 'operator', status: 'active', invitedBy: 'resource-test' })
    const store = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `store_${suffix}`, credentialRef: `fixture://${workspaceId}/taobao` })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const entered = deferred()
    const waiting = deferred()
    transport.entered = entered.resolve
    transport.waiting = waiting.promise
    transport.provider.mockClear()
    transport.denied.mockClear()
    let response: Promise<{ status: number; body: Envelope }> | undefined
    try {
      const uploadedResponse = await fetch(`${base}/v1/assets/upload`, {
        method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'x-workspace-id': workspaceId, 'content-type': 'image/png', 'x-asset-name': `${suffix}.png`, 'x-test-commercial-fixture': 'server-e2e' },
        body: Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(suffix)]),
      })
      const uploaded = await uploadedResponse.json() as Envelope
      expect(uploadedResponse.status, JSON.stringify(uploaded)).toBe(201)
      expect(uploaded.data).toMatchObject({ scanStatus: 'clean' })
      const assetId = uploaded.data?.id
      if (!assetId) throw new Error('Controlled upload did not create an asset')
      await brands.createBrand({ workspaceId, id: brandId, name: 'Controlled product brand' })
      const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: store.id, sourceAssetIds: [assetId], title: 'Controlled bound product', localProductKey: suffix, stock: 1 })
      await brands.createCanonicalProduct({ workspaceId, id: `canonical_${suffix}`, brandId, title: product.title, sourceProductId: product.id })
      await brands.grantBrandAccess({ workspaceId, brandId, externalSubject: actor, role: 'editor' })
      // The uploader and parser differ; unbound-uploader recovery cannot
      // substitute for this bound product's exact brand editor permission.
      expect(api.service.assets.get(assetId)?.uploadedByActorIds).not.toContain(actor)
      response = fetch(`${base}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' },
        body: JSON.stringify({ jsonrpc: '2.0', id: suffix, method: 'asset.parse', params: { workspace_id: workspaceId, asset_id: assetId } }),
      }).then(async result => ({ status: result.status, body: await result.json() as Envelope }))
      await Promise.race([entered.promise, response.then(result => { throw new Error(`Parse failed before controlled OCR preflight: ${JSON.stringify(result)}`) })])
      const member = (await api.workspaceMembers.list(workspaceId)).find(candidate => candidate.externalSubject === actor)!
      expect(member).toMatchObject({ role: 'operator', status: 'active', identityId: expect.any(String) })
      const revision = await authz.getAuthorizationRevision(member.identityId!)
      expect(transport.provider).not.toHaveBeenCalled()
      if (change === 'editor downgraded') await brands.grantBrandAccess({ workspaceId, brandId, externalSubject: actor, role: 'viewer' })
      if (change === 'asset detached' || change === 'asset moved to another brand') {
        // Exercise the live asset -> product -> brand lookup, not just the
        // originally admitted brand ID cached beside the request.
        product.sourceAssetIds = []
        if (change === 'asset moved to another brand') {
          const otherBrandId = `other_brand_${suffix}`
          await brands.createBrand({ workspaceId, id: otherBrandId, name: 'Unpermitted brand' })
          const otherProduct = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: store.id, sourceAssetIds: [assetId], title: 'New unpermitted binding', localProductKey: `other_${suffix}`, stock: 1 })
          await brands.createCanonicalProduct({ workspaceId, id: `other_canonical_${suffix}`, brandId: otherBrandId, title: otherProduct.title, sourceProductId: otherProduct.id })
          expect(await brands.hasBrandAccess({ workspaceId, brandId: otherBrandId, externalSubject: actor })).toBe(false)
        }
      }
      expect(await authz.getAuthorizationRevision(member.identityId!)).toBe(revision)
      expect((await api.workspaceMembers.list(workspaceId)).find(candidate => candidate.externalSubject === actor)).toEqual(member)
      waiting.resolve()
      const result = await response
      if (change !== 'unchanged') {
        expect(transport.provider).not.toHaveBeenCalled()
        expect(transport.denied).toHaveBeenCalledOnce()
        expect(transport.denied.mock.calls[0]?.[0]).toMatchObject({ code: 'ASSET_NOT_FOUND' })
        // The current parse API wraps a known parser failure as 422; the
        // evidence for revocation is the actual resource gate's thrown error.
        expect(result).toMatchObject({ status: 422, body: { data: null, error: { code: 'ASSET_PARSE_FAILED' } } })
        expect(api.service.assets.get(assetId)?.extractedFacts).toBeUndefined()
      } else {
        expect(result.status, JSON.stringify(result.body)).toBe(200)
        expect(result.body.data?.result).toMatchObject({ parseStatus: 'succeeded', extractedFacts: { title: 'Controlled image facts' } })
        expect(transport.provider).toHaveBeenCalledOnce()
        expect(transport.denied).not.toHaveBeenCalled()
      }
      expect(await authz.getAuthorizationRevision(member.identityId!)).toBe(revision)
    } finally {
      waiting.resolve()
      if (response) await response
      transport.entered = undefined
      transport.waiting = Promise.resolve()
      persistence.brandUnits = previousBrands
      api.setAuthorizationRepositoryForTests()
      api.setAssetParseRuntimeForTests()
    }
  })
})
