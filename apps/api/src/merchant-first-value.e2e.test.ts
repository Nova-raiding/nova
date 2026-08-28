import { afterEach, describe, expect, it, vi } from 'vitest'
import { server, service, workspaceMembers } from './server.js'

type Envelope<T = unknown> = { data: T | null; error: { code?: string; message?: string } | null; next_actions: string[] }
type RpcResult = { result: { product: any; contentPreview: any; visualPreviewRefs: string[]; execution: any; nextActions: string[] } }

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

async function call(base: string, workspaceId: string, params: Record<string, unknown> = {}) {
  return await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'merchant.first_value', params: { workspace_id: workspaceId, ...params } }),
  }).then(response => response.json() as Promise<Envelope<RpcResult>>).then(response => ({ ...response, data: response.data?.result ?? null }))
}

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('merchant.first_value API', () => {
  it('returns a read-only fixture bundle with facts, source ids, execution labels, and next actions', async () => {
    const base = await start()
    const before = { products: service.products.size, tasks: service.tasks.size, content: service.contentVersions.size, images: service.imageGenerationJobs.size, publishes: service.publishJobs.size }
    const response = await call(base, 'ws_demo')

    expect(response.error).toBeNull()
    expect(response.data).toMatchObject({
      readOnly: true,
      previewOnly: true,
      product: {
        id: 'prod_fixture_1',
        facts: { title: '轻云防晒外套 2026', source: 'fixture', factsConfirmed: true },
        sourceIds: ['product:prod_fixture_1:v1'],
      },
      contentPreview: null,
      visualPreviewRefs: [],
      execution: { providerExecuted: false, modelCalled: false, label: expect.stringContaining('未调用真实模型') },
      nextActions: expect.arrayContaining([expect.stringContaining('不会发布')]),
    })
    expect(response.data!.execution.content.label).toContain('未调用')
    expect(response.data!.execution.visual.label).toContain('未调用')
    expect({ products: service.products.size, tasks: service.tasks.size, content: service.contentVersions.size, images: service.imageGenerationJobs.size, publishes: service.publishJobs.size }).toEqual(before)
  })

  it('uses only the explicitly scoped product and exposes existing content and visual refs without executing them', async () => {
    const workspaceId = `ws_first_value_bundle_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `first-value-store-${Date.now()}`, credentialRef: `fixture://first-value/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'first-value-product', title: '显式范围商品', stock: 12, price: 199, images: ['fixture://source.jpg'] })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const imageJob = service.enqueueImageGeneration({ workspaceId, productId: product.id, taskId: task.id, contentVersionId: draft.id, idempotencyKey: `first-value-image-${Date.now()}` })
    const completed = await service.completeImageGeneration({ workspaceId, jobId: imageJob.id })
    const visualRef = `dvis_${'a'.repeat(24)}`
    service.archiveImageGenerationOutputs(workspaceId, imageJob.id, [{ visualRef, ordinal: 1, storageKey: `fixture://${workspaceId}/candidate.webp`, mimeType: 'image/webp', sizeBytes: 1, sha256: 'a'.repeat(64), createdAt: new Date().toISOString(), reviewStatus: 'unreviewed' }], 'archived')
    expect(completed.job.state).toBe('succeeded')
    const beforeContentId = service.contentVersions.size
    const base = await start()
    const response = await call(base, workspaceId, { product_id: product.id, platform: 'taobao', account_id: account.id })

    expect(response.error).toBeNull()
    expect(response.data).toMatchObject({
      product: { id: product.id, facts: { accountId: account.id, title: '显式范围商品' } },
      contentPreview: { id: draft.id, body: { title: expect.stringContaining('显式范围商品') }, sourceIds: [`product:${product.id}:v2`] },
      visualPreviewRefs: [visualRef],
      execution: { providerExecuted: false, content: { providerExecuted: false }, visual: { providerExecuted: false } },
    })
    expect(service.contentVersions.size).toBe(beforeContentId)
  })

  it('fails safely without a product and previews an explicitly selected authorized production product', async () => {
    const base = await start()
    const empty = await call(base, `ws_first_value_empty_${Date.now()}`)
    expect(empty.error).toMatchObject({ code: 'FIRST_VALUE_PRODUCT_REQUIRED' })
    expect(empty.next_actions.length).toBeGreaterThan(0)
    expect(empty.next_actions.join(' ')).toContain('catalog.search')
    const example = await call(base, `ws_first_value_empty_${Date.now()}`, { example: 'true' })
    expect(example.error).toBeNull()
    expect(example.data).toMatchObject({ readOnly: true, previewOnly: true, example: true, product: { id: null, facts: { source: 'example', factsConfirmed: false } }, execution: { simulated: true, modelCalled: false, providerExecuted: false } })

    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'merchant-first-value-e2e-session-hash-secret')
    const productionWorkspace = `ws_first_value_production_${Date.now()}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'first-value-test-token': { workspaces: [productionWorkspace], actor_id: 'merchant-test' } }))
    await workspaceMembers.upsert({ workspaceId: productionWorkspace, externalSubject: 'merchant-test', displayName: '首个价值测试', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    const productionAccount = service.registerPlatformAccount({ workspaceId: productionWorkspace, platform: 'taobao', remoteAccountId: `production-first-value-${Date.now()}`, credentialRef: `vault://first-value/${productionWorkspace}` })
    const productionProduct = service.importProduct({ workspaceId: productionWorkspace, platform: 'taobao', accountId: productionAccount.id, localProductKey: 'production-first-value-product', title: '生产首个价值商品', stock: 7, price: 129 })
    service.confirmProductFacts(productionWorkspace, productionProduct.id)
    const production = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer first-value-test-token', 'content-type': 'application/json', 'x-workspace-id': productionWorkspace },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'merchant.first_value', params: { workspace_id: productionWorkspace } }),
    }).then(response => response.json() as Promise<Envelope<RpcResult>>)
    expect(production.error).toMatchObject({ code: 'FIRST_VALUE_SELECTION_REQUIRED' })
    expect(production.next_actions.join(' ')).toContain('catalog.search')

    const selected = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer first-value-test-token', 'content-type': 'application/json', 'x-workspace-id': productionWorkspace },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'merchant.first_value', params: { workspace_id: productionWorkspace, product_id: productionProduct.id, platform: 'taobao', account_id: productionAccount.id } }),
    }).then(response => response.json() as Promise<Envelope<RpcResult>>)
    expect(selected.error).toBeNull()
    expect(selected.data?.result).toMatchObject({ readOnly: true, previewOnly: true, product: { id: productionProduct.id, facts: { title: '生产首个价值商品', accountId: productionAccount.id, factsConfirmed: true } }, execution: { modelCalled: false, providerExecuted: false } })

    service.revokePlatformAccount(productionWorkspace, productionAccount.id, 'taobao')
    const revoked = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer first-value-test-token', 'content-type': 'application/json', 'x-workspace-id': productionWorkspace },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'merchant.first_value', params: { workspace_id: productionWorkspace, product_id: productionProduct.id, platform: 'taobao', account_id: productionAccount.id } }),
    }).then(response => response.json() as Promise<Envelope<RpcResult>>)
    expect(revoked.error).toMatchObject({ code: 'STORE_ONBOARDING_REQUIRED' })
  })

  it('does not allow an explicitly scoped product to cross workspace boundaries', async () => {
    const base = await start()
    const owner = `ws_first_value_owner_${Date.now()}`
    const product = service.importProduct({ workspaceId: owner, platform: 'taobao', localProductKey: 'owner-product', title: '工作区商品', stock: 1 })
    const response = await call(base, `ws_first_value_attacker_${Date.now()}`, { product_id: product.id, platform: 'taobao' })
    expect(response.error).toMatchObject({ code: 'PRODUCT_NOT_FOUND' })
  })
})
