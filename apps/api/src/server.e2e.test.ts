import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { fixturePaymentAllowed, oauthStates, rollbackBatchProducts, server, service, setPaymentProviderForTests, workspaceMembers } from './server.js'
import type { McpCanonicalProductConsistencyResult } from '../../../packages/contracts/src/index.js'

type Envelope<T = unknown> = { request_id: string; trace_id: string; workspace_id: string; data: T | null; warnings: unknown[]; next_actions: unknown[]; error: { code: string; message: string } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json(response: Response) { return await response.json() as Envelope<any> }

function generatedDecisionBody(title: string, detail: string, sellingPoints: string[]) {
  const factSourceId = 'product:prod_fixture_1:v1'
  return {
    title,
    detail,
    sellingPoints,
    modules: [{
      key: 'selling_points', title: '核心卖点', purpose: '回答购买理由', body: sellingPoints.join('；'),
      factSourceIds: [factSourceId], contentKind: 'fact',
      decisionContract: {
        buyerQuestion: '为什么值得购买？', pageTask: '说明已确认卖点',
        claim: { text: sellingPoints.join('；'), factSourceIds: [factSourceId], platforms: ['taobao'], limitations: ['仅适用于当前商品快照'] },
        evidence: { type: 'parameter', sourceIds: [factSourceId], status: 'verified' },
        visualContract: { requiredElements: ['商品与卖点'], protectedElements: ['商品外观'], prohibitedImplications: ['不得扩大未确认效果'], accessibilityText: sellingPoints.join('；') },
        priority: 1, optional: false,
      },
    }],
  }
}

describe('API HTTP vertical slice', () => {
  it('exposes a read-only workspace-scoped canonical consistency dry-run without cutover', async () => {
    const base = await start()
    const workspaceId = `ws_canonical_consistency_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '一致性检查商品' })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const call = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)

    expect((await call(1, 'brand-unit.create', { brand_id: 'brand_consistency', name: '一致性品' })).error).toBeNull()
    expect((await call(1.1, 'catalog.facts.confirm', { product_id: product.id })).error).toBeNull()
    expect((await call(2, 'brand-unit.product.create', { brand_id: 'brand_consistency', product_id: 'canonical_consistency', title: product.title, source_product_id: product.id })).error).toBeNull()
    const report = await call(3, 'canonical.product.consistency', {})
    expect(report.error).toBeNull()
    expect(report.data).toMatchObject({ result: { readOnly: true, cutover: 'unchanged', source: 'memory', durable: false, workspaceId, generatedAt: expect.any(String), readMode: 'snapshot', freshness: 'fresh', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
    const result = (report.data as { result: McpCanonicalProductConsistencyResult }).result
    expect(Object.keys(result).sort()).toEqual(['availability', 'blocking', 'contractStatus', 'contractVersion', 'counts', 'cutover', 'durable', 'findings', 'freshness', 'generatedAt', 'orphanFindings', 'readMode', 'readOnly', 'read_control', 'revision', 'source', 'status', 'unified_link_audit', 'workspaceId'].sort())
    expect(result.read_control).toMatchObject({ mode: 'legacy_shadow', source: 'default' })
    expect(result.unified_link_audit).toMatchObject({ persisted: false, count: expect.any(Number), items: expect.any(Array) })
    expect(result.findings.every(item => ['verified', 'legacy_only', 'conflict', 'blocked'].includes(item.status))).toBe(true)
    expect(result.findings.every(item => item.productId && item.evidence && item.blocking !== undefined && item.nextAction !== undefined)).toBe(true)
  })

  it('rejects a canonical consistency request whose body workspace differs from the identity header', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_canonical_header' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'canonical.product.consistency', params: { workspace_id: 'ws_canonical_body' } }) }).then(json)
    expect(response.data).toBeNull()
    expect(response.error).toMatchObject({ code: 'WORKSPACE_SCOPE_MISMATCH' })
  })

  it('paginates product collections while preserving direct product reads', async () => {
    const base = await start()
    const workspaceId = `ws_page_${Date.now()}`
    const created = Array.from({ length: 25 }, (_, index) => service.importProduct({ workspaceId, platform: 'taobao', title: `Paged product ${index + 1}`, skuCount: 1, stock: index + 1 }))
    const defaultPage = await fetch(`${base}/v1/products`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect.soft(defaultPage.data).toMatchObject({ total: 25, limit: 20, offset: 0, items: expect.any(Array) })
    expect.soft(Array.isArray(defaultPage.data) ? defaultPage.data : (defaultPage.data as { items: unknown[] }).items).toHaveLength(20)
    Array.from({ length: 25 }, () => service.createTask({ workspaceId, productId: created[0]!.id, platform: 'taobao' }))
    const defaultTaskPage = await fetch(`${base}/v1/tasks`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect.soft(defaultTaskPage.data).toMatchObject({ total: 25, limit: 20, offset: 0, items: expect.any(Array) })
    expect.soft(Array.isArray(defaultTaskPage.data) ? defaultTaskPage.data : (defaultTaskPage.data as { items: unknown[] }).items).toHaveLength(20)
    const firstPage = await fetch(`${base}/v1/products?limit=2&offset=0`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect(firstPage.data).toMatchObject({ total: 25, limit: 2, offset: 0, items: expect.any(Array) })
    expect((firstPage.data as { items: unknown[] }).items).toHaveLength(2)
    const direct = await fetch(`${base}/v1/products/${encodeURIComponent(created[1]!.id)}`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect((direct.data as { id: string }).id).toBe(created[1]!.id)
  })

  it('discovers workspace-scoped image jobs without exposing another workspace', async () => {
    const base = await start()
    const workspaceId = `ws_image_discovery_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '图片发现商品' })
    const job = service.enqueueImageGeneration({ workspaceId, productId: product.id, idempotencyKey: `image-discovery-${workspaceId}` })
    const otherWorkspace = `ws_image_discovery_other_${Date.now()}`
    const otherProduct = service.importProduct({ workspaceId: otherWorkspace, platform: 'taobao', title: '不应泄露的商品' })
    service.enqueueImageGeneration({ workspaceId: otherWorkspace, productId: otherProduct.id, idempotencyKey: `image-discovery-${otherWorkspace}` })
    const response = await fetch(`${base}/v1/image-generation-jobs?limit=20&offset=0`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect(response.error).toBeNull()
    expect(response.data).toMatchObject({ total: 1, items: [{ jobId: job.id, productId: product.id, productTitle: '图片发现商品', platform: 'taobao', candidateCount: 0 }] })
    service.archiveImageGenerationOutputs(workspaceId, job.id, [{ visualRef: 'dvis_receipt_contract', ordinal: 1, assetId: 'asset_receipt_contract', archiveReceiptId: 'image_archive_receipt_contract', archiveReceiptDigest: 'f'.repeat(64), storageKey: `clean/${workspaceId}/asset_receipt_contract/candidate-1.webp`, mimeType: 'image/webp', sizeBytes: 128, sha256: 'a'.repeat(64), createdAt: new Date().toISOString(), reviewStatus: 'unreviewed' }], 'archived')
    const detail = await fetch(`${base}/v1/image-generation-jobs/${encodeURIComponent(job.id)}`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect(detail.error).toBeNull()
    expect(detail.data).toMatchObject({ outputs: [{ archive_receipt_id: 'image_archive_receipt_contract', archive_receipt_digest: 'f'.repeat(64) }] })
    const assigned = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ops.marketing.queue.assign', params: { workspace_id: workspaceId, item_type: 'image', item_id: job.id, operator_id: 'image-operator', expected_revision: '2', reason: '安排人工对账负责人' } }) }).then(json)
    expect(assigned.error).toBeNull()
    expect(assigned.data).toMatchObject({ result: { assignedOperatorId: 'image-operator', revision: 3 } })
  })

  it('enforces restricted brand boundaries across REST products, tasks, image review, and MCP product_id', async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'brand-boundary-session-hash-secret')
    const workspaceId = `ws_brand_boundary_${Date.now()}`
    const ownerId = `brand-owner-${Date.now()}`
    const memberId = `brand-member-${Date.now()}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-boundary-owner-token': { workspaces: [workspaceId], actor_id: ownerId, roles: ['workspace_owner'] },
      'brand-boundary-member-token': { workspaces: [workspaceId], actor_id: memberId, roles: ['operator'] },
    }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: ownerId, displayName: '品牌边界所有者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: memberId, displayName: '品牌边界成员', role: 'operator', status: 'active', invitedBy: 'test' })
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-boundary-${workspaceId}`, credentialRef: 'vault://brand-boundary' })
    const visibleProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: `visible-${workspaceId}`, title: '可访问品牌商品', stock: 8, images: ['https://assets.example/visible.jpg'] })
    const hiddenProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: `hidden-${workspaceId}`, title: '越权品牌商品', stock: 7, images: ['https://assets.example/hidden.jpg'] })
    const unbrandedProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: `unbranded-${workspaceId}`, title: '无品牌商品', stock: 6 })
    const visibleTask = service.createTask({ workspaceId, productId: visibleProduct.id, platform: 'taobao', accountId: account.id, brandId: 'brand_visible' })
    service.createTask({ workspaceId, productId: hiddenProduct.id, platform: 'taobao', accountId: account.id, brandId: 'brand_hidden' })
    service.createTask({ workspaceId, productId: unbrandedProduct.id, platform: 'taobao', accountId: account.id })
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer brand-boundary-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const memberHeaders = { authorization: 'Bearer brand-boundary-member-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const mcp = (headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)

    expect((await mcp(ownerHeaders, 1, 'brand-unit.create', { brand_id: 'brand_visible', name: '可访问品牌' })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2, 'brand-unit.create', { brand_id: 'brand_hidden', name: '隐藏品牌' })).error).toBeNull()
    expect((await mcp(ownerHeaders, 3, 'brand-unit.bind-store', { brand_id: 'brand_visible', platform: 'taobao', account_id: account.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 3.1, 'brand-unit.bind-store', { brand_id: 'brand_hidden', platform: 'taobao', account_id: account.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 3.2, 'catalog.facts.confirm', { product_id: visibleProduct.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 4, 'brand-unit.product.create', { brand_id: 'brand_visible', product_id: `canonical-visible-${workspaceId}`, title: visibleProduct.title, source_product_id: visibleProduct.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 5, 'brand-unit.product.create', { brand_id: 'brand_hidden', product_id: `canonical-hidden-${workspaceId}`, title: hiddenProduct.title })).error).toBeNull()
    expect((await mcp(ownerHeaders, 5.1, 'brand-unit.listing.create', { brand_id: 'brand_visible', canonical_product_id: `canonical-visible-${workspaceId}`, platform: 'taobao', account_id: account.id, remote_product_id: `remote-visible-${workspaceId}` })).error).toBeNull()
    expect((await mcp(ownerHeaders, 6, 'brand-unit.access.grant', { brand_id: 'brand_visible', external_subject: memberId, role: 'editor', reason: '品牌边界验收' })).error).toBeNull()

    const products = await fetch(`${base}/v1/products?limit=20&offset=0`, { headers: memberHeaders }).then(json)
    expect(products.data).toMatchObject({ total: 1, limit: 20, offset: 0, items: [expect.objectContaining({ id: visibleProduct.id })] })
    for (const productId of [hiddenProduct.id, unbrandedProduct.id]) {
      const detail = await fetch(`${base}/v1/products/${encodeURIComponent(productId)}`, { headers: memberHeaders }).then(json)
      expect(detail.error?.code).toBe('PRODUCT_NOT_FOUND')
      const imageReview = await fetch(`${base}/v1/products/${encodeURIComponent(productId)}/image-review`, { headers: memberHeaders }).then(json)
      expect(imageReview.error?.code).toBe('PRODUCT_NOT_FOUND')
    }
    const visibleDetail = await fetch(`${base}/v1/products/${encodeURIComponent(visibleProduct.id)}`, { headers: memberHeaders }).then(json)
    expect(visibleDetail.data).toMatchObject({ id: visibleProduct.id })
    const visibleImageReview = await fetch(`${base}/v1/products/${encodeURIComponent(visibleProduct.id)}/image-review`, { headers: memberHeaders }).then(json)
    expect(visibleImageReview.error).toBeNull()
    const hiddenVideo = await mcp(memberHeaders, 8.1, 'multimodal.video.request', { prompt: '生成商品脚本', output: 'script', context_json: JSON.stringify({ brand: { id: 'brand_hidden', version: '1' }, product: { id: hiddenProduct.id, version: '1' }, rules: [] }), idempotency_key: `hidden-video-${Date.now()}` })
    expect(hiddenVideo.error?.code).toBe('PRODUCT_NOT_FOUND')

    const tasks = await fetch(`${base}/v1/tasks?limit=20&offset=0`, { headers: memberHeaders }).then(json)
    expect(tasks.data).toMatchObject({ total: 1, limit: 20, offset: 0, items: [expect.objectContaining({ id: visibleTask.id })] })
    const unbrandedCreate = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ product_id: visibleProduct.id, platform: 'taobao', account_id: account.id }) }).then(json)
    expect(unbrandedCreate.error?.code).toBe('TASK_BRAND_REQUIRED')

    for (const method of ['catalog.facts.confirm', 'catalog.image.review']) {
      const denied = await mcp(memberHeaders, method === 'catalog.facts.confirm' ? 7 : 8, method, { product_id: hiddenProduct.id })
      expect(denied.error?.code).toBe('PRODUCT_NOT_FOUND')
    }

    const rebound = await mcp(memberHeaders, 9, 'brand-unit.product.create', { brand_id: 'brand_visible', product_id: `canonical-rebound-${workspaceId}`, title: hiddenProduct.title, source_product_id: hiddenProduct.id })
    expect(rebound.error?.code).toBe('PRODUCT_NOT_FOUND')
    const unbrandedRebound = await mcp(memberHeaders, 9.1, 'brand-unit.product.create', { brand_id: 'brand_visible', product_id: `canonical-unbranded-rebound-${workspaceId}`, title: unbrandedProduct.title, source_product_id: unbrandedProduct.id })
    expect(unbrandedRebound.error?.code).toBe('PRODUCT_NOT_FOUND')

    expect(hiddenProduct.factsConfirmed).toBe(false)
    const restConfirm = await fetch(`${base}/v1/products/${encodeURIComponent(hiddenProduct.id)}/confirm`, { method: 'POST', headers: memberHeaders }).then(json)
    expect(restConfirm.error?.code).toBe('PRODUCT_NOT_FOUND')
    expect(hiddenProduct.factsConfirmed).toBe(false)

    const clone = await mcp(memberHeaders, 10, 'task.clone', { task_id: visibleTask.id, target_product_id: hiddenProduct.id, target_platform: 'taobao', target_account_id: account.id })
    expect(clone.error?.code).toBe('PRODUCT_NOT_FOUND')

    const nestedEntries = JSON.stringify([
      { product_id: visibleProduct.id, platform: 'taobao', account_id: account.id },
      { product_id: hiddenProduct.id, platform: 'taobao', account_id: account.id },
    ])
    const mcpGroup = await mcp(memberHeaders, 11, 'task.group.create', { entries_json: nestedEntries })
    expect(mcpGroup.error?.code).toBe('PRODUCT_NOT_FOUND')
    const restGroup = await fetch(`${base}/v1/task-groups`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ entries: JSON.parse(nestedEntries) }) }).then(json)
    expect(restGroup.error?.code).toBe('PRODUCT_NOT_FOUND')

    const hiddenRequest = `请为淘宝的${hiddenProduct.title}生成内容`
    const mcpUnderstanding = await mcp(memberHeaders, 12, 'task.understand', { request_text: hiddenRequest })
    expect(mcpUnderstanding.error?.code).toBe('PRODUCT_NOT_FOUND')
    const restUnderstanding = await fetch(`${base}/v1/tasks/understand`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ request_text: hiddenRequest }) }).then(json)
    expect(restUnderstanding.error?.code).toBe('PRODUCT_NOT_FOUND')
    const mcpRequest = await mcp(memberHeaders, 13, 'task.request.create', { request_text: hiddenRequest })
    expect(mcpRequest.error?.code).toBe('PRODUCT_NOT_FOUND')
    const restRequest = await fetch(`${base}/v1/task-requests`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ request_text: hiddenRequest }) }).then(json)
    expect(restRequest.error?.code).toBe('PRODUCT_NOT_FOUND')

    const visibleRequest = await fetch(`${base}/v1/task-requests`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ request_text: `请为淘宝的${visibleProduct.title}生成内容` }) }).then(json)
    expect(visibleRequest.error).toBeNull()
    expect(visibleRequest.data).toMatchObject({ tasks: [expect.objectContaining({ productId: visibleProduct.id, brandId: 'brand_visible' })] })

    const campaignByProductIds = await mcp(memberHeaders, 14, 'campaign.batch.create', { brand_id: 'brand_visible', platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([hiddenProduct.id]) })
    expect(campaignByProductIds.error?.code).toBe('PRODUCT_NOT_FOUND')
    const campaignByTargets = await mcp(memberHeaders, 15, 'campaign.batch.create', { brand_id: 'brand_visible', targets_json: JSON.stringify([{ product_id: hiddenProduct.id, platform: 'taobao', account_id: account.id }]) })
    expect(campaignByTargets.error?.code).toBe('PRODUCT_NOT_FOUND')
    const campaignByCanonicalTarget = await mcp(memberHeaders, 16, 'campaign.batch.create', { brand_id: 'brand_visible', targets_json: JSON.stringify([{ canonical_product_id: `canonical-hidden-${workspaceId}`, platform: 'taobao', account_id: account.id }]) })
    expect(campaignByCanonicalTarget.error?.code).toBe('CANONICAL_PRODUCT_NOT_FOUND')
    const hiddenCampaign = await mcp(ownerHeaders, 17, 'campaign.batch.create', { brand_id: 'brand_hidden', platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([hiddenProduct.id]) })
    expect(hiddenCampaign.error).toBeNull()
    const hiddenCampaignId = (hiddenCampaign.data as { result: { id: string } }).result.id
    const deniedPause = await mcp(memberHeaders, 18, 'campaign.batch.pause', { campaign_id: hiddenCampaignId, expected_revision: '1', idempotency_key: `hidden-pause-${Date.now()}`, reason: '尝试暂停无权品牌' })
    expect(deniedPause.error?.code).toBe('BRAND_ACCESS_REQUIRED')
    const visibleCampaign = await mcp(memberHeaders, 19, 'campaign.batch.create', { brand_id: 'brand_visible', platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([visibleProduct.id]) })
    expect(visibleCampaign.error).toBeNull()
    const visibleCampaignId = (visibleCampaign.data as { result: { id: string } }).result.id
    const allowedPause = await mcp(memberHeaders, 20, 'campaign.batch.pause', { campaign_id: visibleCampaignId, expected_revision: '1', idempotency_key: `visible-pause-${Date.now()}`, reason: '编辑者暂停可访问品牌' })
    expect(allowedPause.data).toMatchObject({ result: { id: visibleCampaignId, state: 'paused', revision: 2, durable: false } })
  })

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); setPaymentProviderForTests(); vi.unstubAllEnvs() })

  it('defaults billing reads to the authenticated member and restricts workspace scope to billing administrators', async () => {
    const workspaceId = `ws_personal_billing_${Date.now()}`
    const ownerId = `billing-owner-${Date.now()}`
    const memberId = `billing-member-${Date.now()}`
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'personal-billing-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'personal-billing-owner': { workspaces: [workspaceId], actor_id: ownerId, roles: ['workspace_owner'] },
      'personal-billing-member': { workspaces: [workspaceId], actor_id: memberId, roles: ['operator'] },
    }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: ownerId, displayName: '账务所有者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: memberId, displayName: '账务成员', role: 'operator', status: 'active', invitedBy: ownerId })
    const base = await start()
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId })
    const call = (token: string, id: number, method: string, params: Record<string, unknown> = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: headers(token), body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)

    const ownerOrder = (await call('personal-billing-owner', 1, 'billing.recharge.create', { channel: 'alipay', amount_cny: '10.00', idempotency_key: `owner-${workspaceId}` })).data?.result as { id: string }
    const memberOrder = (await call('personal-billing-member', 2, 'billing.recharge.create', { channel: 'wechat', amount_cny: '20.00', idempotency_key: `member-${workspaceId}` })).data?.result as { id: string }
    await call('personal-billing-owner', 3, 'billing.recharge.get', { order_id: ownerOrder.id, confirm_test_payment: 'true' })
    await call('personal-billing-member', 4, 'billing.recharge.get', { order_id: memberOrder.id, confirm_test_payment: 'true' })

    const memberMine = await call('personal-billing-member', 5, 'billing.recharge.list')
    expect(memberMine.data?.result).toMatchObject({ scope: 'mine', total: 1, orders: [expect.objectContaining({ id: memberOrder.id })] })
    expect((await call('personal-billing-member', 6, 'billing.recharge.list', { scope: 'workspace' })).error?.code).toBe('FORBIDDEN')
    expect((await call('personal-billing-member', 7, 'billing.recharge.get', { order_id: ownerOrder.id })).error?.code).toBe('BILLING_ORDER_NOT_FOUND')
    expect((await call('personal-billing-owner', 7.1, 'billing.recharge.get', { order_id: memberOrder.id })).error?.code).toBe('BILLING_ORDER_NOT_FOUND')
    expect((await call('personal-billing-owner', 7.2, 'billing.recharge.get', { order_id: memberOrder.id, scope: 'workspace' })).data?.result).toMatchObject({ id: memberOrder.id })

    const ownerWorkspace = await call('personal-billing-owner', 8, 'billing.recharge.list', { scope: 'workspace' })
    expect(ownerWorkspace.data?.result).toMatchObject({ scope: 'workspace', total: 2 })
    const memberTransactions = await call('personal-billing-member', 9, 'billing.transactions')
    expect(memberTransactions.data?.result).toMatchObject({ scope: 'mine', wallet_scope: 'workspace', balance_cny: '30.00', transactions: [expect.objectContaining({ orderId: memberOrder.id })] })
    const status = await call('personal-billing-member', 10, 'billing.status')
    expect(status.data?.result).toMatchObject({ viewer: { default_scope: 'mine', available_scopes: ['mine'] } })
    const memberExport = await call('personal-billing-member', 11, 'billing.export', { format: 'csv' })
    expect(memberExport.data?.result).toMatchObject({ scope: 'mine', filename: 'my-billing.csv' })
    expect((memberExport.data?.result as { content: string }).content).toContain(memberOrder.id)
    expect((memberExport.data?.result as { content: string }).content).not.toContain(ownerOrder.id)
    expect((await call('personal-billing-member', 12, 'billing.export', { scope: 'workspace' })).error?.code).toBe('FORBIDDEN')
    const ownerDefaultExport = await call('personal-billing-owner', 12.5, 'billing.export', { format: 'csv' })
    expect(ownerDefaultExport.data?.result).toMatchObject({ scope: 'mine', filename: 'my-billing.csv' })
    expect((ownerDefaultExport.data?.result as { content: string }).content).toContain(ownerOrder.id)
    expect((ownerDefaultExport.data?.result as { content: string }).content).not.toContain(memberOrder.id)
    const ownerExport = await call('personal-billing-owner', 13, 'billing.export', { scope: 'workspace', format: 'json' })
    expect((ownerExport.data?.result as { content: string }).content).toContain(ownerOrder.id)
    expect((ownerExport.data?.result as { content: string }).content).toContain(memberOrder.id)
    const personalStatement = await call('personal-billing-owner', 14, 'billing.model-usage.statement')
    expect(personalStatement.data?.result).toMatchObject({ statement: { scope: 'mine' }, model_usage: { provider_cost_cny: null, external_provider_statement: { status: 'not_applicable_personal_scope' } } })
  })

  it('only enables fixture checkout when the local payment flag is explicit', () => {
    expect(fixturePaymentAllowed({})).toBe(false)
    expect(fixturePaymentAllowed({ ALLOW_LOCAL_PAYMENT_FIXTURE: 'true' })).toBe(true)
    expect(fixturePaymentAllowed({ ALLOW_LOCAL_PAYMENT_FIXTURE: 'false' })).toBe(false)
  })

  it('neutralizes formula-like audit fields in ops.audit.export CSV', async () => {
    const base = await start()
    const workspaceId = `ws_audit_csv_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'audit_export_operator', 'x-role': 'platform_ops' }
    const call = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)
    const malicious = ['=', '+', '-', '@'].map((prefix, index) => ({
      externalSubject: `${prefix}malicious-subject-${index}`,
      reason: `${prefix}HYPERLINK("https://evil.example/${index}")`,
    }))

    for (const [index, item] of malicious.entries()) {
      const created = await call(index + 1, 'ops.member.upsert', { external_subject: item.externalSubject, display_name: `恶意审计字段 ${index}`, role: 'operator', status: 'active', reason: item.reason })
      expect(created.error).toBeNull()
    }

    const exported = await call(10, 'ops.audit.export', {})
    expect(exported.error).toBeNull()
    const content = (exported.data as { result: { csv: string } }).result.csv
    for (const item of malicious) {
      expect(content).toContain(`"'${item.externalSubject}"`)
      expect(content).toContain(`"'${item.reason.replaceAll('"', '""')}"`)
    }
  })

  it('confirms a test checkout only when the explicit local fixture flag is enabled', async () => {
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    const base = await start()
    const workspaceId = `ws_test_checkout_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const call = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)
    const created = await call(1, 'billing.recharge.create', { channel: 'alipay', amount_cny: '10.00', idempotency_key: `test-checkout-${workspaceId}` })
    const orderId = (created.data as { result: { id: string } }).result.id
    const paid = await call(2, 'billing.recharge.get', { order_id: orderId, confirm_test_payment: 'true' })
    expect(paid.data).toMatchObject({ result: { id: orderId, state: 'paid', amount_cny: '10.00', test_payment_confirmed: true, replayed: false } })
    const replay = await call(3, 'billing.recharge.get', { order_id: orderId, confirm_test_payment: 'true' })
    expect(replay.data).toMatchObject({ result: { id: orderId, state: 'paid', test_payment_confirmed: true, replayed: true } })
    const status = await call(4, 'billing.status', {})
    expect(status.data).toMatchObject({ result: { balance_cny: '10.00', plugin_access: { unlocked: true } } })
  })

  it('rolls back only its own batch writes when concurrent product state changes', () => {
    const workspaceId = 'ws_batch_rollback'
    const previous = { id: 'prod_existing', workspaceId, version: 2 }
    const imported = { id: previous.id, workspaceId, version: 3 }
    const concurrent = { id: 'prod_concurrent', workspaceId, version: 1 }
    const products = new Map([[previous.id, imported], [concurrent.id, concurrent]])
    const before = new Map([[previous.id, previous]])

    rollbackBatchProducts(products, workspaceId, [{ product: imported, version: imported.version }], before)

    expect(products.get(previous.id)).toBe(previous)
    expect(products.get(concurrent.id)).toBe(concurrent)

    const replaced = { ...imported, version: 4 }
    products.set(previous.id, replaced)
    rollbackBatchProducts(products, workspaceId, [{ product: imported, version: imported.version }], before)
    expect(products.get(previous.id)).toBe(replaced)

    const created = { id: 'prod_created', workspaceId, version: 1 }
    products.set(created.id, created)
    rollbackBatchProducts(products, workspaceId, [{ product: created, version: created.version }], before)
    expect(products.has(created.id)).toBe(false)
  })

  it('bootstraps a first-run workspace before the Codex plugin binds its workspace id', async () => {
    const base = await start()
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-bootstrap': 'true', 'x-actor-id': 'codex-user-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.bootstrap', params: { display_name: 'Codex 首次工作区', external_subject: 'codex-user-1' } }) }).then(json)
    expect(created.error).toBeNull()
    const workspaceId = (created.data as { result: { workspaceId: string; binding: { environmentVariable: string; requiredValue: string } } }).result.workspaceId
    expect(workspaceId).toMatch(/^ws_[a-f0-9]{24}$/)
    expect((created.data as { result: { binding: { environmentVariable: string; requiredValue: string } } }).result.binding).toMatchObject({ environmentVariable: 'MERCHANT_WORKSPACE_ID', requiredValue: workspaceId })
    const health = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'workspace.health', params: { workspace_id: workspaceId } }) }).then(json)
    expect(health.error).toBeNull()
    expect((health.data as { result: { workspace: { id: string; status: string } } }).result.workspace).toMatchObject({ id: workspaceId, status: 'ready' })
    expect((health.data as { result: { capabilityCards: { presentation: string; navigation: { presentation: string; selectionKey: string; items: Array<{ id: string; action: { method: string; arguments: { scope: string } } }> }; onboarding: Array<{ id: string; entryMethod: string; state: string }>; cards: Array<{ id: string }> } } }).result.capabilityCards).toMatchObject({ presentation: 'conversation_cards', navigation: { presentation: 'grouped_list', selectionKey: 'platform + accountId', items: expect.arrayContaining([expect.objectContaining({ id: 'all-stores', action: { method: 'catalog.search', arguments: { scope: 'workspace' } } })]) }, onboarding: expect.arrayContaining([expect.objectContaining({ id: 'workspace', entryMethod: 'workspace.health', state: 'complete' }), expect.objectContaining({ id: 'bind-store', title: '连接店铺', entryMethod: 'platform.connect', state: 'required' }), expect.objectContaining({ id: 'choose-product', entryMethod: 'catalog.search', state: 'blocked' }), expect.objectContaining({ id: 'start-content', title: '生成并审核', entryMethod: 'task.understand' }), expect.objectContaining({ id: 'publish', entryMethod: 'publish.prepare', state: 'blocked' })]), cards: expect.arrayContaining([expect.objectContaining({ id: 'first-value' }), expect.objectContaining({ id: 'stores-products' }), expect.objectContaining({ id: 'content' }), expect.objectContaining({ id: 'billing' })]) })
    expect(((health.data as { result: { capabilityCards: { onboarding: unknown[] } } }).result.capabilityCards.onboarding)).toHaveLength(6)
    const startCard = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.5, method: 'merchant.start', params: { workspace_id: workspaceId } }) }).then(json)
    expect(startCard.error).toBeNull()
    const startResult = (startCard.data as { result: { greeting: string; currentStep: { id: string; entryMethod: string }; nextPrompt: string; modelAccess: { userKeyRequired: boolean }; brandNavigation: { presentation: string; hierarchy: string[]; items: unknown[] }; platformOptions: Array<{ platform: string; label: string; state: string; action: string; readiness: { mediaUpload: { ready: boolean; configured: boolean; evidence: boolean; reason?: string } } }>; cards: Array<{ id: string; state: string; cta: string; action: { method: string }; blocked_by: string[]; next_actions?: Array<{ required_inputs?: string[] }>; capabilityGate?: { unlocked: boolean; method: string; reason: string } }>; wallet: { balance_cny: string; unlocked: boolean; recharge_channels: string[]; status_method: string; recharge_method: string; message: string } } }).result
    expect(startResult).toMatchObject({ greeting: '欢迎使用大麦。', currentStep: { id: 'bind-store', entryMethod: 'platform.connect' }, nextPrompt: '选择一个平台连接我的店铺', modelAccess: { userKeyRequired: false }, wallet: { balance_cny: '0.00', unlocked: false } })
    expect(startResult.brandNavigation).toMatchObject({ presentation: 'tree', hierarchy: ['brand', 'platform', 'store'], items: [] })
    expect(startResult.cards[0]).toMatchObject({ id: 'stores-products', action: { method: 'platform.connect' } })
    expect(startResult.platformOptions).toEqual(expect.arrayContaining([expect.objectContaining({ platform: 'taobao', label: '淘宝', action: 'platform.connect' })]))
    expect(startResult.platformOptions.every(option => option.readiness.mediaUpload.ready === false && option.readiness.mediaUpload.reason)).toBe(true)
    expect(startResult.cards.find(card => card.id === 'first-value')).toMatchObject({ cta: '示例体验', action: { method: 'merchant.first_value', arguments: { example: 'true' } }, blocked_by: [] })
    expect(startResult.cards.find(card => card.id === 'stores-products')).toMatchObject({ state: 'blocked', cta: '选择店铺并查看商品', action: { method: 'platform.connect' } })
    expect(startResult.cards.find(card => card.id === 'content')).toMatchObject({ action: { method: 'catalog.search' }, blocked_by: ['store_product_selection'] })
    expect(startResult.cards.find(card => card.id === 'content')?.capabilityGate).toMatchObject({ unlocked: false, method: 'billing.status' })
    expect(startResult.cards.find(card => card.id === 'bulk-publish')).toMatchObject({ action: { method: 'publish.batch.prepare' }, next_actions: [{ required_inputs: ['task_ids_json'] }] })
    const explicitStartParams = { workspace_id: workspaceId, requested_platform: 'jd', requested_goal: '生成京东白底主图', attachment_count: '1', idempotency_key: 'merchant-start-e2e-explicit-1' }
    const explicitStart = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.51, method: 'merchant.start', params: explicitStartParams }) }).then(json)
    expect(explicitStart.error).toBeNull()
    expect(explicitStart.data).toMatchObject({ result: { greeting: '好的，我已理解你的目标。', recognizedIntent: { platform: 'jd', goal: '生成京东白底主图', attachment_count: 1 }, currentStep: { id: 'automatic-scan', state: 'in_progress' }, automation: { asset_scan: 'automatic', continuation: 'durable', administrator_action_required: false }, action_cards: [] } })
    expect(JSON.stringify(explicitStart.data)).not.toMatch(/管理员|选择.*平台/u)
    const explicitReplay = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.52, method: 'merchant.start', params: explicitStartParams }) }).then(json)
    expect((explicitReplay.data as { result: unknown }).result).toEqual((explicitStart.data as { result: unknown }).result)
    const explicitConflictResponse = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.53, method: 'merchant.start', params: { ...explicitStartParams, requested_goal: '生成另一套详情图' } }) })
    const explicitConflict = await json(explicitConflictResponse)
    expect(explicitConflictResponse.status).toBe(409)
    expect(explicitConflict.error).toMatchObject({ code: 'MERCHANT_INTENT_IDEMPOTENCY_CONFLICT' })
    const billing = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.6, method: 'billing.status', params: { workspace_id: workspaceId } }) }).then(json)
    expect((billing.data as { result: { balance_cny: string; plugin_access: { unlocked: boolean }; model_access: { access_state: string }; capability_entitlements: { balance: { state: string }; package_quota: { state: string }; generation: { state: string; code: string }; platform_publish: { state: string; code: string } }; action_cards: Array<{ method: string; label: string; required_inputs?: string[]; arguments?: Record<string, unknown>; confirmation: string }> } }).result).toMatchObject({ balance_cny: '0.00', plugin_access: { unlocked: false }, model_access: { access_state: 'recharge_required' }, capability_entitlements: { balance: { state: 'recharge_required' }, package_quota: { state: 'available' }, generation: { state: 'blocked', code: 'wallet_balance' }, platform_publish: { state: 'blocked', code: 'wallet_balance' } }, action_cards: expect.arrayContaining([
      expect.objectContaining({ method: 'billing.recharge.create', label: '创建充值订单', required_inputs: ['channel', 'amount_cny', 'idempotency_key'], confirmation: 'interactive_confirmation' }),
      expect.objectContaining({ method: 'subscription.change', label: '升级套餐', required_inputs: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'], confirmation: 'interactive_confirmation' }),
    ]) })
    for (const [index, method] of ['asset.list', 'task.history', 'deliverable.list'].entries()) {
      const empty = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.7 + index, method, params: { workspace_id: workspaceId } }) }).then(json)
      expect(empty.error).toBeNull()
      expect((empty.data as { result: { empty_state: { title: string }; action_cards: Array<{ method: string; required_inputs: string[] }> } }).result).toMatchObject({ empty_state: { title: expect.any(String) }, action_cards: expect.arrayContaining([expect.objectContaining({ method: expect.any(String), required_inputs: expect.any(Array) })]) })
    }
    const session = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'codex-user-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ops.session', params: { workspace_id: workspaceId } }) }).then(json)
    expect(session.error).toBeNull()
    expect((session.data as { result: { actor_id: string; workspace_id: string; workspace_granted: boolean } }).result).toMatchObject({ actor_id: 'codex-user-1', workspace_id: workspaceId, workspace_granted: true })
  })

  it('supports the brand and campaign golden path with explicit store scope in memory', async () => {
    const base = await start()
    const workspaceId = `ws_brand_campaign_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `golden-store-${workspaceId}`, credentialRef: `fixture://${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, remoteId: 'tb-golden-1', localProductKey: `golden-product-${workspaceId}`, title: '黄金路径商品', stock: 3 })
    const secondTaobaoProduct = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: `golden-product-2-${workspaceId}`, title: '黄金路径商品二', stock: 2 })
    async function call(id: number, method: string, params: Record<string, unknown>) {
      return await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)
    }
    const created = await call(1, 'brand-unit.create', { brand_id: `brand_${workspaceId}`, name: '黄金路径品' })
    expect(created.error).toBeNull()
    expect(created.data).toMatchObject({ result: { id: `brand_${workspaceId}`, storage: 'memory', durable: false, storeBindings: [] } })
    const bound = await call(2, 'brand-unit.bind-store', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, expected_revision: '1' })
    expect(bound.error).toBeNull()
    expect(bound.data).toMatchObject({ result: { brandUnit: { id: `brand_${workspaceId}`, revision: 2, storeBindings: [{ platform: 'taobao', accountId: account.id }] }, durable: false } })
    const stale = await call(2.01, 'brand-unit.bind-store', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, expected_revision: '1' })
    expect(stale.error).toMatchObject({ code: 'BRAND_STORE_REVISION_CONFLICT' })
    const invalidRevision = await call(2.02, 'brand-unit.bind-store', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, expected_revision: '0' })
    expect(invalidRevision.error).toMatchObject({ code: 'INVALID_REQUEST' })
    const jdAccount = service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `golden-jd-${workspaceId}`, credentialRef: `fixture://${workspaceId}/jd` })
    const jdBound = await call(2.1, 'brand-unit.bind-store', { brand_id: `brand_${workspaceId}`, platform: 'jd', account_id: jdAccount.id })
    expect(jdBound.error).toBeNull()
    expect((await call(2.15, 'catalog.facts.confirm', { product_id: product.id })).error).toBeNull()
    const canonical = await call(2.2, 'brand-unit.product.create', { brand_id: `brand_${workspaceId}`, product_id: `canonical_${workspaceId}`, title: '跨平台黄金商品', source_product_id: product.id })
    expect(canonical.error).toBeNull()
    const canonicalId = (canonical.data as { result: { id: string } }).result.id
    const duplicateCanonical = await call(2.21, 'brand-unit.product.create', { brand_id: `brand_${workspaceId}`, product_id: canonicalId, title: '重复商品', source_product_id: product.id })
    expect(duplicateCanonical.error?.code).toBe('CANONICAL_PRODUCT_CONFLICT')
    const taobaoListing = await call(2.3, 'brand-unit.listing.create', { brand_id: `brand_${workspaceId}`, canonical_product_id: canonicalId, listing_id: `listing_${workspaceId}_tb`, platform: 'taobao', account_id: account.id, remote_product_id: 'tb-golden-1' })
    const jdListing = await call(2.4, 'brand-unit.listing.create', { brand_id: `brand_${workspaceId}`, canonical_product_id: canonicalId, platform: 'jd', account_id: jdAccount.id, remote_product_id: 'jd-golden-1' })
    expect(taobaoListing.error).toBeNull()
    expect(jdListing.error).toBeNull()
    const duplicateListing = await call(2.41, 'brand-unit.listing.create', { brand_id: `brand_${workspaceId}`, canonical_product_id: canonicalId, listing_id: `listing_${workspaceId}_tb`, platform: 'taobao', account_id: account.id })
    expect(duplicateListing.error?.code).toBe('LISTING_CONFLICT')
    const listings = await call(2.5, 'brand-unit.listing.list', { brand_id: `brand_${workspaceId}`, canonical_product_id: canonicalId })
    expect(listings.data).toMatchObject({ result: { count: 2, items: expect.arrayContaining([expect.objectContaining({ platform: 'taobao', accountId: account.id }), expect.objectContaining({ platform: 'jd', accountId: jdAccount.id })]) } })
    const jdProduct = service.importProduct({ workspaceId, platform: 'jd', accountId: jdAccount.id, remoteId: 'jd-golden-1', localProductKey: `golden-jd-product-${workspaceId}`, title: '京东黄金路径商品', stock: 2 })
    expect((await call(2.51, 'catalog.facts.confirm', { product_id: jdProduct.id })).error).toBeNull()
    const multiTarget = await call(2.6, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, targets_json: JSON.stringify([{ product_id: product.id, canonical_product_id: canonicalId, listing_id: (taobaoListing.data as { result: { id: string } }).result.id, platform: 'taobao', account_id: account.id }, { product_id: jdProduct.id, canonical_product_id: canonicalId, listing_id: (jdListing.data as { result: { id: string } }).result.id, platform: 'jd', account_id: jdAccount.id }]) })
    expect(multiTarget.error).toBeNull()
    expect(multiTarget.data).toMatchObject({ result: { targets: [{ productId: product.id, canonicalProductId: canonicalId, listingId: (taobaoListing.data as { result: { id: string } }).result.id, platform: 'taobao', accountId: account.id }, { productId: jdProduct.id, canonicalProductId: canonicalId, listingId: (jdListing.data as { result: { id: string } }).result.id, platform: 'jd', accountId: jdAccount.id }], productIds: [product.id, jdProduct.id] } })
    const multiTargetResult = (multiTarget.data as { result: { id: string } }).result
    const multiGenerated = await call(2.7, 'campaign.batch.generate', { campaign_id: multiTargetResult.id })
    expect(multiGenerated.data).toMatchObject({ result: { count: 2, taskIds: [expect.any(String), expect.any(String)] } })
    const canonicalTarget = await call(2.8, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, targets_json: JSON.stringify([{ canonical_product_id: canonicalId, listing_id: (taobaoListing.data as { result: { id: string } }).result.id, platform: 'taobao', account_id: account.id }]) })
    expect(canonicalTarget.error).toBeNull()
    const canonicalTargetResult = (canonicalTarget.data as { result: { id: string } }).result
    const canonicalGenerated = await call(2.9, 'campaign.batch.generate', { campaign_id: canonicalTargetResult.id })
    expect(canonicalGenerated.data).toMatchObject({ result: { count: 1, taskIds: [expect.any(String)] } })
    const crossPlatformCanonical = await call(2.91, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, targets_json: JSON.stringify([{ canonical_product_id: canonicalId, listing_id: (jdListing.data as { result: { id: string } }).result.id, platform: 'jd', account_id: jdAccount.id }]) })
    expect(crossPlatformCanonical.error).toBeNull()
    expect(crossPlatformCanonical.data).toMatchObject({ result: { targets: [{ productId: jdProduct.id, canonicalProductId: canonicalId, listingId: (jdListing.data as { result: { id: string } }).result.id, platform: 'jd', accountId: jdAccount.id }] } })
    const crossPlatformGenerated = await call(2.92, 'campaign.batch.generate', { campaign_id: (crossPlatformCanonical.data as { result: { id: string } }).result.id })
    expect(crossPlatformGenerated.data).toMatchObject({ result: { count: 1, taskIds: [expect.any(String)] } })
    const mismatchedListing = await call(2.95, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, targets_json: JSON.stringify([{ canonical_product_id: canonicalId, listing_id: (taobaoListing.data as { result: { id: string } }).result.id, platform: 'jd', account_id: jdAccount.id }]) })
    expect(mismatchedListing.error?.code).toBe('LISTING_TARGET_MISMATCH')
    const campaign = await call(3, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([product.id]) })
    expect(campaign.error).toBeNull()
    const campaignResult = (campaign.data as { result: { id: string; storage: string; durable: boolean; state: string; revision: number; productIds: string[]; delivery_manifest: { workspaceId: string; campaignId: string; state: string; revision: number; items: Array<{ productId: string }> } } }).result
    expect(campaignResult).toMatchObject({ storage: 'memory', durable: false, state: 'draft', revision: 1, productIds: [product.id] })
    expect(campaignResult.delivery_manifest).toMatchObject({ workspaceId, campaignId: campaignResult.id, state: 'blocked', revision: expect.any(Number), externallyUnverified: true, validation: { valid: false, code: 'CAMPAIGN_ITEM_EVIDENCE_REQUIRED' }, items: [{ productId: product.id, state: 'blocked', nextAction: 'resolve_review' }] })
    expect(JSON.stringify(campaignResult.delivery_manifest)).not.toContain('production_canary')
    expect(JSON.stringify(campaignResult.delivery_manifest)).not.toContain('planned-listing:')
    expect(JSON.stringify(campaignResult.delivery_manifest)).not.toContain('durable://batch_campaigns')
    const campaignList = await call(3.005, 'campaign.batch.list', { platform: 'taobao', account_id: account.id })
    expect(campaignList.error).toBeNull()
    expect(campaignList.data).toMatchObject({ result: { count: expect.any(Number), items: expect.arrayContaining([expect.objectContaining({ id: campaignResult.id, state: 'draft', platform: 'taobao', accountId: account.id, itemCount: 1 })]) } })
    const pauseKey = `campaign-pause-${workspaceId}`
    const paused = await call(3.01, 'campaign.batch.pause', { campaign_id: campaignResult.id, expected_revision: '1', idempotency_key: pauseKey, reason: '运营暂停批次' })
    expect(paused.data).toMatchObject({ result: { id: campaignResult.id, state: 'paused', revision: 2, replayed: false, items: [{ state: 'paused' }], delivery_manifest: { paused: true, state: 'paused', revision: 2 } } })
    const pauseReplay = await call(3.02, 'campaign.batch.pause', { campaign_id: campaignResult.id, expected_revision: '1', idempotency_key: pauseKey, reason: '运营暂停批次' })
    expect(pauseReplay.data).toMatchObject({ result: { state: 'paused', revision: 2, replayed: true } })
    const pauseConflict = await call(3.03, 'campaign.batch.pause', { campaign_id: campaignResult.id, expected_revision: '2', idempotency_key: pauseKey, reason: '复用键但改变意图' })
    expect(pauseConflict.error?.code).toBe('CAMPAIGN_LIFECYCLE_IDEMPOTENCY_CONFLICT')
    const staleResume = await call(3.04, 'campaign.batch.resume', { campaign_id: campaignResult.id, expected_revision: '1', idempotency_key: `campaign-resume-stale-${workspaceId}`, reason: '陈旧 revision 恢复' })
    expect(staleResume.error?.code).toBe('CAMPAIGN_REVISION_CONFLICT')
    const resumedCampaign = await call(3.05, 'campaign.batch.resume', { campaign_id: campaignResult.id, expected_revision: '2', idempotency_key: `campaign-resume-${workspaceId}`, reason: '恢复批次执行' })
    expect(resumedCampaign.data).toMatchObject({ result: { state: 'draft', revision: 3, replayed: false, items: [{ state: 'pending' }], delivery_manifest: { paused: false, revision: 3 } } })
    const idempotencyKey = `campaign-retry-${workspaceId}`
    const firstIdempotent = await call(3.1, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([product.id]), idempotency_key: idempotencyKey })
    const replayIdempotent = await call(3.2, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([product.id]), idempotency_key: idempotencyKey })
    expect(firstIdempotent.error).toBeNull()
    expect(replayIdempotent.data).toMatchObject({ result: { replayed: true, id: (firstIdempotent.data as { result: { id: string } }).result.id } })
    const conflictingIdempotent = await call(3.3, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([secondTaobaoProduct.id]), idempotency_key: idempotencyKey })
    expect(conflictingIdempotent.error?.code).toBe('CAMPAIGN_IDEMPOTENCY_CONFLICT')
    const read = await call(4, 'campaign.batch.get', { campaign_id: campaignResult.id })
    expect(read.error).toBeNull()
    expect(read.data).toMatchObject({ result: { id: campaignResult.id, brandId: `brand_${workspaceId}`, platform: 'taobao', accountId: account.id, productIds: [product.id], state: 'draft', revision: 4, execution: 'plan_only', delivery_manifest: { workspaceId, campaignId: campaignResult.id, state: 'blocked', externallyUnverified: true, revision: 4 }, summary: { total: 1, planned: 1, in_progress: 0 } } })
    // Simulate facts becoming stale after canonical setup; the full batch
    // preflight must fail closed before creating even the first task.
    service.products.get(product.id)!.factsConfirmed = false
    const tasksBeforeBlockedGenerate = [...service.tasks.values()].filter(task => task.workspaceId === workspaceId).length
    const generate = await call(4.5, 'campaign.batch.generate', { campaign_id: campaignResult.id })
    expect(generate.error?.code).toBe('PRODUCT_FACTS_CONFIRMATION_REQUIRED')
    expect(generate.data).toBeNull()
    expect([...service.tasks.values()].filter(task => task.workspaceId === workspaceId)).toHaveLength(tasksBeforeBlockedGenerate)
    const facts = await call(4.55, 'catalog.facts.confirm', { product_id: product.id })
    expect(facts.data).toMatchObject({ result: { resumed_task_ids: [] } })
    const generated = await call(4.56, 'campaign.batch.generate', { campaign_id: campaignResult.id })
    expect(generated.error).toBeNull()
    expect(generated.data).toMatchObject({ result: { campaignId: campaignResult.id, count: 1, taskIds: [expect.any(String)] } })
    const generatedTaskId = (generated.data as { result: { taskIds: string[] } }).result.taskIds[0]!
    service.tasks.get(generatedTaskId)!.state = 'failed_recoverable'
    const failedCampaign = await call(4.51, 'campaign.batch.get', { campaign_id: campaignResult.id })
    const failedRevision = (failedCampaign.data as { result: { revision: number } }).result.revision
    expect(failedCampaign.data).toMatchObject({ result: { state: 'failed', items: [{ state: 'failed' }] } })
    const retriedCampaign = await call(4.52, 'campaign.batch.retry_failed', { campaign_id: campaignResult.id, expected_revision: String(failedRevision), idempotency_key: `campaign-retry-failed-${workspaceId}`, reason: '重试失败商品' })
    expect(retriedCampaign.data).toMatchObject({ result: { state: 'generating', revision: failedRevision + 1, replayed: false, items: [{ state: 'pending' }], delivery_manifest: { paused: false, revision: failedRevision + 1 } } })
    const staleRetry = await call(4.53, 'campaign.batch.retry_failed', { campaign_id: campaignResult.id, expected_revision: String(failedRevision), idempotency_key: `campaign-retry-stale-${workspaceId}`, reason: '陈旧 revision 重试' })
    expect(staleRetry.error?.code).toBe('CAMPAIGN_REVISION_CONFLICT')
    service.tasks.get(generatedTaskId)!.state = 'draft'
    const resumedFacts = await call(4.55, 'catalog.facts.confirm', { product_id: product.id })
    expect(resumedFacts.data).toMatchObject({ result: { resumed_task_ids: expect.arrayContaining([generatedTaskId]) } })
    const resumed = await call(4.6, 'campaign.batch.get', { campaign_id: campaignResult.id })
    expect(resumed.data).toMatchObject({ result: { id: campaignResult.id, state: 'manual_attention', taskIds: [generatedTaskId], items: [expect.objectContaining({ state: 'manual_attention', next_action: 'task.select_direction' })] } })
    const selectedDirection = await call(4.65, 'task.select_direction', { task_id: generatedTaskId, direction_id: 'A' })
    expect(selectedDirection.error).toBeNull()
    const confirmedPlan = await call(4.7, 'task.plan.confirm', { task_id: generatedTaskId, actor_id: 'batch-test' })
    expect(confirmedPlan.error).toBeNull()
    const readyToGenerate = await call(4.75, 'campaign.batch.get', { campaign_id: campaignResult.id })
    expect(readyToGenerate.data).toMatchObject({ result: { state: 'generating', items: [expect.objectContaining({ state: 'generating', next_action: 'content.generate' })] } })
    const generatedContent = await call(4.8, 'content.codex.commit', { task_id: generatedTaskId, body_json: JSON.stringify(generatedDecisionBody('批量生成标题', '批量生成详情', ['已确认卖点'])) })
    expect(generatedContent.error).toBeNull()
    const awaitingReview = await call(4.85, 'campaign.batch.get', { campaign_id: campaignResult.id })
    expect(awaitingReview.data).toMatchObject({ result: { state: 'review_required', items: [expect.objectContaining({ state: 'review_required', next_action: 'content.review' })] } })
    const tooMany = await call(5, 'campaign.batch.create', { brand_id: `brand_${workspaceId}`, platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify(Array.from({ length: 51 }, (_, index) => `product_${index}`)) })
    expect(tooMany.error?.code).toBe('CAMPAIGN_PRODUCT_LIMIT')
  })

  it('fails closed atomically for every canonical read mode when one batch target is unmapped', async () => {
    const base = await start()
    for (const [index, readMode] of (['legacy_shadow', 'dual_verify', 'canonical_read'] as const).entries()) {
      const flagEnvironment = 'test'
      vi.stubEnv('NODE_ENV', 'test')
      const workspaceId = `ws_campaign_preflight_${readMode}_${Date.now()}_${index}`
      const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
      const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `preflight-${workspaceId}`, credentialRef: `fixture://${workspaceId}` })
      const canonicalSource = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: `已绑定商品 ${readMode}` })
      const unmapped = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: `未绑定商品 ${readMode}` })
      const call = (id: number, method: string, params: Record<string, unknown>, role?: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...(role ? { 'x-role': role } : {}), ...(role === 'platform_ops' ? { 'x-ops-workbench': 'platform' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)
      const brandId = `brand_${workspaceId}`
      expect((await call(1, 'catalog.facts.confirm', { product_id: canonicalSource.id })).error).toBeNull()
      expect((await call(1.1, 'catalog.facts.confirm', { product_id: unmapped.id })).error).toBeNull()
      expect((await call(2, 'brand-unit.create', { brand_id: brandId, name: `预检品牌 ${readMode}` })).error).toBeNull()
      expect((await call(2.1, 'brand-unit.bind-store', { brand_id: brandId, platform: 'taobao', account_id: account.id })).error).toBeNull()
      const canonical = await call(3, 'brand-unit.product.create', { brand_id: brandId, product_id: `canonical_${workspaceId}`, title: canonicalSource.title, source_product_id: canonicalSource.id })
      expect(canonical.error).toBeNull()
      expect((await call(3.1, 'brand-unit.listing.create', { brand_id: brandId, canonical_product_id: (canonical.data as { result: { id: string } }).result.id, platform: 'taobao', account_id: account.id, listing_id: `listing_${workspaceId}` })).error).toBeNull()
      const campaign = await call(4, 'campaign.batch.create', { brand_id: brandId, platform: 'taobao', account_id: account.id, product_ids_json: JSON.stringify([canonicalSource.id, unmapped.id]) })
      expect(campaign.error).toBeNull()
      const listedFlags = await call(4.5, 'ops.feature-flags.list', { environment: flagEnvironment, query: 'canonical.product.read_mode' }, 'platform_ops')
      const existingFlag = ((listedFlags.data as { result?: { items?: Array<{ id: string; revision: number; key?: string }> } }).result?.items ?? []).find(flag => flag.key === 'canonical.product.read_mode')
      const flag = await call(5, 'ops.feature-flag.upsert', { ...(existingFlag ? { id: existingFlag.id, expected_revision: String(existingFlag.revision) } : {}), key: 'canonical.product.read_mode', environment: flagEnvironment, description: `campaign preflight ${readMode}`, enabled: 'true', default_value_json: JSON.stringify({ type: 'string', value: 'legacy_shadow' }), targets_json: JSON.stringify([{ type: 'workspace', value: workspaceId, enabled: true, override: { type: 'string', value: readMode } }]), idempotency_key: `campaign-preflight-${workspaceId}`, reason: '验证批量生成全量 canonical 预检' }, 'platform_ops')
      expect(flag.error).toBeNull()
      const before = [...service.tasks.values()].filter(task => task.workspaceId === workspaceId).length
      const generated = await call(6, 'campaign.batch.generate', { campaign_id: (campaign.data as { result: { id: string } }).result.id })
      expect(generated.error?.code).toBe('CANONICAL_PRODUCT_MAPPING_REQUIRED')
      expect(generated.error?.message).toContain('阻断任务创建')
      expect([...service.tasks.values()].filter(task => task.workspaceId === workspaceId)).toHaveLength(before)
      const after = await call(7, 'campaign.batch.get', { campaign_id: (campaign.data as { result: { id: string } }).result.id })
      expect(after.data).toMatchObject({ result: { state: 'draft' } })
      expect((after.data as { result: { taskIds?: string[] } }).result.taskIds).toBeUndefined()
    }
    vi.stubEnv('NODE_ENV', 'test')
  })

  it('credits a recharge exactly once after a verified payment callback', async () => {
    const base = await start()
    const workspaceId = `ws_billing_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const create = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', idempotency_key: `billing-${workspaceId}` } }) }).then(json)
    const order = (create.data as { result: { id: string; amount_cny: string } }).result
    expect((create.data as { result: { paymentUrl: string } }).result.paymentUrl).toContain(`order_id=${encodeURIComponent(order.id)}`)
    const callbackBody = { workspace_id: workspaceId, order_id: order.id, provider_trade_id: `wx-${workspaceId}`, amount_fen: Math.round(Number(order.amount_cny) * 100), state: 'SUCCESS' }
    const forgedFailure = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...callbackBody, order_id: 'missing-order', state: 'failed' }) }).then(json)
    expect(forgedFailure.error?.code).toBe('BILLING_ORDER_NOT_FOUND')
    const wrongFailureAmount = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...callbackBody, amount_fen: callbackBody.amount_fen + 1, state: 'failed' }) }).then(json)
    expect(wrongFailureAmount.error?.code).toBe('BILLING_CALLBACK_AMOUNT_MISMATCH')
    const first = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callbackBody) }).then(json)
    expect(first.error).toBeNull()
    const replay = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callbackBody) }).then(json)
    expect(replay.error).toBeNull()
    const wrongChannel = await fetch(`${base}/v1/billing/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callbackBody) }).then(json)
    expect(wrongChannel.error?.code).toBe('PAYMENT_CALLBACK_CHANNEL_MISMATCH')
    const conflictingTrade = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...callbackBody, provider_trade_id: `${callbackBody.provider_trade_id}-other` }) }).then(json)
    expect(conflictingTrade.error?.code).toBe('PAYMENT_CALLBACK_REPLAY_CONFLICT')
    const conflictingIntent = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2.1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '11.00', idempotency_key: `billing-${workspaceId}` } }) }).then(json)
    expect(conflictingIntent.error?.code).toBe('BILLING_ORDER_IDEMPOTENCY_CONFLICT')
    const status = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.status', params: { workspace_id: workspaceId } }) }).then(json)
    expect((status.data as { result: { balance_cny: string; model_access: { ownership: string; user_key_required: boolean; access_state: string }; action_entitlement: { overage_policy: string }; capability_entitlements: { balance: { state: string }; package_quota: { state: string }; generation: { state: string; code: string }; platform_publish: { state: string } }; plugin_access: { unlocked: boolean; unlocks: string[] } } }).result).toMatchObject({ balance_cny: '10.00', model_access: { ownership: 'platform', user_key_required: false, access_state: 'included_quota_available' }, action_entitlement: { overage_policy: 'wallet' }, capability_entitlements: { balance: { state: 'available' }, package_quota: { state: 'available' }, generation: { state: 'blocked', code: 'model_configuration' }, platform_publish: { state: 'blocked' } }, plugin_access: { unlocked: true, unlocks: expect.arrayContaining(['图片/OCR解析', '创意Brief与预览', 'SEO/GEO标题', '发布任务']) } })
    const unlockedStart = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2.5, method: 'merchant.start', params: { workspace_id: workspaceId } }) }).then(json)
    const unlockedCards = (unlockedStart.data as { result: { wallet: { unlocked: boolean }; cards: Array<{ id: string; capabilityGate?: { unlocked: boolean; method: string } }> } }).result
    expect(unlockedCards.wallet).toMatchObject({ unlocked: true })
    for (const cardId of ['content', 'visuals', 'review-publish', 'bulk-publish']) expect(unlockedCards.cards.find(card => card.id === cardId)?.capabilityGate).toMatchObject({ unlocked: true, method: 'billing.status' })
    const orderList = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'x-actor-id': 'finance_1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2.8, method: 'billing.recharge.list', params: { workspace_id: workspaceId, states: 'paid', limit: '10', scope: 'workspace' } }) }).then(json)
    expect(orderList.error).toBeNull()
    expect(orderList.data?.result).toMatchObject({ summary: { pending: 0, paid: 1, closed: 0, failed: 0 }, returned: 1, total: 1, orders: [{ id: order.id, workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', state: 'paid', provider_trade_id: callbackBody.provider_trade_id }] })
    const transactions = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'billing.transactions', params: { workspace_id: workspaceId } }) }).then(json)
    expect((transactions.data as { result: { transactions: unknown[] } }).result.transactions).toHaveLength(1)
  })

  it('reports exact recharge totals beyond the 100-row display limit', async () => {
    const base = await start()
    const workspaceId = `ws_billing_volume_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_volume' }
    for (const index of Array.from({ length: 101 }, (_, value) => value)) {
      await fetch(`${base}/mcp`, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'alipay', amount_cny: '1.00', idempotency_key: `volume-${workspaceId}-${index}` } }),
      }).then(json)
    }
    const listed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 200, method: 'billing.recharge.list', params: { workspace_id: workspaceId, states: 'pending', limit: '10' } }) }).then(json)
    expect(listed.error).toBeNull()
    expect(listed.data?.result).toMatchObject({ summary: { pending: 101, paid: 0, closed: 0, failed: 0 }, returned: 10, total: 101 })
    expect((listed.data as { result: { orders: unknown[] } }).result.orders).toHaveLength(10)
  })

  it('serializes concurrent provider checkout creation for one idempotency key', async () => {
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
    vi.stubEnv('PAYMENT_REFUND_ENABLED', 'true')
    const workspaceId = `ws_recharge_concurrent_${Date.now()}`
    const idempotencyKey = `recharge-concurrent-${workspaceId}`
    let checkoutCalls = 0
    setPaymentProviderForTests({
      createCheckout: async () => {
        checkoutCalls += 1
        return { paymentUrl: 'https://payments.example/pay/order' }
      },
      refund: async () => ({ providerRefundId: 'unused-refund' }),
    })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const request = () => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', idempotency_key: idempotencyKey } }) }).then(json)
    const [first, second] = await Promise.all([request(), request()])
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect(checkoutCalls).toBe(1)
    expect((first.data as { result: { id: string } }).result.id).toBe((second.data as { result: { id: string } }).result.id)
  })

  it('serializes concurrent subscription checkout creation and coupon redemption', async () => {
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    const workspaceId = `ws_subscription_concurrent_${Date.now()}`
    let checkoutCalls = 0
    setPaymentProviderForTests({
      createCheckout: async () => { checkoutCalls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { paymentUrl: 'https://payments.example/pay/subscription' } },
      refund: async () => ({ providerRefundId: 'unused-refund' }),
    })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }
    const call = (id: number, method: string, params: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)
    expect((await call(1, 'ops.commercial.offer.upsert', { code: 'concurrent', name: 'Concurrent', billing_cycle: 'monthly', price_cny: '100.00', included_stores: '1', included_tasks: '10', reason: 'test' })).error).toBeNull()
    expect((await call(2, 'ops.commercial.coupon.upsert', { code: 'CONCURRENT10', discount_type: 'percent', discount_value: '10.00', max_redemptions: '1', reason: 'test' })).error).toBeNull()
    const params = { plan_code: 'concurrent', billing_cycle: 'monthly', channel: 'alipay', coupon_code: 'CONCURRENT10', idempotency_key: `subscription-${workspaceId}` }
    const [first, second] = await Promise.all([call(3, 'subscription.order.create', params), call(4, 'subscription.order.create', params)])
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect(checkoutCalls).toBe(1)
    expect((first.data as { result: { orderNo: string; paymentAmountCny: number } }).result).toMatchObject({ orderNo: expect.any(String), paymentAmountCny: 90 })
    expect((second.data as { result: { orderNo: string } }).result.orderNo).toBe((first.data as { result: { orderNo: string } }).result.orderNo)
  })

  it('validates offer validity, requires an audit reason, and preserves optimistic revisions', async () => {
    const base = await start()
    const workspaceId = `ws_offer_contract_${Date.now()}`
    const code = `offer-contract-${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'platform_ops_1' }
    const call = (id: number, params: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ops.commercial.offer.upsert', params: { workspace_id: workspaceId, code, name: 'Contract Offer', billing_cycle: 'monthly', price_cny: '199.00', included_stores: '1', included_tasks: '30', ...params } }) }).then(json)

    expect((await call(1, { valid_from: '2026-09-01T00:00:00Z' })).error?.code).toBe('INVALID_REQUEST')
    expect((await call(2, { valid_from: '2026-09-01T00:00:00Z', valid_to: '2026-08-01T00:00:00Z', reason: '错误日期验证' })).error?.code).toBe('INVALID_REQUEST')
    const created = await call(3, { valid_from: '2026-09-01T00:00:00Z', valid_to: '2027-09-01T00:00:00Z', reason: '首次上架套餐' })
    expect(created.error).toBeNull()
    expect(created.data?.result).toMatchObject({ code, validFrom: '2026-09-01T00:00:00.000Z', validTo: '2027-09-01T00:00:00.000Z', revision: 1 })
    const updated = await call(4, { valid_from: '2026-10-01T00:00:00Z', valid_to: '2027-10-01T00:00:00Z', reason: '调整销售周期', expected_revision: '1' })
    expect(updated.data?.result).toMatchObject({ revision: 2, validFrom: '2026-10-01T00:00:00.000Z' })
    expect((await call(5, { valid_from: '2026-11-01T00:00:00Z', reason: '使用过期版本', expected_revision: '1' })).error).toMatchObject({ code: 'COMMERCIAL_OFFER_REVISION_CONFLICT' })
  })

  it('keeps provider reconciliation explicit when no external query adapter is configured', async () => {
    const base = await start()
    const workspaceId = `ws_reconciliation_${Date.now()}`
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.reconciliation.run', params: { workspace_id: workspaceId, limit: '10' } }) }).then(json)
    expect(response.error).toBeNull()
    expect(response.data?.result).toMatchObject({ state: 'not_configured', checked: 0, settled: [], pending: [], failed: [] })
  })

  it('settles a provider-paid pending wallet order idempotently through reconciliation', async () => {
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
    vi.stubEnv('PAYMENT_REFUND_ENABLED', 'true')
    const workspaceId = `ws_reconciliation_paid_${Date.now()}`
    const providerTradeId = `provider-trade-${workspaceId}`
    setPaymentProviderForTests({
      createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay/order' }),
      refund: async () => ({ providerRefundId: 'refund-1' }),
      queryStatus: async () => ({ state: 'paid', providerTradeId, amountFen: 1000 }),
    })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', idempotency_key: `provider-reconciliation-${workspaceId}` } }) }).then(json)
    expect(created.error).toBeNull()
    const first = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.reconciliation.run', params: { workspace_id: workspaceId, limit: '10' } }) }).then(json)
    expect(first.error).toBeNull()
    expect(first.data?.result).toMatchObject({ state: 'completed', checked: 1, provider_orders: 1, settled: [{ provider_trade_id: providerTradeId }], pending: [], failed: [], idempotent_settlement: true })
    const second = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'billing.reconciliation.run', params: { workspace_id: workspaceId, limit: '10' } }) }).then(json)
    expect(second.error).toBeNull()
    expect(second.data?.result).toMatchObject({ state: 'completed', checked: 0, settled: [], pending: [], failed: [] })
  })

  it('does not settle a paid query when the provider omits the amount', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    vi.stubEnv('PAYMENT_REFUND_ENABLED', 'true')
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
    const workspaceId = `ws_reconciliation_missing_amount_${Date.now()}`
    setPaymentProviderForTests({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay/order' }), refund: async () => ({ providerRefundId: 'refund-1' }), queryStatus: async () => ({ state: 'paid', providerTradeId: 'trade-without-amount' }) })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', idempotency_key: `missing-amount-${workspaceId}` } }) }).then(json)
    expect(created.error).toBeNull()
    const reconciliation = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.reconciliation.run', params: { workspace_id: workspaceId, limit: '10' } }) }).then(json)
    expect(reconciliation.data?.result).toMatchObject({ state: 'attention_required', failed: [{ code: 'PAYMENT_QUERY_AMOUNT_MISMATCH' }] })
    const transactions = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'billing.transactions', params: { workspace_id: workspaceId } }) }).then(json)
    expect((transactions.data?.result as { balance_cny: string }).balance_cny).toBe('0.00')
  })

  it('moves provider-closed recharge orders to a terminal reconciliation state', async () => {
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
    vi.stubEnv('PAYMENT_REFUND_ENABLED', 'true')
    const workspaceId = `ws_reconciliation_closed_${Date.now()}`
    setPaymentProviderForTests({
      createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay/order' }),
      refund: async () => ({ providerRefundId: 'refund-closed' }),
      queryStatus: async () => ({ state: 'closed' }),
    })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'alipay', amount_cny: '10.00', idempotency_key: `provider-closed-${workspaceId}` } }) }).then(json)
    expect(created.error).toBeNull()
    const first = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.reconciliation.run', params: { workspace_id: workspaceId, limit: '10' } }) }).then(json)
    expect(first.error).toBeNull()
    expect(first.data?.result).toMatchObject({ state: 'attention_required', checked: 1, failed: [{ code: 'PAYMENT_PROVIDER_ORDER_CLOSED' }] })
    const second = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'billing.reconciliation.run', params: { workspace_id: workspaceId, limit: '10' } }) }).then(json)
    expect(second.error).toBeNull()
    expect(second.data?.result).toMatchObject({ state: 'completed', checked: 0, settled: [], pending: [], failed: [] })
  })

  it('does not credit a wallet when the provider rejects a refund', async () => {
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    vi.stubEnv('PAYMENT_REFUND_ENABLED', 'true')
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
    vi.stubEnv('NODE_ENV', 'test')
    const workspaceId = `ws_refund_rejected_${Date.now()}`
    setPaymentProviderForTests({
      createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay/order' }),
      refund: async () => ({ providerRefundId: 'refund-rejected', state: 'rejected' }),
    })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', idempotency_key: `refund-rejected-${workspaceId}` } }) }).then(json)
    expect(created.error).toBeNull()
    const order = (created.data as { result: { id: string; amount_cny: string } }).result
    const providerTradeId = `trade-${workspaceId}`
    const callbackCanonical = `${order.id}|${providerTradeId}|1000|SUCCESS`
    const callbackSignature = createHmac('sha256', 'callback-secret').update(callbackCanonical).digest('hex')
    const paid = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { ...headers, 'x-payment-signature': callbackSignature }, body: JSON.stringify({ workspace_id: workspaceId, order_id: order.id, provider_trade_id: providerTradeId, amount_fen: 1000, state: 'SUCCESS' }) }).then(json)
    expect(paid.error).toBeNull()
    const refund = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.refund', params: { workspace_id: workspaceId, order_id: order.id, reason: 'provider reject test' } }) }).then(json)
    expect(refund.error?.code).toBe('PAYMENT_PROVIDER_REFUND_FAILED')
    const transactions = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'billing.transactions', params: { workspace_id: workspaceId } }) }).then(json)
    expect((transactions.data?.result as { balance_cny: string; transactions: Array<{ type: string }> }).balance_cny).toBe('10.00')
    expect((transactions.data?.result as { transactions: Array<{ type: string; description: string }> }).transactions.filter(item => item.type === 'refund')).toEqual([expect.objectContaining({ description: expect.stringContaining('充值退款失败释放预留') })])
  })

  it('deducts an external recharge refund once and leaves no wallet credit on retry', async () => {
    vi.stubEnv('PAYMENT_MODE', 'provider')
    vi.stubEnv('PAYMENT_PROVIDER_ADAPTERS', 'alipay,wechat')
    vi.stubEnv('PAYMENT_CHECKOUT_BASE_URL', 'https://payments.example/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_CHECKOUT_API_URL', 'https://payments.example/api/checkout')
    vi.stubEnv('PAYMENT_PROVIDER_QUERY_API_URL', 'https://payments.example/api/query')
    vi.stubEnv('PAYMENT_PROVIDER_REFUND_API_URL', 'https://payments.example/api/refund')
    vi.stubEnv('PAYMENT_PROVIDER_API_KEY', 'test-provider-key')
    vi.stubEnv('PAYMENT_PROVIDER_MERCHANT_ID', 'merchant-test')
    vi.stubEnv('PAYMENT_CALLBACK_BASE_URL', 'https://merchant.example/v1')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-secret')
    vi.stubEnv('PAYMENT_REFUND_ENABLED', 'true')
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
    vi.stubEnv('NODE_ENV', 'test')
    const workspaceId = `ws_refund_balance_${Date.now()}`
    const providerRefund = vi.fn(async () => ({ providerRefundId: `provider-refund-${workspaceId}`, state: 'completed' }))
    setPaymentProviderForTests({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay/order' }), refund: providerRefund })
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance_1' }
    const call = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(json)
    const created = await call(1, 'billing.recharge.create', { channel: 'wechat', amount_cny: '100.00', idempotency_key: `refund-balance-${workspaceId}` })
    const order = (created.data as { result: { id: string } }).result
    const providerTradeId = `trade-${workspaceId}`
    const callbackSignature = createHmac('sha256', 'callback-secret').update(`${order.id}|${providerTradeId}|10000|SUCCESS`).digest('hex')
    const paid = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers: { ...headers, 'x-payment-signature': callbackSignature }, body: JSON.stringify({ workspace_id: workspaceId, order_id: order.id, provider_trade_id: providerTradeId, amount_fen: 10_000, state: 'SUCCESS' }) }).then(json)
    expect(paid.error).toBeNull()

    const first = await call(2, 'billing.refund', { order_id: order.id, reason: '客户原路退款' })
    expect(first.error).toBeNull()
    expect(first.data?.result).toMatchObject({ type: 'debit', amount_cny: '100.00', replayed: false })
    const replay = await call(3, 'billing.refund', { order_id: order.id, reason: '重复提交' })
    expect(replay.error).toBeNull()
    expect(replay.data?.result).toMatchObject({ type: 'debit', amount_cny: '100.00', replayed: true })
    expect(providerRefund).toHaveBeenCalledOnce()

    const transactions = await call(4, 'billing.transactions', {})
    const wallet = transactions.data?.result as { balance_cny: string; transactions: Array<{ type: string; orderId?: string }> }
    expect(wallet.balance_cny).toBe('0.00')
    expect(wallet.transactions.filter(item => item.type === 'debit' && item.orderId?.startsWith(`recharge-refund:${order.id}:`))).toHaveLength(1)
    expect(wallet.transactions.filter(item => item.type === 'refund')).toHaveLength(0)
  })

  it('opens a paid capability after wallet settlement and does not double-charge an idempotent request', async () => {
    const workspaceId = `ws_wallet_gate_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '钱包门禁测试商品', stock: 10 })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `wallet-gate-store-${workspaceId}`, credentialRef: 'vault://wallet-gate' })
    const token = `wallet-gate-token-${workspaceId}`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const base = await start()

    try {
      vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: 'wallet-gate-user' } }))
      await workspaceMembers.upsert({ workspaceId, externalSubject: 'wallet-gate-user', displayName: '钱包门禁测试', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
      vi.stubEnv('SESSION_ID_HASH_SECRET', 'server-e2e-session-hash-secret')
      const before = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.title.optimize', params: { workspace_id: workspaceId, product_id: product.id, platform: 'taobao', keyword: '春季' } }) }).then(json)
      expect(before.error?.code).toBe('RECHARGE_REQUIRED')

      vi.stubEnv('NODE_ENV', 'test')
      const create = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'wechat', amount_cny: '10.00', idempotency_key: `wallet-gate-${workspaceId}` } }) }).then(json)
      const order = (create.data as { result: { id: string; amount_cny: string } }).result
      const paid = await fetch(`${base}/v1/billing/callback/wechat`, { method: 'POST', headers, body: JSON.stringify({ workspace_id: workspaceId, order_id: order.id, provider_trade_id: `wallet-gate-trade-${workspaceId}`, amount_fen: Math.round(Number(order.amount_cny) * 100), state: 'SUCCESS' }) }).then(json)
      expect(paid.error).toBeNull()

      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
      vi.stubEnv('SESSION_ID_HASH_SECRET', 'server-e2e-session-hash-secret')
      const first = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'wallet-gate-seo-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'catalog.title.optimize', params: { workspace_id: workspaceId, product_id: product.id, platform: 'taobao', keyword: '春季' } }) }).then(json)
      const second = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'wallet-gate-seo-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'catalog.title.optimize', params: { workspace_id: workspaceId, product_id: product.id, platform: 'taobao', keyword: '春季' } }) }).then(json)
      expect(first.error).toBeNull()
      expect(second.error).toBeNull()
      const transactions = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'billing.transactions', params: { workspace_id: workspaceId } }) }).then(json)
      expect((transactions.data as { result: { transactions: Array<{ type: string; description: string }> } }).result.transactions.filter(item => item.type === 'debit' && item.description.includes('SEO/GEO'))).toHaveLength(1)
    } finally {
      vi.stubEnv('NODE_ENV', 'test')
    }
  })

  it('creates a price-snapshotted subscription, activates it after callback, and persists member/audit operations', async () => {
    const base = await start()
    const workspaceId = `ws_subscription_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'operator_1', 'x-role': 'platform_ops' }
    const growthOffer = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ops.commercial.offer.upsert', params: { workspace_id: workspaceId, code: 'growth', name: 'Growth', billing_cycle: 'monthly', price_cny: '599.00', included_stores: '3', included_tasks: '150', reason: '测试套餐' } }) }).then(json)
    expect(growthOffer.error).toBeNull()
    const proOffer = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0.1, method: 'ops.commercial.offer.upsert', params: { workspace_id: workspaceId, code: 'pro', name: 'Pro', billing_cycle: 'monthly', price_cny: '1499.00', included_stores: '10', included_tasks: '500', reason: '测试套餐' } }) }).then(json)
    expect(proOffer.error).toBeNull()
    const tamperedOrder = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0.2, method: 'subscription.order.create', params: { workspace_id: workspaceId, plan_code: 'growth', billing_cycle: 'monthly', plan_name: '伪造套餐', price_cny: '0.01', included_tasks: '999999', idempotency_key: `tampered-${workspaceId}` } }) }).then(json)
    expect(tamperedOrder.error?.code).toBe('INVALID_REQUEST')
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscription.order.create', params: { workspace_id: workspaceId, plan_code: 'growth', billing_cycle: 'monthly', channel: 'alipay', idempotency_key: `sub-${workspaceId}` } }) }).then(json)
    expect(created.error).toBeNull()
    const order = (created.data as { result: { orderNo: string; priceCny: number; status: string } }).result
    expect(order).toMatchObject({ priceCny: 599, status: 'pending', paymentProvider: 'alipay', paymentUrl: expect.stringMatching(/^fixture:\/\//u) })
    const callbackBody = { workspace_id: workspaceId, order_id: order.orderNo, provider_trade_id: `trade-${workspaceId}`, amount_fen: 59900, state: 'SUCCESS' }
    const wrongChannel = await fetch(`${base}/v1/subscriptions/callback/wechat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callbackBody) }).then(json)
    expect(wrongChannel.error).toMatchObject({ code: 'PAYMENT_CALLBACK_CHANNEL_MISMATCH' })
    const paid = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callbackBody) }).then(json)
    expect(paid.error).toBeNull()
    const replay = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callbackBody) }).then(json)
    expect(replay.error).toBeNull()
    expect(replay.data as { replayed: boolean; entitlements_granted: unknown[] }).toMatchObject({ replayed: true, entitlements_granted: [] })
    const conflictingReplay = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...callbackBody, provider_trade_id: `${callbackBody.provider_trade_id}-other` }) }).then(json)
    expect(conflictingReplay.error).toMatchObject({ code: 'SUBSCRIPTION_CALLBACK_REPLAY_CONFLICT' })
    const subscription = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'subscription.get', params: { workspace_id: workspaceId } }) }).then(json)
    expect((subscription.data as { result: { status: string; planCode: string; priceCny: number } }).result).toMatchObject({ status: 'active', planCode: 'growth', priceCny: 599 })
    const member = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ops.member.upsert', params: { workspace_id: workspaceId, external_subject: 'user_1', display_name: '运营一号', role: 'operator', status: 'active', reason: '订阅激活后邀请运营成员' } }) }).then(json)
    expect((member.data as { result: { externalSubject: string; status: string } }).result).toMatchObject({ externalSubject: 'user_1', status: 'active' })
    const users = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3.1, method: 'ops.users.list', params: { workspace_id: workspaceId, query: '运营一号', limit: '20' } }) }).then(json)
    expect((users.data as { result: { total: number; identityCount: number; items: Array<{ workspaceId: string; externalSubject: string; status: string; commercial: { planCode: string; planName: string; subscriptionStatus: string; usedTasks: number; includedTasks: number; remainingTasks: number; walletBalanceCny: string } }> } }).result).toMatchObject({ total: 1, identityCount: 1, items: [expect.objectContaining({ workspaceId, externalSubject: 'user_1', status: 'active', commercial: { planCode: 'growth', planName: 'Growth', subscriptionStatus: 'active', usedTasks: 0, includedTasks: 150, remainingTasks: 150, walletBalanceCny: '0.00' } })] })
    const invalidUserFilter = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3.2, method: 'ops.users.list', params: { workspace_id: workspaceId, status: 'deleted' } }) }).then(json)
    expect(invalidUserFilter.error?.code).toBe('INVALID_REQUEST')
    const suspendedUser = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3.3, method: 'ops.user.suspend', params: { workspace_id: workspaceId, external_subject: 'user_1', expected_revision: '1', reason: '离职访问撤销测试' } }) }).then(json)
    expect((suspendedUser.data as { result: { status: string } }).result.status).toBe('suspended')
    const audit = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ops.audit.list', params: { workspace_id: workspaceId } }) }).then(json)
    expect((audit.data as { result: { records: Array<{ action: string }> } }).result.records.map(item => item.action)).toEqual(expect.arrayContaining(['subscription.order.create', 'subscription.order.paid', 'member.upsert', 'user.suspend']))
    const invalidAuditLimit = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4.1, method: 'ops.audit.list', params: { workspace_id: workspaceId, limit: '0' } }) }).then(json)
    expect(invalidAuditLimit.error?.code).toBe('INVALID_REQUEST')
    const invalidAuditFormat = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4.2, method: 'ops.audit.export', params: { workspace_id: workspaceId, format: 'xml' } }) }).then(json)
    expect(invalidAuditFormat.error?.code).toBe('INVALID_REQUEST')
    const offer = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ops.commercial.offer.upsert', params: { workspace_id: workspaceId, code: 'pro', name: 'Pro', billing_cycle: 'monthly', price_cny: '1499.00', included_stores: '10', included_tasks: '500', reason: '首发套餐' } }) }).then(json)
    expect(offer.error).toBeNull()
    const addon = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ops.commercial.addon.upsert', params: { workspace_id: workspaceId, code: 'image_pack_100', name: '图片生成包', kind: 'image_generation', price_cny: '99.00', units: '100', reason: '高成本能力加购' } }) }).then(json)
    expect((addon.data as { result: { priceCny: number } }).result.priceCny).toBe(99)
    const coupon = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ops.commercial.coupon.upsert', params: { workspace_id: workspaceId, code: 'WELCOME10', discount_type: 'percent', discount_value: '10.00', max_redemptions: '100', reason: '新客优惠' } }) }).then(json)
    expect((coupon.data as { result: { discountValue: number } }).result.discountValue).toBe(10)
    const commercialOrder = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'subscription.order.create', params: { workspace_id: workspaceId, plan_code: 'growth', billing_cycle: 'monthly', channel: 'alipay', coupon_code: 'WELCOME10', addon_codes_json: '["image_pack_100"]', source_channel: 'partner_a', idempotency_key: `commercial-${workspaceId}` } }) }).then(json)
    expect((commercialOrder.data as { result: { priceCny: number; paymentAmountCny: number; includedTasks: number; couponCode: string; addonCodes: string[]; sourceChannel: string } }).result).toMatchObject({ priceCny: 698, paymentAmountCny: 628.2, includedTasks: 150, couponCode: 'WELCOME10', addonCodes: ['image_pack_100'], sourceChannel: 'partner_a' })
    const commercialOrderNo = (commercialOrder.data as { result: { orderNo: string } }).result.orderNo
    const commercialPaid = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId, order_id: commercialOrderNo, provider_trade_id: `commercial-${workspaceId}`, amount_fen: 62820, state: 'SUCCESS' }) }).then(json)
    expect(commercialPaid.error).toBeNull()
    const commercialReplay = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId, order_id: commercialOrderNo, provider_trade_id: `commercial-${workspaceId}`, amount_fen: 62820, state: 'SUCCESS' }) }).then(json)
    expect(commercialReplay.error).toBeNull()
    expect(commercialReplay.data as { replayed: boolean; entitlements_granted: Array<{ addon_code: string; units: number }> }).toMatchObject({ replayed: true, entitlements_granted: [{ addon_code: 'image_pack_100', units: 100 }] })
    const commercialSubscription = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8.1, method: 'subscription.get', params: { workspace_id: workspaceId } }) }).then(json)
    expect((commercialSubscription.data as { result: { entitlements: Array<{ addonCode: string; remainingUnits: number }> } }).result.entitlements).toEqual(expect.arrayContaining([expect.objectContaining({ addonCode: 'image_pack_100', remainingUnits: 100 })]))
    const rollout = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ops.commercial.rollout.upsert', params: { workspace_id: workspaceId, offer_code: 'pro', percentage: '25', enabled: 'true', reason: '灰度验证' } }) }).then(json)
    expect((rollout.data as { result: { percentage: number; enabled: boolean } }).result).toMatchObject({ percentage: 25, enabled: true })
    const initialMarkup = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8.01, method: 'ops.commercial.model-markup.get', params: { workspace_id: workspaceId } }) }).then(json)
    expect((initialMarkup.data as { result: { multiplier: number; revision: number } }).result).toMatchObject({ multiplier: 2.5, revision: 1 })
    const updatedMarkup = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8.02, method: 'ops.commercial.model-markup.update', params: { workspace_id: workspaceId, multiplier: '3.000', expected_revision: '1', reason: '运营倍率回归验证' } }) }).then(json)
    expect((updatedMarkup.data as { result: { multiplier: number; revision: number } }).result).toMatchObject({ multiplier: 3, revision: 2 })
    const staleMarkup = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8.03, method: 'ops.commercial.model-markup.update', params: { workspace_id: workspaceId, multiplier: '4.000', expected_revision: '1', reason: '过期版本' } }) }).then(json)
    expect(staleMarkup.error?.code).toBe('INVALID_REQUEST')
    const crossWorkspaceRollout = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8.1, method: 'ops.commercial.rollout.upsert', params: { workspace_id: workspaceId, target_workspace_id: 'ws_other_tenant', offer_code: 'pro', percentage: '90', enabled: 'true', reason: '越权测试' } }) }).then(json)
    expect(crossWorkspaceRollout.error?.code).toBe('FORBIDDEN')
    const changeRequest = (id: number) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'subscription.change', params: { workspace_id: workspaceId, to_plan_code: 'pro', billing_cycle: 'monthly', channel: 'alipay', reason: '升级套餐', idempotency_key: `change-${workspaceId}` } }) }).then(json)
    const [change, changeReplay] = await Promise.all([changeRequest(9), changeRequest(9.1)])
    expect(change.error).toBeNull()
    expect(changeReplay.error).toBeNull()
    expect((changeReplay.data as { result: { change: { id: string } } }).result.change.id).toBe((change.data as { result: { change: { id: string } } }).result.change.id)
    expect((change.data as { result: { mode: string; order: { priceCny: number; paymentAmountCny: number } } }).result).toMatchObject({ mode: 'upgrade_payment_required', order: { priceCny: 1499, paymentAmountCny: 801 } })
    const upgradeOrder = (change.data as { result: { order: { orderNo: string } } }).result.order
    const upgradePaid = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId, order_id: upgradeOrder.orderNo, provider_trade_id: `upgrade-${workspaceId}`, amount_fen: 80100, state: 'SUCCESS' }) }).then(json)
    expect(upgradePaid.error).toBeNull()
    const upgraded = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'subscription.get', params: { workspace_id: workspaceId } }) }).then(json)
    expect((upgraded.data as { result: { planCode: string; priceCny: number } }).result).toMatchObject({ planCode: 'pro', priceCny: 1499 })
    const funnel = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ops.growth.funnel', params: { workspace_id: workspaceId, source_channel: 'partner_a' } }) }).then(json)
    expect((funnel.data as { result: { counts: Record<string, number> } }).result.counts['subscription.order.created']).toBe(1)
  })

  it('revokes suspended members before the next production MCP operation', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'server-e2e-session-hash-secret')
    const workspaceId = `ws_member_suspend_${Date.now()}`
    const adminToken = `admin-${workspaceId}`
    const memberToken = `member-${workspaceId}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [adminToken]: { actor_id: 'admin_1', workspaces: [workspaceId], roles: ['merchant_admin'] },
      [memberToken]: { actor_id: 'member_1', workspaces: [workspaceId], roles: ['operator'] },
    }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'admin_1', displayName: '成员管理员', role: 'merchant_admin', status: 'active', invitedBy: 'test' })
    const base = await start()
    const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const memberHeaders = { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const upsert = await fetch(`${base}/mcp`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.member.upsert', params: { workspace_id: workspaceId, external_subject: 'member_1', display_name: '暂停测试成员', role: 'operator', status: 'active', reason: '创建权限撤销回归成员' } }) }).then(json)
    expect(upsert.error).toBeNull()
    const suspend = await fetch(`${base}/mcp`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ops.member.suspend', params: { workspace_id: workspaceId, external_subject: 'member_1', expected_revision: '1', reason: '权限审计测试' } }) }).then(json)
    expect(suspend.error).toBeNull()
    const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ops.session', params: { workspace_id: workspaceId } }) }).then(json)
    expect(denied.error?.code).toBe('MEMBER_SUSPENDED')
  })

  it('caps production operations at the persisted member role', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'server-e2e-session-hash-secret')
    const workspaceId = `ws_member_role_${Date.now()}`
    const token = `role-${workspaceId}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { actor_id: 'role_user', workspaces: [workspaceId], roles: ['merchant_admin'] } }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'role_user', displayName: '降权成员', role: 'merchant_admin', status: 'active', invitedBy: 'test' })
    const base = await start()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const enrolled = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.member.upsert', params: { workspace_id: workspaceId, external_subject: 'role_user', display_name: '降权成员', role: 'operator', status: 'active', expected_revision: '1', reason: '验证持久化角色降权' } }) }).then(json)
    expect(enrolled.error).toBeNull()
    const denied = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ops.commercial.offer.upsert', params: { workspace_id: workspaceId, code: 'role-check', name: 'Role Check', billing_cycle: 'monthly', price_cny: '1.00', included_stores: '1', included_tasks: '1', reason: '权限回归' } }) }).then(json)
    expect(denied.error?.code).toBe('FORBIDDEN')
    const deniedRuleWrite = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'rule.publish', params: { workspace_id: workspaceId, pack_id: 'role-check-pack', name: 'Role Check', version: '1.0.0', scope: 'global', source_kind: 'internal', source_reference: '权限回归', source_checked_at: new Date().toISOString(), checks_json: '{"forbiddenTerms":[]}', reason: '权限回归', status: 'draft' } }) }).then(json)
    expect(deniedRuleWrite.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
  })

  it('supports Codex-native content preparation and versioned commit without an external model key', async () => {
    const base = await start()
    const workspaceId = 'ws_demo'
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json)
    const taskId = (taskResponse.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })
    const prepare = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'content.codex.prepare', params: { workspace_id: workspaceId, task_id: taskId } }) }).then(json)
    expect((prepare.data as { result: { confirmedFactVersionId: string; output: { required: string[] } } }).result.output.required).toEqual(['title', 'detail', 'sellingPoints'])
    const commit = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'content.codex.commit', params: { workspace_id: workspaceId, task_id: taskId, body_json: JSON.stringify(generatedDecisionBody('轻云防晒外套', '根据已确认事实生成的详情说明。', ['轻便', '防晒'])) } }) }).then(json)
    expect((commit.data as { result: { state: string; versionVector: { modelId: string } } }).result).toMatchObject({ state: 'review_required', versionVector: { modelId: 'codex-host-session' } })
  })

  it('creates independent platform tasks from a confirmed natural-language request', async () => {
    const base = await start()
    const workspaceId = `ws_request_api_${Date.now()}`
    const taobao = service.importProduct({ workspaceId, platform: 'taobao', title: 'API 淘宝春季商品', stock: 1 })
    const douyin = service.importProduct({ workspaceId, platform: 'douyin', title: 'API 抖音春季商品', stock: 1 })
    const requestText = `请把${taobao.title}和${douyin.title}发布到淘宝和抖音`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': 'api-natural-request-1' }
    const created = await fetch(`${base}/v1/task-requests`, { method: 'POST', headers, body: JSON.stringify({ request_text: requestText }) }).then(json)
    expect(created.error).toBeNull()
    expect((created.data as { mode: string; tasks: Array<{ platform: string; taskGroupId: string }> }).mode).toBe('split_by_platform')
    expect((created.data as { tasks: Array<{ platform: string }> }).tasks.map(task => task.platform).sort()).toEqual(['douyin', 'taobao'])
    const replay = await fetch(`${base}/v1/task-requests`, { method: 'POST', headers, body: JSON.stringify({ request_text: requestText }) }).then(json)
    expect(replay.error).toBeNull()
    expect((replay.data as { replayed: boolean; taskIds: string[] }).replayed).toBe(true)
    expect((replay.data as { taskIds: string[] }).taskIds).toEqual((created.data as { taskIds: string[] }).taskIds)
  })

  it('splits a multi-SKU task through REST without mixing SKU facts', async () => {
    const base = await start()
    const workspaceId = `ws_sku_split_api_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: 'API 多 SKU 商品', skus: [{ id: 'sku-api-a', name: '蓝色/M', price: 99, stock: 3 }, { id: 'sku-api-b', name: '黑色/L', price: 109, stock: 4 }] })
    service.confirmProductFacts(workspaceId, product.id)
    const source = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', requestText: '拆分每个 SKU 的详情交付' })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': 'api-sku-split-1' }
    const response = await fetch(`${base}/v1/tasks/${source.id}/sku-split`, { method: 'POST', headers, body: '{}' }).then(json)
    expect(response.error).toBeNull()
    expect((response.data as { skuIds: string[]; tasks: Array<{ answers: { sku_id: string } }> }).skuIds).toEqual(['sku-api-a', 'sku-api-b'])
    expect((response.data as { tasks: Array<{ answers: { sku_id: string } }> }).tasks.map(task => task.answers.sku_id)).toEqual(['sku-api-a', 'sku-api-b'])
    const replay = await fetch(`${base}/v1/tasks/${source.id}/sku-split`, { method: 'POST', headers, body: '{}' }).then(json)
    expect((replay.data as { replayed: boolean; taskIds: string[] }).replayed).toBe(true)
    expect((replay.data as { taskIds: string[] }).taskIds).toEqual((response.data as { taskIds: string[] }).taskIds)
  })

  it('does not leave partially prepared tasks when batch preparation preflight fails', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const first = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    const second = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    for (const task of [first, second]) {
      service.selectDirection(task.id, 'A')
      const draft = service.createDraft(task.id)
      service.approveContent(task.id, draft.id)
    }
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'publish.batch.prepare', params: { task_ids_json: JSON.stringify([first.id, 'task_missing_for_batch_preflight']) } }) }).then(json)
    expect(response.error?.code).toBe('TASK_NOT_FOUND')
    expect(service.getTask(first.id).state).toBe('approved')
    expect(service.getTask(second.id).state).toBe('approved')
  })

  it('completes batch publish confirmation, pause/resume and failed-item retry', async () => {
    const base = await start()
    const workspaceId = `ws_batch_lifecycle_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const products = [
      service.importProduct({ workspaceId, platform: 'taobao', title: '批量生命周期商品一', stock: 5 }),
      service.importProduct({ workspaceId, platform: 'taobao', title: '批量生命周期商品二', stock: 5 }),
    ]
    for (const product of products) service.confirmProductFacts(workspaceId, product.id)
    const tasks = products.map(product => service.createTask({ workspaceId, productId: product.id, platform: 'taobao' }))
    for (const task of tasks) {
      service.selectDirection(task.id, 'A')
      const draft = service.createDraft(task.id)
      service.approveContent(task.id, draft.id)
    }
    const prepared = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'publish.batch.prepare', params: { workspace_id: workspaceId, task_ids_json: JSON.stringify(tasks.map(task => task.id)) } }) }).then(json)
    expect(prepared.error).toBeNull()
    const preparedResult = (prepared.data as { result: { batchId: string; items: Array<{ task: { id: string }; version: { id: string }; confirmationHash: string; remoteSnapshotHash: string }> } }).result
    const missingBatchId = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'publish.batch.confirm', params: { workspace_id: workspaceId, confirmations_json: '[]' } }) }).then(json)
    expect(missingBatchId.error).toMatchObject({ code: 'INVALID_REQUEST' })
    const first = preparedResult.items[0]!
    const second = preparedResult.items[1]!
    const confirmed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'publish.batch.confirm', params: { workspace_id: workspaceId, batch_id: preparedResult.batchId, confirmations_json: JSON.stringify([
      { task_id: first.task.id, content_version_id: first.version.id, confirmation_hash: first.confirmationHash, remote_snapshot_hash: first.remoteSnapshotHash, idempotency_key: 'batch-life-first' },
      { task_id: second.task.id, content_version_id: second.version.id, confirmation_hash: second.confirmationHash, remote_snapshot_hash: second.remoteSnapshotHash, idempotency_key: 'batch-life-second-failed', confirmation_ticket_nonce_hash: 'a'.repeat(63), confirmation_ticket_intent_hash: 'b'.repeat(64) },
    ]) } }) }).then(json)
    expect((confirmed.data as { result: { batchState: string; succeeded: number; failed: number } }).result).toMatchObject({ batchState: 'partial', succeeded: 1, failed: 1 })
    expect([...service.publishJobs.values()].filter(job => job.workspaceId === workspaceId)).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: preparedResult.batchId, taskId: first.task.id })]))
    expect([...service.publishJobs.values()].some(job => job.workspaceId === workspaceId && job.idempotencyKey === 'batch-life-second-failed')).toBe(false)

    const paused = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'publish.batch.pause', params: { workspace_id: workspaceId, batch_id: preparedResult.batchId, reason: '人工检查失败项' } }) }).then(json)
    expect((paused.data as { result: { state: string; pauseReason: string } }).result).toMatchObject({ state: 'paused', pauseReason: '人工检查失败项' })
    const resumed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'publish.batch.resume', params: { workspace_id: workspaceId, batch_id: preparedResult.batchId } }) }).then(json)
    expect((resumed.data as { result: { state: string } }).result.state).toBe('partial')

    const rejectedRetry = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'publish.batch.retry_failed', params: { workspace_id: workspaceId, batch_id: preparedResult.batchId, confirmations_json: JSON.stringify([{ task_id: second.task.id, content_version_id: second.version.id, confirmation_hash: second.confirmationHash, remote_snapshot_hash: second.remoteSnapshotHash, idempotency_key: 'batch-life-second-retry-rejected', confirmation_ticket_nonce_hash: 'a'.repeat(63), confirmation_ticket_intent_hash: 'b'.repeat(64) }]) } }) }).then(json)
    expect((rejectedRetry.data as { result: { succeeded: number; failed: number; batchState: string; items: Array<{ error?: { code: string } }> } }).result).toMatchObject({ succeeded: 0, failed: 1, batchState: 'partial', items: [{ error: { code: 'INTERACTIVE_CONFIRMATION_TICKET_INVALID' } }] })
    expect([...service.publishJobs.values()].some(job => job.workspaceId === workspaceId && job.idempotencyKey === 'batch-life-second-retry-rejected')).toBe(false)
    const retried = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5.1, method: 'publish.batch.retry_failed', params: { workspace_id: workspaceId, batch_id: preparedResult.batchId, confirmations_json: JSON.stringify([{ task_id: second.task.id, content_version_id: second.version.id, confirmation_hash: second.confirmationHash, remote_snapshot_hash: second.remoteSnapshotHash, idempotency_key: 'batch-life-second-retry' }]) } }) }).then(json)
    expect((retried.data as { result: { succeeded: number; failed: number; batchState: string } }).result).toMatchObject({ succeeded: 1, failed: 0, batchState: 'queued' })
    const fetched = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'publish.batch.get', params: { workspace_id: workspaceId, batch_id: preparedResult.batchId } }) }).then(json)
    const fetchedItems = (fetched.data as { result: { items: Array<{ taskId: string; state: string; contentVersionId?: string; confirmationHash?: string; remoteSnapshotHash?: string }> } }).result.items
    expect(fetchedItems.map(item => item.state)).toEqual(expect.arrayContaining(['queued']))
    expect(fetchedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: first.task.id, contentVersionId: first.version.id, confirmationHash: first.confirmationHash, remoteSnapshotHash: first.remoteSnapshotHash }),
      expect.objectContaining({ taskId: second.task.id, contentVersionId: second.version.id, confirmationHash: second.confirmationHash, remoteSnapshotHash: second.remoteSnapshotHash }),
    ]))
    const audit = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'x-actor-id': 'operator_batch_audit', 'x-role': 'support' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ops.audit.list', params: { workspace_id: workspaceId, limit: '20' } }) }).then(json)
    expect(audit.error).toBeNull()
    expect((audit.data as { result: { records: Array<{ action: string; resourceId: string }> } }).result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'publish.batch.pause', resourceId: preparedResult.batchId }),
      expect.objectContaining({ action: 'publish.batch.resume', resourceId: preparedResult.batchId }),
      expect.objectContaining({ action: 'publish.batch.retry_failed', resourceId: preparedResult.batchId }),
    ]))
  })

  it('exposes module-level content regeneration without replacing sibling modules', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const source = service.createDraft(task.id)
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'content.modify', params: { content_version_id: source.id, module_key: 'cta', reason: '重新生成 CTA' } }) }).then(json)
    expect(response.error).toBeNull()
    expect((response.data as { result: { version: { parentId: string; body: { modules: Array<{ key: string }> } } } }).result.version).toMatchObject({ parentId: source.id })
    expect((response.data as { result: { version: { body: { modules: Array<{ key: string }> } } } }).result.version.body.modules).toHaveLength(source.body.modules?.length ?? 0)
  })

  it('persists tenant-scoped brand and asset metadata without accepting binary secrets', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_brand' }
    const profile = await fetch(`${base}/v1/brand-profile`, { method: 'PUT', headers, body: JSON.stringify({ name: '云朵轻户外', positioning: '城市轻户外', forbidden_terms: ['最强'] }) }).then(json)
    expect((profile.data as { name: string; revision: number }).name).toBe('云朵轻户外')
    const asset = await fetch(`${base}/v1/assets`, { method: 'POST', headers, body: JSON.stringify({ name: 'brand-guide.pdf', mime_type: 'application/pdf', size_bytes: 1024, sha256: 'a'.repeat(64), storage_key: 'quarantine/ws_brand/brand-guide.pdf' }) }).then(json)
    expect((asset.data as { scanStatus: string; rightsStatus: string }).scanStatus).toBe('quarantined')
    expect((asset.data as { rightsStatus: string }).rightsStatus).toBe('pending')
    const listed = await fetch(`${base}/v1/assets`, { headers }).then(json)
    expect((listed.data as unknown[])).toHaveLength(1)
    expect((listed.data as Array<{ display: { primaryStatus: string; nextAction: { method: string } } }>)[0]?.display).toMatchObject({ primaryStatus: 'awaiting_scan', nextAction: { method: 'asset.list' } })
    const paged = await fetch(`${base}/v1/assets?limit=1&offset=0`, { headers }).then(json)
    expect(paged.data).toMatchObject({ items: [expect.objectContaining({ id: (asset.data as { id: string }).id })], total: 1, limit: 1, offset: 0 })
  })

  it('uploads assets into quarantine and only serves them after scan promotion', async () => {
    const base = await start()
    const bytes = new TextEncoder().encode('merchant asset bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const upload = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': 'ws_binary', 'content-type': 'text/plain', 'x-asset-name': 'logo.txt', 'x-asset-sha256': sha256 }, body: bytes }).then(json)
    expect(upload.error).toBeNull()
    const uploaded = upload.data as { id: string; storageKey: string; scanStatus: string; sha256: string }
    expect(uploaded.storageKey).toMatch(/^quarantine\/ws_binary\//)
    expect(uploaded.scanStatus).toBe('quarantined')
    expect(uploaded.sha256).toBe(sha256)

    const wrongDigest = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': 'ws_binary', 'content-type': 'text/plain', 'x-asset-name': 'forged-alias.txt', 'x-asset-sha256': 'a'.repeat(64) }, body: bytes }).then(json)
    expect(wrongDigest.error?.code).toBe('ASSET_DIGEST_MISMATCH')

    const unicodeName = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': 'ws_binary', 'content-type': 'text/plain', 'x-asset-name': encodeURIComponent('商品资料.txt') }, body: bytes }).then(json)
    expect((unicodeName.data as { references: Array<{ name: string }> }).references.map(reference => reference.name)).toContain('商品资料.txt')

    const duplicate = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': 'ws_binary', 'content-type': 'text/plain', 'x-asset-name': 'logo-alias.txt' }, body: bytes }).then(json)
    expect(duplicate.error).toBeNull()
    expect(duplicate.data).toMatchObject({ id: uploaded.id, revision: 5, deduplication: { mode: 'deduplicated', referenceAdded: true, rightsAndScanStatePreserved: true } })
    expect((duplicate.data as { references: Array<{ name: string }> }).references.map(reference => reference.name)).toEqual(['logo.txt', '商品资料.txt', 'logo-alias.txt'])
    const duplicateRetry = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': 'ws_binary', 'content-type': 'TEXT/PLAIN', 'x-asset-name': 'LOGO-ALIAS.TXT' }, body: bytes }).then(json)
    expect(duplicateRetry.data).toMatchObject({ revision: 6, deduplication: { referenceAdded: false } })
    const listedAssets = await fetch(`${base}/v1/assets`, { headers: { 'x-workspace-id': 'ws_binary' } }).then(json)
    expect((listedAssets.data as Array<{ id: string; references: unknown[] }>)).toEqual([expect.objectContaining({ id: uploaded.id, references: expect.arrayContaining([expect.objectContaining({ name: 'logo.txt' }), expect.objectContaining({ name: 'logo-alias.txt' })]) })])

    const blocked = await fetch(`${base}/v1/assets/${uploaded.id}/download`, { headers: { 'x-workspace-id': 'ws_binary' } }).then(json)
    expect(blocked.error?.code).toBe('QUARANTINE_ACCESS_DENIED')
    const promoted = await fetch(`${base}/v1/assets/${uploaded.id}/scan`, { method: 'POST', headers: { 'x-workspace-id': 'ws_binary', 'content-type': 'application/json' }, body: JSON.stringify({ scan_evidence_ref: 'scanner://asset-1' }) }).then(json)
    expect((promoted.data as { scanStatus: string; storageKey: string }).scanStatus).toBe('clean')
    expect((promoted.data as { storageKey: string }).storageKey).toMatch(/^clean\/ws_binary\//)
    const rights = await fetch(`${base}/v1/assets/${uploaded.id}/rights`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_binary' }, body: JSON.stringify({ rights_status: 'approved', rights_scope: 'commercial_authorized', usage_scopes: ['commercial', 'ai_generation'] }) }).then(json)
    expect((rights.data as { rightsStatus: string; rightsScope: string }).rightsStatus).toBe('approved')
    expect((rights.data as { rightsScope: string }).rightsScope).toBe('commercial_authorized')
    const facts = await fetch(`${base}/v1/assets/${uploaded.id}/facts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_binary' }, body: JSON.stringify({ facts: { 用途: '商品资料' }, reason: '商家已核对原始资料' }) }).then(json)
    expect((facts.data as { extractedFacts: { 用途: string }; factsConfirmedBy: string }).extractedFacts.用途).toBe('商品资料')
    expect((facts.data as { factsConfirmedBy: string }).factsConfirmedBy).toBe('merchant')
    const download = await fetch(`${base}/v1/assets/${uploaded.id}/download`, { headers: { 'x-workspace-id': 'ws_binary' } })
    expect(download.status).toBe(200)
    expect(new TextDecoder().decode(new Uint8Array(await download.arrayBuffer()))).toBe('merchant asset bytes')
    const denied = await fetch(`${base}/v1/assets/${uploaded.id}/download`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(denied.error?.code).toBe('ASSET_NOT_FOUND')
  })

  it('treats application/json asset uploads as binary bytes during authorization', async () => {
    const base = await start()
    const bytes = new TextEncoder().encode('[1,2,3]')
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    const upload = await fetch(`${base}/v1/assets/upload`, {
      method: 'POST',
      headers: {
        'x-workspace-id': 'ws_json_asset',
        'content-type': 'application/json',
        'x-asset-name': 'structured-data.json',
        'x-asset-sha256': sha256,
      },
      body: bytes,
    }).then(json)

    expect(upload.error).toBeNull()
    expect(upload.data).toMatchObject({
      sha256,
      sizeBytes: bytes.byteLength,
      mimeType: 'application/json',
      scanStatus: 'quarantined',
    })
  })

  it('automatically re-quarantines and re-enqueues an untrusted duplicate instead of trapping it in blocked state', async () => {
    const base = await start()
    const workspaceId = `ws_asset_rescan_${Date.now()}`
    const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { 'x-workspace-id': workspaceId, 'content-type': 'image/png', 'x-asset-name': 'source.png', 'x-asset-sha256': sha256 }
    const first = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers, body: bytes }).then(json)
    expect(first.error).toBeNull()
    const firstAsset = first.data as { id: string }
    const stale = service.assets.get(firstAsset.id)!
    stale.scanStatus = 'blocked'
    stale.scanVerdict = 'malicious'
    stale.scanReceiptId = 'legacy-receipt'
    stale.scanReceiptDigest = 'a'.repeat(64)
    stale.scanFindings = ['legacy-private-finding']
    stale.rightsStatus = 'approved'
    stale.rightsScope = 'owned'

    const retried = await fetch(`${base}/v1/assets/upload`, {
      method: 'POST',
      headers: { ...headers, 'x-asset-name': 'source-retry.png' },
      body: bytes,
    }).then(json)

    expect(retried.error).toBeNull()
    expect(retried.data).toMatchObject({
      id: firstAsset.id,
      scanStatus: 'quarantined',
      sourceRevision: 2,
      rightsStatus: 'approved',
      rightsScope: 'owned',
      storageKey: expect.stringMatching(new RegExp(`^quarantine/${workspaceId}/`)),
    })
    expect((retried.data as { scanReceiptId?: string }).scanReceiptId).toBeUndefined()
    expect((retried.data as { scanReceiptDigest?: string }).scanReceiptDigest).toBeUndefined()
    expect((retried.data as { scanVerdict?: string }).scanVerdict).toBeUndefined()
    expect((retried.data as { scanFindings?: string[] }).scanFindings).toBeUndefined()
  })

  it('creates a fresh scan revision when a duplicate is still quarantined after its prior scan work terminated', async () => {
    const base = await start()
    const workspaceId = `ws_asset_quarantine_redrive_${Date.now()}`
    const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { 'x-workspace-id': workspaceId, 'content-type': 'image/png', 'x-asset-name': 'quarantined-source.png', 'x-asset-sha256': sha256 }
    const first = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers, body: bytes }).then(json)
    expect(first.error).toBeNull()
    expect(first.data).toMatchObject({ scanStatus: 'quarantined', sourceRevision: 1 })

    const retried = await fetch(`${base}/v1/assets/upload`, {
      method: 'POST',
      headers: { ...headers, 'x-asset-name': 'quarantined-source-retry.png' },
      body: bytes,
    }).then(json)

    expect(retried.error).toBeNull()
    expect(retried.data).toMatchObject({
      id: (first.data as { id: string }).id,
      scanStatus: 'quarantined',
      sourceRevision: 2,
      storageKey: expect.stringMatching(new RegExp(`^quarantine/${workspaceId}/`)),
    })
  })

  it('runs task creation through publish confirmation over HTTP', async () => {
    vi.stubEnv('RELEASE_ID', 'release-e2e')
    vi.stubEnv('RELEASE_GIT_SHA', 'a'.repeat(40))
    vi.stubEnv('RELEASE_MANIFEST_SHA256', 'b'.repeat(64))
    vi.stubEnv('RELEASE_IMAGE_SET_DIGEST', `sha256:${'c'.repeat(64)}`)
    const base = await start()
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: `e2e-http-${Date.now()}`, credentialRef: 'fixture://e2e-http' })
    const health = await fetch(`${base}/healthz`).then(json)
    const release = await fetch(`${base}/releasez`).then(json)
    expect(release.data).toEqual({ ready: true, release: { release_id: 'release-e2e', release_git_sha: 'a'.repeat(40), manifest_sha256: 'b'.repeat(64), image_set_digest: `sha256:${'c'.repeat(64)}` } })
    expect(health.request_id).toMatch(/^req_/)
    expect(health.trace_id).toBe(health.request_id)
    expect(health.workspace_id).toBe('system')
    expect((health.data as { writesEnabled: boolean }).writesEnabled).toBe(false)
    expect((health.data as { capacity: { rateLimit: { mode: string; state: string } } }).capacity.rateLimit).toEqual({ mode: 'process_local', state: 'not_configured' })
    const healthData = health.data as { setup: { mode: string; ai: { contentGeneration: string; imageGeneration: string; imageEditing: string; videoRendering: string }; modelReadiness: { image_edit: { ready: boolean; reasons: string[] }; ocr: { ready: boolean; reasons: string[] }; video: { ready: boolean; reasons: string[] } }; productionGate: boolean; nextActions: string[] }; persistence: { mode: string; ready: boolean } }
    expect(healthData.persistence).toMatchObject({ mode: 'memory', ready: true })
    const setup = healthData.setup
    expect(setup.mode).toBe('local')
    expect(setup.ai.contentGeneration).toBe('not_configured')
    expect(setup.ai.imageGeneration).toBe('not_configured')
    expect(setup.ai.imageEditing).toBe('blocked')
    expect(setup.modelReadiness.image_edit.ready).toBe(false)
    expect(setup.ai.videoRendering).toBe('storyboard_only')
    expect(setup.modelReadiness.ocr.ready).toBe(false)
    expect(setup.modelReadiness.video.ready).toBe(false)
    expect(setup.productionGate).toBe(false)
    expect(setup.nextActions.some(action => action.includes('平台模型中转站'))).toBe(true)
    expect(setup.nextActions.some(action => action.includes('VIDEO_MODEL'))).toBe(true)
    const modelStatus = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'platform.model.status', params: { workspace_id: 'ws_demo' } }) }).then(json)
    expect(modelStatus.data.result.capabilities).toMatchObject({ image_fact_ocr: false, video_rendering: false })
    expect(modelStatus.data.result.model_readiness).toMatchObject({ ocr: { ready: false }, video: { ready: false } })
    const blockedAuth = await fetch(`${base}/v1/platform-accounts/jd/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws_demo', actor_id: 'actor_demo' }) }).then(json)
    expect(blockedAuth.error?.code).toBe('NOT_CONFIGURED')
    const task = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws_demo', product_id: 'prod_fixture_1', platform: 'taobao', account_id: account.id }) }).then(json)
    const taskId = (task.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor-id': 'test-merchant' }, body: JSON.stringify({ expected_version: 2 }) })
    const contentVersionId = service.createDraft(taskId).id
    const usageAudit = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo', 'x-role': 'support' }, body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ops.audit.list', params: { workspace_id: 'ws_demo', limit: '100' } }) }).then(json)
    expect((usageAudit.data as { result: { records: Array<{ action: string }> } }).result.records.map(item => item.action)).toContain('usage.consume')
    await fetch(`${base}/v1/tasks/${taskId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content_version_id: contentVersionId }) })
    const preview = await fetch(`${base}/v1/tasks/${taskId}/publish-preview`, { method: 'POST' }).then(json)
    const previewData = preview.data as { confirmationHash: string; remoteSnapshotHash: string }
    const publish = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-publish-1' }, body: JSON.stringify({ workspace_id: 'ws_demo', task_id: taskId, content_version_id: contentVersionId, confirmation_hash: previewData.confirmationHash, remote_snapshot_hash: previewData.remoteSnapshotHash }) }).then(json)
    expect((publish.data as { state: string }).state).toBe('queued')
    const publishId = (publish.data as { id: string }).id
    const observed = await fetch(`${base}/v1/publish-jobs/${publishId}/observation`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ status: { found: false, state: 'unknown', simulated: false } }) }).then(json)
    expect((observed.data as { state: string }).state).toBe('unknown')
    const unknownPublish = await fetch(`${base}/v1/publish-jobs/${publishId}`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect((unknownPublish.data as { workflow: { status: { user_state: string; terminal: boolean }; next_action: { label: string; reason: string }; recovery: { retryable: boolean; reconciliation_required: boolean } } }).workflow).toMatchObject({ status: { user_state: '发布结果待确认', terminal: false }, next_action: { label: '查询发布状态', reason: '平台最终回执尚未确认，不能重复提交' }, recovery: { retryable: false, reconciliation_required: true } })
    const publishPage = await fetch(`${base}/v1/publish-jobs?limit=1&offset=0`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(publishPage.data).toMatchObject({ items: [expect.objectContaining({ id: publishId })], total: 1, limit: 1, offset: 0 })
    const timeline = await fetch(`${base}/v1/tasks/${taskId}/timeline?limit=200`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(timeline.error).toBeNull()
    expect((timeline.data as Array<{ event_type: string }>).map(item => item.event_type)).toEqual(expect.arrayContaining([
      'task.created', 'task.direction_selected', 'task.plan_confirmed', 'content.approved', 'publish.prepared',
      'publish.requested', 'publish.observation',
    ]))
    const timelineDenied = await fetch(`${base}/v1/tasks/${taskId}/timeline`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(timelineDenied.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect(service.listPublishJobs('ws_demo')).toHaveLength(1)
  })

  it('lists, diffs, restores and downloads immutable content versions within tenant scope', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json)
    const taskId = (taskResponse.data as { id: string }).id
    const directions = await fetch(`${base}/v1/tasks/${taskId}/directions`, { headers }).then(json)
    expect((directions.data as Array<{ id: string }>).map(item => item.id)).toEqual(['A', 'B', 'C'])
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })
    const firstId = service.createDraft(taskId).id
    const review = await fetch(`${base}/v1/content-versions/${firstId}/review`, { headers }).then(json)
    expect(review.error).toBeNull()
    expect((review.data as { blocking: boolean }).blocking).toBe(false)
    const versions = await fetch(`${base}/v1/tasks/${taskId}/content-versions`, { headers }).then(json)
    expect((versions.data as Array<{ version: number }>).map(item => item.version)).toEqual([1])
    const pagedVersions = await fetch(`${base}/v1/tasks/${taskId}/content-versions?limit=1&offset=0`, { headers }).then(json)
    expect(pagedVersions.data).toMatchObject({ items: [expect.objectContaining({ id: firstId })], total: 1, limit: 1, offset: 0 })
    const restored = await fetch(`${base}/v1/content-versions/${firstId}/restore`, { method: 'POST', headers }).then(json)
    expect(restored.error).toBeNull()
    const second = restored.data as { version: { id: string; version: number; parentId: string; state: string } }
    expect(second.version.version).toBe(2)
    expect(second.version.parentId).toBe(firstId)
    expect(second.version.state).toBe('review_required')
    const diff = await fetch(`${base}/v1/content-versions/${second.version.id}/diff?against=${firstId}`, { headers }).then(json)
    expect(diff.error).toBeNull()
    expect((diff.data as { fromVersionId: string; toVersionId: string }).fromVersionId).toBe(firstId)
  const download = await fetch(`${base}/v1/content-versions/${firstId}/export?format=manifest`, { headers })
  expect(download.status).toBe(200)
  expect(download.headers.get('cache-control')).toContain('no-store')
  expect(download.headers.get('pragma')).toBe('no-cache')
    expect(download.headers.get('content-disposition')).toContain('manifest-v1.json')
    const manifest = await download.json() as { publish_receipt: null }
    expect(manifest.publish_receipt).toBeNull()
    const denied = await fetch(`${base}/v1/tasks/${taskId}/content-versions`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(denied.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    const versionDenied = await fetch(`${base}/v1/content-versions/${firstId}/export`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(versionDenied.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
  })

  it('supports asynchronous generation jobs with tenant-scoped result completion', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json)
    const taskId = (taskResponse.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })
    const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'async-generation-1' } }).then(json)
    expect(queued.error).toBeNull()
    expect((queued.data as { state: string; queue_position: number; estimated_wait_seconds: number }).state).toBe('queued')
    expect((queued.data as { queue_position: number; estimated_wait_seconds: number }).queue_position).toBe(1)
    expect((queued.data as { estimated_wait_seconds: number }).estimated_wait_seconds).toBeGreaterThan(0)
    const jobId = (queued.data as { id: string }).id
    const duplicate = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'async-generation-1' } }).then(json)
    expect((duplicate.data as { id: string }).id).toBe(jobId)
    const completed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, { method: 'POST', headers, body: JSON.stringify({ content: generatedDecisionBody('异步标题', '异步详情', ['异步事实卖点']) }) }).then(json)
    expect((completed.data as { state: string }).state).toBe('succeeded')
    expect((completed.data as { contentVersionId: string }).contentVersionId).toMatch(/^cv_/)
    const versions = await fetch(`${base}/v1/tasks/${taskId}/content-versions`, { headers }).then(json)
    expect((versions.data as Array<{ body: { title: string } }>)[0]?.body.title).toBe('异步标题')
    const denied = await fetch(`${base}/v1/generation-jobs/${jobId}`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(denied.error?.code).toBe('GENERATION_JOB_NOT_FOUND')
  })

  it('keeps asynchronous jobs queued until a trusted result arrives', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json)
    const taskId = (taskResponse.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })
    const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': `fixture-async-${Date.now()}` }, body: '{}' }).then(json)
    const jobId = (queued.data as { id: string; state: string }).id
    expect((queued.data as { state: string }).state).toBe('queued')
    const pending = await fetch(`${base}/v1/generation-jobs/${jobId}`, { headers }).then(json)
    expect(pending.data).toMatchObject({ state: 'queued' })
    expect(pending.data).not.toHaveProperty('contentVersionId')
    const completed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, { method: 'POST', headers, body: JSON.stringify({ content: generatedDecisionBody('可信异步标题', '可信异步详情', ['可信异步卖点']) }) }).then(json)
    expect(completed.data).toMatchObject({ state: 'succeeded', contentVersionId: expect.stringMatching(/^cv_/) })
    const versions = await fetch(`${base}/v1/tasks/${taskId}/content-versions`, { headers }).then(json)
    expect((versions.data as Array<{ body: { title: string } }>)[0]?.body.title).toBe('可信异步标题')
  })

  it('exposes workspace job quota backpressure with retry guidance', async () => {
    const base = await start()
    const workspaceId = `ws_quota_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const remoteId = `quota-${Date.now()}`
    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', remote_id: remoteId, title: '配额验收商品', sku_count: 1, stock: 1 }) }).then(json)
    const productId = (imported.data as { id: string }).id
    await fetch(`${base}/v1/products/${productId}/confirm`, { method: 'POST', headers })
    for (let index = 0; index < 3; index += 1) {
      const task = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) }).then(json)
      const taskId = (task.data as { id: string }).id
      await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
      await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })
      const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': `quota-api-${index}` } }).then(json)
      expect((queued.data as { state: string }).state).toBe('queued')
    }
    const fourthTask = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) }).then(json)
    const fourthTaskId = (fourthTask.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${fourthTaskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${fourthTaskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })
    const blockedResponse = await fetch(`${base}/v1/tasks/${fourthTaskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'quota-api-4' } })
    const blocked = await blockedResponse.json() as Envelope<unknown>
    expect(blockedResponse.status).toBe(429)
    expect(blockedResponse.headers.get('retry-after')).toBe('5')
    expect(blocked.error?.code).toBe('WORKSPACE_JOB_QUOTA_EXCEEDED')
  })

  it('records and lists task feedback without allowing cross-workspace access', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json)
    const taskId = (taskResponse.data as { id: string }).id
    const submitted = await fetch(`${base}/v1/tasks/${taskId}/feedback`, { method: 'POST', headers: { ...headers, 'x-actor-id': 'actor_feedback' }, body: JSON.stringify({ rating: 'liked', reason: '事实准确', comment: '可以继续使用' }) }).then(json)
    expect(submitted.error).toBeNull()
    expect(submitted.data).toMatchObject({ taskId, rating: 'liked', actorId: 'actor_feedback' })
    const listed = await fetch(`${base}/v1/tasks/${taskId}/feedback`, { headers }).then(json)
    expect((listed.data as Array<{ id: string }>).map(item => item.id)).toContain((submitted.data as { id: string }).id)
    const denied = await fetch(`${base}/v1/tasks/${taskId}/feedback`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(denied.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
  })

  it('returns one envelope and denies cross-workspace body claims', async () => {
    const base = await start()
    const response = await fetch(`${base}/v1/products`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(Object.keys(response).sort()).toEqual(['data', 'error', 'next_actions', 'request_id', 'trace_id', 'warnings', 'workspace_id'])
    expect(response.error).toBeNull()
    const denied = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ workspace_id: 'ws_other', product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json)
    expect(denied.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect(denied.data).toBeNull()
  })

  it('exposes a six-platform capability evidence matrix without credential material', async () => {
    const base = await start()
    const response = await fetch(`${base}/v1/platform-capabilities`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(response.error).toBeNull()
    const items = (response.data as { items: Array<{ platform: string; capabilities: Array<{ capability: string; state: string }> }> }).items
    expect(items.map(item => item.platform)).toEqual(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'])
    expect(items.every(item => item.capabilities.length === 9)).toBe(true)
    expect(JSON.stringify(response.data)).not.toContain('client_secret')
    expect(JSON.stringify(response.data)).not.toContain('access_token')
  })

  it('rejects publish without a header idempotency key or confirmation token', async () => {
    const base = await start()
    const missingKey = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws_demo', task_id: 'task_missing', content_version_id: 'cv_missing', confirmation_hash: 'x', remote_snapshot_hash: 'y' }) }).then(json)
    expect(missingKey.error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    const missingToken = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'missing-token-1' }, body: JSON.stringify({ workspace_id: 'ws_demo', task_id: 'task_missing', content_version_id: 'cv_missing', remote_snapshot_hash: 'y' }) }).then(json)
    expect(missingToken.error?.code).toBe('INVALID_REQUEST')
    expect(Object.keys(missingToken).sort()).toEqual(['data', 'error', 'next_actions', 'request_id', 'trace_id', 'warnings', 'workspace_id'])
  })

  it('routes legacy MCP methods and rejects illegal or malformed methods', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    for (const method of ['workspace.health', 'catalog.search']) {
      const params = method === 'catalog.search' ? { scope: 'workspace' } : {}
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }) }).then(json)
      expect(response.error).toBeNull()
      expect((response.data as { result: unknown }).result).toBeDefined()
    }
    const missingStoreScope = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'catalog.search', params: {} }) }).then(json)
    expect(missingStoreScope.error).toMatchObject({ code: 'STORE_SELECTION_REQUIRED' })
    const task = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.create', params: { product_id: 'prod_fixture_1', platform: 'taobao' } }) }).then(json)
    const taskResult = (task.data as { result: { id: string; accountId?: string } }).result
    const taskId = taskResult.id
    const approved = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'content.approve', params: { task_id: taskId, content_version_id: 'cv_missing' } }) }).then(json)
    expect(approved.error).not.toBeNull()
    const prepared = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'publish.prepare', params: { task_id: taskId } }) }).then(json)
    expect(prepared.error).not.toBeNull()
    const confirmed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'publish.confirm', params: { task_id: taskId, content_version_id: 'cv_missing', confirmation_hash: 'x', remote_snapshot_hash: 'y' } }) }).then(json)
    expect(confirmed.error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    const illegal = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'admin.raw_sql', params: {} }) }).then(json)
    expect(illegal.error?.code).toBe('MCP_METHOD_NOT_FOUND')
    const extraField = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'catalog.search', params: { raw_sql: 'select 1' } }) }).then(json)
    expect(extraField.error?.code).toBe('INVALID_REQUEST')
    const invalidPlatform = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'task.create', params: { product_id: 'prod_fixture_1', platform: 'aliexpress' } }) }).then(json)
    expect(invalidPlatform.error?.code).toBe('INVALID_REQUEST')
  })

  it('blocks new task creation when operations disables a platform, while allowing history reads after re-enable', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const existingTask = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'task.create', params: { workspace_id: 'ws_demo', product_id: 'prod_fixture_1', platform: 'taobao' } }) }).then(json)
    const existingTaskId = (existingTask.data as { result: { id: string } }).result.id
    const listed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'platform.settings.get', params: { workspace_id: 'ws_demo' } }) }).then(json)
    const taobao = (listed.data as { result: { platforms: Array<{ platform: string; revision: number }> } }).result.platforms.find(item => item.platform === 'taobao')!
    const disabled = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'platform.settings.update', params: { workspace_id: 'ws_demo', platform: 'taobao', enabled: 'false', expected_revision: String(taobao.revision), reason: '平台运维演练' } }) }).then(json)
    expect(disabled.error).toBeNull()
    const blocked = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'task.create', params: { workspace_id: 'ws_demo', product_id: 'prod_fixture_1', platform: 'taobao' } }) }).then(json)
    expect(blocked.error?.code).toBe('PLATFORM_DISABLED')
    const publishBlocked = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'publish.prepare', params: { workspace_id: 'ws_demo', task_id: existingTaskId } }) }).then(json)
    expect(publishBlocked.error?.code).toBe('PLATFORM_DISABLED')
    const restored = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'platform.settings.update', params: { workspace_id: 'ws_demo', platform: 'taobao', enabled: 'true', expected_revision: String((disabled.data as { result: { revision: number } }).result.revision), reason: '平台运维演练结束' } }) }).then(json)
    expect(restored.error).toBeNull()
    const created = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'task.create', params: { workspace_id: 'ws_demo', product_id: 'prod_fixture_1', platform: 'taobao' } }) }).then(json)
    expect(created.error).toBeNull()
  })

  it('serves the human-friendly category library over REST and MCP', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_catalog' }

    const rest = await fetch(`${base}/v1/catalog/categories?query=${encodeURIComponent('防晒')}`, { headers }).then(json)
    expect(rest.error).toBeNull()
    expect(rest.data).toEqual([
      expect.objectContaining({
        code: '1312',
        name: '服装 / 防晒外套',
        fields: expect.arrayContaining(['材质', '成分', '尺码', '颜色']),
        platforms: expect.arrayContaining(['taobao', 'jd', 'pinduoduo']),
        status: 'active',
      }),
    ])

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.categories', params: { query: '鞋' } }),
    }).then(json)
    expect(mcp.error).toBeNull()
    expect((mcp.data as { result: Array<{ category_code: string; required_fields: string[] }> }).result).toEqual([
      expect.objectContaining({ category_code: '1408', required_fields: expect.arrayContaining(['鞋面材质', '闭合方式']) }),
    ])
  })

  it('reports fixture readiness explicitly without promoting it to production evidence', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: {} }) }).then(json)
    const health = (response.data as { result: { plugin: { name: string; version: string }; mcp: { status: string; transport: string }; workspace: { id: string; status: string }; platforms: Array<{ readiness: { ready: boolean; reasons: string[]; mediaUpload: { ready: boolean; configured: boolean; evidence: boolean; reason?: string } }; capabilities: Array<{ state: string }> }> } }).result
    expect(health).toMatchObject({ plugin: { name: 'merchant-marketing', version: '0.1.0' }, mcp: { status: 'ready', transport: '/mcp' }, workspace: { id: 'ws_demo', status: 'ready' } })
    expect(health.platforms).toHaveLength(6)
    const fixtureMode = process.env.CONNECTOR_FIXTURE_MODE === 'true'
    expect(health.platforms.every(item => item.readiness.ready)).toBe(fixtureMode)
    expect(health.platforms.every(item => item.readiness.mediaUpload.ready === false)).toBe(true)
    expect(health.platforms.every(item => item.readiness.mediaUpload.reason)).toBe(true)
    if (fixtureMode) {
      expect(health.platforms.every(item => item.readiness.reasons.includes('FIXTURE_MODE'))).toBe(true)
      expect(health.platforms.every(item => item.capabilities.every(capability => capability.state === 'unverified'))).toBe(true)
    }
  })

  it('can deactivate and reactivate a workspace without deleting its scope', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_lifecycle', 'x-role': 'platform_ops' }
    const call = async (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(json)
    const disabled = await call(1, 'workspace.deactivate', { reason: 'e2e lifecycle' })
    expect(disabled.data).toMatchObject({ result: { status: 'disabled', dataRetained: true } })
    const health = await call(2, 'workspace.health', {})
    expect(health.data).toMatchObject({ result: { workspace: { id: 'ws_lifecycle', status: 'disabled' } } })
    const blocked = await call(3, 'catalog.search', {})
    expect(blocked.error?.code).toBe('WORKSPACE_DISABLED')
    const missingRestoreReason = await call(4, 'workspace.activate', {})
    expect(missingRestoreReason.error?.code).toBe('INVALID_REQUEST')
    const enabled = await call(40, 'workspace.activate', { reason: '客户申诉复核通过' })
    expect(enabled.data).toMatchObject({ result: { status: 'active', dataRetained: true } })
    const audit = await call(41, 'ops.audit.list', { limit: '20' })
    expect((audit.data as { result: { records: Array<{ action: string; reason: string }> } }).result.records.map(item => item.action)).toEqual(expect.arrayContaining(['workspace.deactivate', 'workspace.activate']))
    expect((audit.data as { result: { records: Array<{ action: string; reason: string }> } }).result.records).toContainEqual(expect.objectContaining({ action: 'workspace.activate', reason: '客户申诉复核通过' }))
    const searchable = await call(5, 'catalog.search', { scope: 'workspace' })
    expect(searchable.error).toBeNull()
    expect(searchable.data.result).toMatchObject({ scope: 'workspace', selection: null, products: expect.any(Array) })
  })

  it('runs the complete MCP catalog-to-version workflow with tenant scope', async () => {
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    const base = await start()
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: `e2e-mcp-${Date.now()}`, credentialRef: 'fixture://e2e-mcp' })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const call = async (id: number, method: string, params: Record<string, unknown>, extra: Record<string, string> = {}) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
      return json(response)
    }
    const taskResponse = await call(1, 'task.create', { product_id: 'prod_fixture_1', platform: 'taobao', account_id: account.id })
    const taskId = ((taskResponse.data as { result: { id: string } }).result).id
    const selected = await call(2, 'task.select_direction', { task_id: taskId, direction_id: 'A' })
    expect((selected.data as { result: { state: string } }).result.state).toBe('direction_selected')
    const plan = await call(3, 'task.plan.confirm', { task_id: taskId, actor_id: 'test-merchant', expected_version: '2' })
    expect((plan.data as { result: { state: string; productionPlan: { confirmedBy: string } } }).result).toMatchObject({ state: 'plan_confirmed', productionPlan: { confirmedBy: 'test-merchant' } })
    const generated = await call(4, 'content.codex.commit', { task_id: taskId, body_json: JSON.stringify(generatedDecisionBody('MCP 标题', 'MCP 详情', ['已确认卖点'])) })
    const generatedResult = (generated.data as { result: { id: string; state: string; versionVector: { modelId: string } } }).result
    expect(generatedResult).toMatchObject({ state: 'review_required', versionVector: { modelId: 'codex-host-session' } })
    const versionId = generatedResult.id
    const review = await call(4, 'content.review', { content_version_id: versionId })
    expect((review.data as { result: { blocking: boolean } }).result.blocking).toBe(false)
    const versions = await call(5, 'content.versions', { task_id: taskId })
    expect((versions.data as { result: unknown[] }).result).toHaveLength(1)
    const diff = await call(6, 'content.diff', { content_version_id: versionId })
    expect((diff.data as { result: { toVersionId: string } }).result.toVersionId).toBe(versionId)
    const exported = await call(7, 'content.export', { content_version_id: versionId, format: 'manifest' })
    expect((exported.data as { result: { fileName: string } }).result.fileName).toBe('manifest-v1.json')
    const approved = await call(8, 'content.approve', { task_id: taskId, content_version_id: versionId })
    expect((approved.data as { result: { task: { state: string } } }).result.task.state).toBe('approved')
    const submittedFeedback = await call(9, 'feedback.submit', { task_id: taskId, content_version_id: versionId, rating: 'neutral', reason: '需要观察转化' })
    expect((submittedFeedback.data as { result: { rating: string; taskId: string } }).result).toMatchObject({ rating: 'neutral', taskId })
    const listedFeedback = await call(10, 'feedback.list', { task_id: taskId })
    expect((listedFeedback.data as { result: unknown[] }).result).toHaveLength(1)
    const timeline = await call(10.5, 'task.timeline', { task_id: taskId })
    expect((timeline.data as { result: { events: Array<{ event_type: string }>; workflows: unknown[]; next_action: unknown } }).result.events.map(item => item.event_type)).toEqual(expect.arrayContaining(['task.created', 'task_feedback_submitted']))
    expect((timeline.data as { result: { workflows: unknown[] } }).result.workflows).toEqual([])
    const preview = await call(11, 'publish.prepare', { task_id: taskId })
    const previewData = (preview.data as { result: { confirmationHash: string; remoteSnapshotHash: string } }).result
    const confirmed = await call(12, 'publish.confirm', { task_id: taskId, content_version_id: versionId, confirmation_hash: previewData.confirmationHash, remote_snapshot_hash: previewData.remoteSnapshotHash }, { 'idempotency-key': 'mcp-complete-flow-1' })
    expect((confirmed.data as { result: { state: string } }).result.state).toBe('queued')
    const publishId = ((confirmed.data as { result: { id: string } }).result).id
    await new Promise(resolve => setTimeout(resolve, 100))
    const settled = await call(12.1, 'publish.get', { publish_job_id: publishId })
    const settledResult = (settled.data as { result: { state: string; remoteState?: string; remoteSimulated?: boolean } }).result
    expect((settled.data as { result: { workflow: { kind: string; status: { user_state: string; terminal: boolean }; recovery: { retryable: boolean; reconciliation_required: boolean }; next_action: { label: string } } } }).result.workflow).toMatchObject({ kind: 'publish', status: { user_state: expect.any(String), terminal: false }, recovery: { retryable: false, reconciliation_required: false }, next_action: { label: expect.any(String) } })
    expect(settledResult.state).toBe('queued')
    const crossTenant = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'x-workspace-id': 'ws_other' }, body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'content.review', params: { content_version_id: versionId } }) }).then(json)
    expect(crossTenant.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: publishId, status: { found: true, state: 'rejected', requestId: `cleanup-${publishId}`, simulated: false, rejection: { rawCode: 'TEST_CLEANUP', message: '测试完成后释放活动任务配额', fields: [] } } })
  })

  it('rechecks approved content against the latest platform rules before publish preparation', async () => {
    const base = await start()
    const workspaceId = `ws_publish_rule_refresh_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `rule-refresh-${Date.now()}`, credentialRef: 'fixture://rule-refresh' })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '规则变更测试商品', stock: 10 })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const packId = `publish-refresh-${Date.now()}`
    service.publishRuleVersion({ packId, name: '发布前最新规则', version: '1.0.0', scope: 'platform', targetId: 'taobao', source: { kind: 'internal', reference: 'test://publish-refresh', checkedAt: new Date().toISOString() }, checks: { forbiddenTerms: ['规则变更测试商品'] }, actorId: 'rules-test', reason: '发布前复检回归' })
    service.setRuleStatus({ packId, version: '1.0.0', status: 'active', actorId: 'rules-test', reason: '发布前复检回归' })
    try {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'publish.prepare', params: { task_id: task.id } }) }).then(json)
      expect(response.error).toMatchObject({ code: 'PUBLISH_RULE_REVIEW_BLOCKED' })
      expect(service.getTask(task.id).state).toBe('approved')
    } finally {
      service.setRuleStatus({ packId, version: '1.0.0', status: 'inactive', actorId: 'rules-test', reason: '清理发布前复检回归规则' })
    }
  })

  it('binds OAuth callback state to platform/workspace and rejects replay', async () => {
    const base = await start()
    const state = oauthStates.issue({ workspaceId: 'ws_demo', actorId: 'actor_demo', platform: 'taobao' })
    const mismatch = await fetch(`${base}/v1/oauth/callback/taobao?state=${encodeURIComponent(state)}&code=fixture`, { headers: { 'x-workspace-id': 'ws_other' } }).then(json)
    expect(mismatch.error?.code).toBe('OAUTH_STATE_SCOPE_MISMATCH')
    const noCode = await fetch(`${base}/v1/oauth/callback/taobao?state=${encodeURIComponent(state)}`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(noCode.error?.code).toBe('OAUTH_CODE_REQUIRED')
    const firstValidCallback = await fetch(`${base}/v1/oauth/callback/taobao?state=${encodeURIComponent(state)}&code=fixture`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(firstValidCallback.error?.code).toBe('NOT_CONFIGURED')
    const replay = await fetch(`${base}/v1/oauth/callback/taobao?state=${encodeURIComponent(state)}&code=fixture`, { headers: { 'x-workspace-id': 'ws_demo' } }).then(json)
    expect(replay.error?.code).toBe('OAUTH_STATE_REPLAYED')
  })

  it('preserves platform rejection details and forces correction through a new review version', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: `e2e-rejection-${Date.now()}`, credentialRef: 'fixture://e2e-rejection' })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const source = service.createDraft(task.id)
    service.approveContent(task.id, source.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: source.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `e2e-rejected-${task.id}` })
    const observed = await fetch(`${base}/v1/publish-jobs/${job.id}/observation`, { method: 'POST', headers, body: JSON.stringify({ source: 'reconcile', status: { found: true, state: 'rejected', simulated: false, request_id: 'top-request-27', platform_rejection: { raw_code: 'TOP-27', message: '标题不符合平台规则', fields: [{ path: 'title', raw_code: 'TITLE-LONG', message: '标题最多 60 个字' }] } } }) }).then(json)
    expect(observed.error).toBeNull()
    expect(observed.data).toMatchObject({ state: 'rejected', rejection: { rawCode: 'TOP-27', fields: [{ path: 'title', rawCode: 'TITLE-LONG' }] } })
    const invalid = await fetch(`${base}/v1/publish-jobs/${job.id}/observation`, { method: 'POST', headers, body: JSON.stringify({ status: { found: true, state: 'rejected', platform_rejection: { fields: [] } } }) }).then(json)
    expect(invalid.error?.code).toBe('INVALID_REQUEST')
    const corrected = await fetch(`${base}/v1/content-versions/${source.id}/modify`, { method: 'POST', headers, body: JSON.stringify({ changes: { title: '修正后的短标题' }, reason: 'platform_rejection:TOP-27' }) }).then(json)
    expect(corrected.error).toBeNull()
    expect(corrected.data).toMatchObject({ source: { id: source.id }, version: { parentId: source.id, state: 'review_required', body: { title: '修正后的短标题' } }, task: { state: 'review_required' } })
    expect(service.getContentVersion('ws_demo', source.id).body.title).not.toBe('修正后的短标题')
    expect(service.getPublishJob(job.id).state).toBe('rejected')
  })

  it('requires bearer authentication before workspace scope in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'server-e2e-session-hash-secret')
    try {
      const base = await start()
      const response = await fetch(`${base}/v1/products`).then(json)
      expect(response.error?.code).toBe('UNAUTHENTICATED')
      expect(response.workspace_id).toBe('unknown')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
