import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service, setBusinessRepositoryForTests, workspaceMembers } from './server.js'

type Envelope<T = Record<string, any>> = { workspace_id: string; data: T | null; error: { code: string; details?: Record<string, unknown> } | null }

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

/**
 * A workspace with two brands, one product per brand, and a member whose only
 * brand grant is the visible one. `catalog.search` / `catalog.image.get` are
 * workspace scoped capabilities, so everything below is decided by the handler.
 */
async function setupBrandScopedWorkspace() {
  const workspaceId = `ws_brand_scope_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
  vi.stubEnv('NODE_ENV', 'staging')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    'brand-scope-owner-token': { workspaces: [workspaceId], actor_id: 'brand-scope-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
    'brand-scope-viewer-token': { workspaces: [workspaceId], actor_id: 'brand-scope-viewer', roles: ['operator'], workbenches: ['workspace'] },
  }))
  await workspaceMembers.upsert({ workspaceId, externalSubject: 'brand-scope-owner', displayName: 'brand-scope-owner', role: 'workspace_owner', status: 'active', invitedBy: 'brand-scope-test' })
  await workspaceMembers.upsert({ workspaceId, externalSubject: 'brand-scope-viewer', displayName: 'brand-scope-viewer', role: 'operator', status: 'active', invitedBy: 'brand-scope-test' })
  await grantCreativePointsForTests(workspaceId)
  grantContinuousFeatureEntitlementForTests(workspaceId)
  const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-scope-store-${workspaceId}`, credentialRef: 'vault://brand-scope' })
  const visibleProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'brand-scope-visible', title: '可读商品', stock: 3 })
  const hiddenProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'brand-scope-hidden', title: '不可读商品', stock: 2 })
  const base = await start()
  const ownerHeaders = { authorization: 'Bearer brand-scope-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
  const viewerHeaders = { authorization: 'Bearer brand-scope-viewer-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
  const mcp = (headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }),
  }).then(response => response.json() as Promise<Envelope<{ result: any }>>)
  expect((await mcp(ownerHeaders, 1, 'brand-unit.create', { brand_id: 'brand_visible', name: '可读品' })).error).toBeNull()
  expect((await mcp(ownerHeaders, 1.1, 'brand-unit.create', { brand_id: 'brand_hidden', name: '不可读品' })).error).toBeNull()
  expect((await mcp(ownerHeaders, 1.9, 'catalog.facts.confirm', { product_id: visibleProduct.id })).error).toBeNull()
  expect((await mcp(ownerHeaders, 1.91, 'catalog.facts.confirm', { product_id: hiddenProduct.id })).error).toBeNull()
  expect((await mcp(ownerHeaders, 2, 'brand-unit.product.create', { brand_id: 'brand_visible', title: '可读品牌商品', source_product_id: visibleProduct.id })).error).toBeNull()
  expect((await mcp(ownerHeaders, 2.1, 'brand-unit.product.create', { brand_id: 'brand_hidden', title: '不可读品牌商品', source_product_id: hiddenProduct.id })).error).toBeNull()
  expect((await mcp(ownerHeaders, 3, 'brand-unit.access.grant', { brand_id: 'brand_visible', external_subject: 'brand-scope-viewer', role: 'viewer' })).error).toBeNull()
  return { workspaceId, base, ownerHeaders, viewerHeaders, visibleProduct, hiddenProduct }
}

const mcpCall = (base: string, headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
}).then(response => response.json() as Promise<Envelope<{ result: any }>>)

const imageJob = (workspaceId: string, productId: string, suffix: string, id: string) => ({
  workspaceId, id, productId, state: 'queued', archiveState: 'not_archived', revision: 1, count: 1,
  imageMode: 'create', direction: '保留商品本体并生成白底主图', sourceProductVersion: 1, sourceAssetIds: [], outputs: [],
  intentHash: `intent_${suffix}`, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
})

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setBusinessRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('catalog brand scope on the HTTP surface', () => {
  it('hands the brand restricted member filter to the durable product page', async () => {
    const context = await setupBrandScopedWorkspace()
    // The durable (PostgreSQL) branch is the production path and has no live
    // database in unit runs, so the repository is captured through the seam:
    // what matters is what the handler asks it for.
    const calls: Array<Record<string, unknown>> = []
    const rows = [
      { id: context.visibleProduct.id, brandId: 'brand_visible', title: '可读品牌商品' },
      { id: context.hiddenProduct.id, brandId: 'brand_hidden', title: '不可读品牌商品' },
    ]
    setBusinessRepositoryForTests({
      // Request admission hydrates the workspace from the durable repository
      // before the handler runs; no snapshots is a valid empty catalog.
      loadWorkspace: async () => [],
      listProductsPage: async (_workspaceId: string, input: Record<string, unknown>) => {
        calls.push(input)
        // Mirrors packages/persistence: a missing `accessibleBrandIds` means
        // "no brand condition", i.e. the whole workspace catalog.
        const allowed = Array.isArray(input.accessibleBrandIds) ? new Set(input.accessibleBrandIds as string[]) : undefined
        const items = rows.filter(row => allowed === undefined || allowed.has(row.brandId))
        return { items, total: items.length, limit: 50, offset: 0 }
      },
    } as never)

    const response = await fetch(`${context.base}/v1/products`, { headers: context.viewerHeaders })
    expect(response.status).toBe(200)
    const body = await response.json() as Envelope<{ items: Array<{ id: string }> }>
    expect(body.error).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.accessibleBrandIds).toEqual(['brand_visible'])
    expect(body.data?.items.map(item => item.id)).toEqual([context.visibleProduct.id])
  })

  it('keeps a workspace wide member unrestricted on the durable product page', async () => {
    const context = await setupBrandScopedWorkspace()
    const calls: Array<Record<string, unknown>> = []
    setBusinessRepositoryForTests({
      loadWorkspace: async () => [],
      listProductsPage: async (_workspaceId: string, input: Record<string, unknown>) => {
        calls.push(input)
        return { items: [{ id: context.visibleProduct.id }, { id: context.hiddenProduct.id }], total: 2, limit: 50, offset: 0 }
      },
    } as never)

    const response = await fetch(`${context.base}/v1/products`, { headers: context.ownerHeaders })
    expect(response.status).toBe(200)
    const body = await response.json() as Envelope<{ items: Array<{ id: string }> }>
    expect(calls[0]!.accessibleBrandIds).toBeUndefined()
    expect(body.data?.items.map(item => item.id)).toEqual([context.visibleProduct.id, context.hiddenProduct.id])
  })

  it('enforces the brand boundary when an individual image generation job is read', async () => {
    const context = await setupBrandScopedWorkspace()
    const base = { workspaceId: context.workspaceId, state: 'queued', archiveState: 'not_archived', revision: 1, count: 1, imageMode: 'create', direction: '保留商品本体并生成白底主图', sourceProductVersion: 1, sourceAssetIds: [], outputs: [], createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
    const hiddenJob = { ...base, id: `imggen_hidden_${Date.now()}`, productId: context.hiddenProduct.id, intentHash: 'intent_hidden' }
    const visibleJob = { ...base, id: `imggen_visible_${Date.now()}`, productId: context.visibleProduct.id, intentHash: 'intent_visible' }
    service.imageGenerationJobs.set(hiddenJob.id, hiddenJob as never)
    service.imageGenerationJobs.set(visibleJob.id, visibleJob as never)

    const denied = await fetch(`${context.base}/v1/image-generation-jobs/${hiddenJob.id}`, { headers: context.viewerHeaders })
    expect(denied.status).toBe(404)
    expect((await denied.json() as Envelope).error?.code).toBe('PRODUCT_NOT_FOUND')

    // The MCP twin is the reference behaviour for the same resource.
    const mcpDenied = await fetch(`${context.base}/mcp`, {
      method: 'POST',
      headers: context.viewerHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.image.get', params: { workspace_id: context.workspaceId, job_id: hiddenJob.id } }),
    }).then(response => response.json() as Promise<Envelope>)
    expect(mcpDenied.error?.code).toBe('PRODUCT_NOT_FOUND')

    // The same read for a granted brand must keep working.
    const allowed = await fetch(`${context.base}/v1/image-generation-jobs/${visibleJob.id}`, { headers: context.viewerHeaders })
    expect(allowed.status).toBe(200)
    const allowedBody = await allowed.json() as Envelope<{ job_id: string; product_id: string }>
    expect(allowedBody.error).toBeNull()
    expect(allowedBody.data).toMatchObject({ job_id: visibleJob.id, product_id: context.visibleProduct.id })
  })

  it('does not let a merchant-settable display name exempt a brand-bound product', async () => {
    const context = await setupBrandScopedWorkspace()
    // `store_name` is merchant input on `catalog.import` and is stored verbatim,
    // so a product bound to a brand keeps whatever name it was imported with.
    // An exemption keyed on that string let a brand-restricted member read a
    // job on any product labelled '未绑定商品'.
    const markedProduct = service.importProduct({ workspaceId: context.workspaceId, platform: 'taobao', localProductKey: 'brand-scope-marked-unbound', title: '伪装未绑定商品', storeName: '未绑定商品', stock: 1 })
    expect(markedProduct.accountId).toBeUndefined()
    expect(markedProduct.storeName).toBe('未绑定商品')
    // A genuine standalone candidate: same display name, no canonical binding.
    const genuineCandidate = service.importProduct({ workspaceId: context.workspaceId, platform: 'taobao', localProductKey: 'brand-scope-genuine-unbound', title: '真实未绑定候选', storeName: '未绑定商品', stock: 1 })
    expect(genuineCandidate.accountId).toBeUndefined()

    const mcp = (headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) => mcpCall(context.base, headers, id, method, { workspace_id: context.workspaceId, ...params })
    expect((await mcp(context.ownerHeaders, 1, 'catalog.facts.confirm', { product_id: markedProduct.id })).error).toBeNull()
    // Binding it to the brand the viewer has no grant on changes nothing about
    // its display name, so only the canonical binding can decide the boundary.
    expect((await mcp(context.ownerHeaders, 2, 'brand-unit.product.create', { brand_id: 'brand_hidden', title: '已绑定隐蔽品牌商品', source_product_id: markedProduct.id })).error).toBeNull()

    const markedJob = imageJob(context.workspaceId, markedProduct.id, 'marked', `imggen_marked_${Date.now()}`)
    const genuineJob = imageJob(context.workspaceId, genuineCandidate.id, 'genuine', `imggen_genuine_${Date.now()}`)
    service.imageGenerationJobs.set(markedJob.id, markedJob as never)
    service.imageGenerationJobs.set(genuineJob.id, genuineJob as never)

    // The string-only predicate returned this job to a member with no grant on
    // `brand_hidden`, including the archived image bytes, on both surfaces.
    const denied = await fetch(`${context.base}/v1/image-generation-jobs/${markedJob.id}`, { headers: context.viewerHeaders })
    expect(denied.status).toBe(404)
    expect((await denied.json() as Envelope).error?.code).toBe('PRODUCT_NOT_FOUND')
    expect((await mcp(context.viewerHeaders, 3, 'catalog.image.get', { job_id: markedJob.id })).error?.code).toBe('PRODUCT_NOT_FOUND')

    // The genuine candidate keeps its exemption on both surfaces.
    const allowed = await fetch(`${context.base}/v1/image-generation-jobs/${genuineJob.id}`, { headers: context.viewerHeaders })
    expect(allowed.status).toBe(200)
    expect((await allowed.json() as Envelope<{ product_id: string }>).data).toMatchObject({ product_id: genuineCandidate.id })
    expect((await mcp(context.viewerHeaders, 4, 'catalog.image.get', { job_id: genuineJob.id })).error).toBeNull()
  })
})
