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
 * Same shape as the `catalog-brand-scope` fixture: one workspace, two brands,
 * one product per brand, and a member whose only brand grant is the visible
 * one. `GET /v1/products` and MCP `workspace.metrics` are both workspace
 * scoped capabilities, so the handler owns the row level brand filter on both
 * surfaces.
 */
async function setupBrandScopedWorkspace() {
  const workspaceId = `ws_metrics_scope_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
  vi.stubEnv('NODE_ENV', 'staging')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    'metrics-scope-owner-token': { workspaces: [workspaceId], actor_id: 'metrics-scope-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
    'metrics-scope-viewer-token': { workspaces: [workspaceId], actor_id: 'metrics-scope-viewer', roles: ['operator'], workbenches: ['workspace'] },
  }))
  await workspaceMembers.upsert({ workspaceId, externalSubject: 'metrics-scope-owner', displayName: 'metrics-scope-owner', role: 'workspace_owner', status: 'active', invitedBy: 'metrics-scope-test' })
  await workspaceMembers.upsert({ workspaceId, externalSubject: 'metrics-scope-viewer', displayName: 'metrics-scope-viewer', role: 'operator', status: 'active', invitedBy: 'metrics-scope-test' })
  await grantCreativePointsForTests(workspaceId)
  grantContinuousFeatureEntitlementForTests(workspaceId)
  const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `metrics-scope-store-${workspaceId}`, credentialRef: 'vault://metrics-scope' })
  const visibleProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'metrics-scope-visible', title: '可读商品METRICS', stock: 3 })
  const hiddenProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'metrics-scope-hidden', title: '不可读商品METRICS', stock: 2 })
  const base = await start()
  const ownerHeaders = { authorization: 'Bearer metrics-scope-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
  const viewerHeaders = { authorization: 'Bearer metrics-scope-viewer-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
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
  expect((await mcp(ownerHeaders, 3, 'brand-unit.access.grant', { brand_id: 'brand_visible', external_subject: 'metrics-scope-viewer', role: 'viewer' })).error).toBeNull()
  // One task per brand, so the task funnel and the job/content projections of
  // `workspace.metrics` are brand scoped as well.
  const visibleTask = service.createTask({ workspaceId, productId: visibleProduct.id, platform: 'taobao', accountId: account.id, brandId: 'brand_visible' })
  const hiddenTask = service.createTask({ workspaceId, productId: hiddenProduct.id, platform: 'taobao', accountId: account.id, brandId: 'brand_hidden' })
  return { workspaceId, base, ownerHeaders, viewerHeaders, visibleProduct, hiddenProduct, visibleTask, hiddenTask, mcp }
}

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setBusinessRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('workspace.metrics brand scope', () => {
  it('keeps the brand restricted member inside the same catalog boundary as GET /v1/products', async () => {
    const context = await setupBrandScopedWorkspace()

    // Control: the same token is a brand restricted member — the catalog
    // surface already hides the hidden brand from it.
    const catalog = await fetch(`${context.base}/v1/products`, { headers: context.viewerHeaders })
    expect(catalog.status).toBe(200)
    const catalogBody = await catalog.json() as Envelope<{ items: Array<{ id: string }> }>
    expect(catalogBody.error).toBeNull()
    expect(catalogBody.data?.items.map(item => item.id)).toEqual([context.visibleProduct.id])

    const metrics = await context.mcp(context.viewerHeaders, 10, 'workspace.metrics', {})
    expect(metrics.error).toBeNull()
    const result = metrics.data!.result
    const productRiskIds = result.riskItems.filter((item: { entityType: string }) => item.entityType === 'product').map((item: { entityId: string }) => item.entityId)
    expect(productRiskIds).toContain(context.visibleProduct.id)
    expect(productRiskIds).not.toContain(context.hiddenProduct.id)
    expect(JSON.stringify(result)).not.toContain('不可读商品METRICS')
    expect(result.productSummary).toMatchObject({ total: 1, lowStock: 1 })
    expect(result.dataCoverage.tasks).toBe(1)
    expect(JSON.stringify(result.taskFunnel)).toBe(JSON.stringify({ [context.visibleTask.state]: 1 }))
  })

  it('keeps a workspace wide member unrestricted on workspace.metrics', async () => {
    const context = await setupBrandScopedWorkspace()
    const metrics = await context.mcp(context.ownerHeaders, 11, 'workspace.metrics', {})
    expect(metrics.error).toBeNull()
    const result = metrics.data!.result
    const productRiskIds = result.riskItems.filter((item: { entityType: string }) => item.entityType === 'product').map((item: { entityId: string }) => item.entityId)
    expect(productRiskIds).toEqual(expect.arrayContaining([context.visibleProduct.id, context.hiddenProduct.id]))
    expect(result.productSummary).toMatchObject({ total: 2, lowStock: 2 })
    expect(result.dataCoverage.tasks).toBe(2)
  })
})
