import { afterEach, describe, expect, it } from 'vitest'
import { server, service } from './server.js'

type Envelope = { data: any; error: { code?: string; message?: string } | null }
async function start() {
  await new Promise<void>((resolve, reject) => { const onError = (error: Error) => reject(error); server.once('error', onError); server.listen(0, () => { server.removeListener('error', onError); resolve() }) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}
async function call(base: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  return await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json() as Promise<Envelope>)
}

describe('new commercial and operations capabilities', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('exposes social-commerce platforms without promoting them to production capability', async () => {
    const base = await start(); const response = await fetch(`${base}/v1/platform-accounts/xiaohongshu/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_social_fixture' }, body: JSON.stringify({ actor_id: 'merchant' }) }).then(response => response.json() as Promise<Envelope>)
    expect(response.error?.code).not.toBe('NOT_FOUND')
    const health = await call(base, 'ws_social_fixture', 'workspace.health', {})
    expect(health.data.result.connectorReadiness).toHaveProperty('douyin')
    expect(health.data.result.connectorReadiness.douyin.ready).toBe(false)
  })

  it('keeps six-platform authorization and multiple stores isolated by platform account', async () => {
    const base = await start(); const workspaceId = `ws_six_store_scope_${Date.now()}`
    const platforms = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
    const accounts = new Map<string, string>()
    for (const platform of platforms) {
      const account = service.registerPlatformAccount({
        workspaceId, platform, remoteAccountId: `fixture-${platform}-first-store`, credentialRef: `fixture-secret/${platform}/${workspaceId}/first`,
        grantedScopes: ['fixture.product.read', 'fixture.product.write'], accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(), credentialRefreshable: true,
      })
      accounts.set(platform, account.id)
      service.upsertSyncedProducts({ workspaceId, platform, accountId: account.id, items: [{ remoteId: `${platform}-product-first`, title: `${platform} first store product`, sku: [], stock: 10, source: 'fixture' }] })
    }

    const secondSocial = service.registerPlatformAccount({
      workspaceId, platform: 'xiaohongshu', remoteAccountId: 'fixture-xhs-second-store',
      credentialRef: `fixture-secret/xiaohongshu/${workspaceId}/second`, grantedScopes: ['fixture.product.read', 'fixture.product.write'],
      accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(), credentialRefreshable: true,
    })
    service.upsertSyncedProducts({ workspaceId, platform: 'xiaohongshu', accountId: secondSocial.id, items: [{ remoteId: 'xhs-product-second', title: 'xiaohongshu second store product', sku: [], stock: 8, source: 'fixture' }] })
    const uploaded = await call(base, workspaceId, 'catalog.import', { platform: 'xiaohongshu', account_id: secondSocial.id, local_product_key: 'second-store-upload', title: 'second store uploaded product', stock: '4' })
    expect(uploaded.error).toBeNull()
    expect(uploaded.data.result).toMatchObject({ accountId: secondSocial.id, platform: 'xiaohongshu' })
    const restUploaded = await fetch(`${base}/v1/products/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ platform: 'xiaohongshu', account_id: secondSocial.id, local_product_key: 'second-store-rest-upload', title: 'second store REST uploaded product', stock: 3 }) }).then(response => response.json() as Promise<Envelope>)
    expect(restUploaded.error).toBeNull()
    expect(restUploaded.data).toMatchObject({ accountId: secondSocial.id, platform: 'xiaohongshu' })
    const restBatch = await fetch(`${base}/v1/products/import/batch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ products: [{ platform: 'xiaohongshu', account_id: secondSocial.id, local_product_key: 'second-store-rest-batch-a', title: 'REST 批量商品 A', stock: 2 }, { platform: 'douyin', account_id: accounts.get('douyin'), local_product_key: 'douyin-rest-batch', title: '抖音 REST 批量商品', stock: 6 }] }) }).then(response => response.json() as Promise<Envelope>)
    expect(restBatch.error).toBeNull()
    expect(restBatch.data).toMatchObject({ atomic: true, count: 2, products: expect.arrayContaining([expect.objectContaining({ title: 'REST 批量商品 A' }), expect.objectContaining({ title: '抖音 REST 批量商品' })]) })
    const firstMetrics = await call(base, workspaceId, 'workspace.metrics', { platform: 'xiaohongshu', account_id: accounts.get('xiaohongshu') })
    const secondMetrics = await call(base, workspaceId, 'workspace.metrics', { platform: 'xiaohongshu', account_id: secondSocial.id })
    expect(firstMetrics.data.result.selection).toMatchObject({ mode: 'single_store', matchedStores: 1 })
    expect(secondMetrics.data.result.selection).toMatchObject({ mode: 'single_store', matchedStores: 1 })
    expect(firstMetrics.data.result.productSummary.total).toBe(1)
    expect(secondMetrics.data.result.productSummary.total).toBe(4)
    const health = await call(base, workspaceId, 'workspace.health', {})
    const directory = health.data.result.storeDirectory.filter((item: { platform: string }) => item.platform === 'xiaohongshu')
    expect(directory).toHaveLength(2)
    expect(new Set(directory.map((item: { accountId: string }) => item.accountId)).size).toBe(2)
    expect(health.data.result.storeDirectory.filter((item: { platform: string }) => item.platform === 'douyin')).toHaveLength(1)
    const navigationItems = health.data.result.capabilityCards.navigation.items as Array<{ id: string; platform?: string; accountId?: string }>
    expect(navigationItems).toEqual(expect.arrayContaining([
      { id: 'all-stores', title: '全部店铺', scope: 'workspace', action: { method: 'catalog.search', arguments: { scope: 'workspace' } } },
      expect.objectContaining({ id: `store:xiaohongshu:${accounts.get('xiaohongshu')}`, platform: 'xiaohongshu', accountId: accounts.get('xiaohongshu') }),
      expect.objectContaining({ id: `store:xiaohongshu:${secondSocial.id}`, platform: 'xiaohongshu', accountId: secondSocial.id }),
    ]))
  })

  it('returns fact-backed SEO/GEO suggestions with no ranking guarantee', async () => {
    const base = await start(); const workspaceId = `ws_seo_${Date.now()}`
    const imported = await call(base, workspaceId, 'catalog.import', { platform: 'taobao', title: '轻云防晒外套', category: '女装外套', price: '199', stock: '100', attributes_json: JSON.stringify({ material: '锦纶', color: '雾蓝' }), selling_points_json: JSON.stringify([{ id: 'sp1', text: '轻量透气', proof_status: 'confirmed', source_ids: ['asset-1'] }]) })
    const productId = imported.data.result.product_id
    await call(base, workspaceId, 'catalog.facts.confirm', { product_id: productId })
    const optimized = await call(base, workspaceId, 'catalog.title.optimize', { product_id: productId, keyword: '通勤防晒' })
    expect(optimized.error).toBeNull()
    expect(optimized.data.result).toMatchObject({ humanConfirmationRequired: true, rankingGuarantee: false })
    expect(optimized.data.result.suggestions[0]).toMatchObject({ status: 'suggested', rankingGuarantee: false })
    expect(optimized.data.result.suggestions[0].evidence.length).toBeGreaterThan(0)
    const suggestion = optimized.data.result.suggestions[0]
    const accepted = await call(base, workspaceId, 'catalog.title.accept', { product_id: productId, platform: 'taobao', suggestion_id: suggestion.id, title: suggestion.title })
    expect(accepted.error).toBeNull()
    expect(accepted.data.result).toMatchObject({ title: suggestion.title, factsConfirmationRequired: true, humanConfirmed: true, seoGeoAcceptance: { platform: 'taobao', suggestionId: suggestion.id } })
    const stale = await call(base, workspaceId, 'catalog.title.accept', { product_id: productId, platform: 'taobao', suggestion_id: 'seo_geo_stale', title: suggestion.title })
    expect(stale.error).toMatchObject({ code: 'SEO_GEO_SUGGESTION_INVALID' })
  })

  it('executes one-sentence image generation through the configured image path instead of returning only a request shell', async () => {
    const base = await start(); const workspaceId = `ws_multimodal_image_${Date.now()}`
    const imported = await call(base, workspaceId, 'catalog.import', { platform: 'taobao', title: '一句话主图商品', category: '女装', price: '199', stock: '10' })
    const productId = imported.data.result.product_id
    await call(base, workspaceId, 'catalog.facts.confirm', { product_id: productId })
    const generated = await call(base, workspaceId, 'multimodal.generate', { modality: 'image', prompt: '生成清爽白底主图', context_json: JSON.stringify({ brand: { id: 'brand-1', version: '1' }, product: { id: productId, version: String(imported.data.result.version) }, rules: [{ id: 'rule-1', version: '1' }] }) })
    expect(generated.error).toBeNull()
    expect(generated.data.result).toMatchObject({ execution: { status: 'completed', mode: 'simulated', simulated: true, providerExecuted: false }, images: expect.any(Array), image_job_id: expect.any(String), rule_preflight: { blocking: false, finding_count: expect.any(Number), rule_hits: expect.any(Array), findings: expect.any(Array) } })
    const text = await call(base, workspaceId, 'multimodal.generate', { modality: 'text', prompt: '写一条克制的春季卖点', context_json: JSON.stringify({ brand: { id: 'brand-1', version: '1' }, product: { id: productId, version: String(imported.data.result.version) }, rules: [{ id: 'rule-1', version: '1' }] }) })
    expect(text.error).toBeNull()
    expect(text.data.result).toMatchObject({ execution: { status: 'completed', mode: 'simulated', simulated: true, providerExecuted: false }, content: { title: expect.any(String), sellingPoints: expect.any(Array) }, rule_preflight: { blocking: false, rule_hits: expect.any(Array) } })
    const storyboard = await call(base, workspaceId, 'multimodal.video.request', { prompt: '突出轻量透气和通勤场景', output: 'storyboard', context_json: JSON.stringify({ brand: { id: 'brand-1', version: '1' }, product: { id: productId, version: String(imported.data.result.version) }, rules: [{ id: 'rule-1', version: '1' }] }) })
    expect(storyboard.error).toBeNull()
    expect(storyboard.data.result).toMatchObject({ execution: { status: 'completed', mode: 'simulated', simulated: true, providerExecuted: false }, plan: { title: expect.any(String) }, rule_preflight: { blocking: false, rule_hits: expect.any(Array) } })
  })

  it('rejects an invalid video output before wallet debit or generation', async () => {
    const base = await start(); const workspaceId = `ws_invalid_video_output_${Date.now()}`
    const response = await call(base, workspaceId, 'multimodal.video.request', { prompt: '不应执行', output: 'mp4', context_json: JSON.stringify({ brand: { id: 'brand-1', version: '1' }, product: { id: 'missing-product', version: '1' }, rules: [{ id: 'rule-1', version: '1' }] }) })
    expect(response.error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(response.error?.message).toContain('params.output has an unsupported value')
  })

  it('atomically imports multiple products into their explicit platform stores', async () => {
    const base = await start(); const workspaceId = `ws_batch_import_${Date.now()}`
    const taobao = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'batch-taobao-store', credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const douyin = service.registerPlatformAccount({ workspaceId, platform: 'douyin', remoteAccountId: 'batch-douyin-store', credentialRef: `fixture-secret/douyin/${workspaceId}` })
    const imported = await call(base, workspaceId, 'catalog.import.batch', { products_json: JSON.stringify([
      { platform: 'taobao', account_id: taobao.id, local_product_key: 'coat-taobao', title: '淘宝防晒外套', price: 169, stock: 20, skus: [{ id: 'tb-blue-m', name: '蓝色/M', price: 169, stock: 8, attributes: { 颜色: '蓝色', 尺码: 'M' } }] },
      { platform: 'douyin', account_id: douyin.id, local_product_key: 'coat-douyin', title: '抖音防晒外套', price: '159.00', stock: '15', attributes: { 材质: '锦纶' } },
    ]) })
    expect(imported.error).toBeNull()
    expect(imported.data.result).toMatchObject({ atomic: true, count: 2, factsConfirmationRequired: true })
    expect(imported.data.result.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'taobao', accountId: taobao.id, title: '淘宝防晒外套', skus: [expect.objectContaining({ id: 'tb-blue-m' })] }),
      expect.objectContaining({ platform: 'douyin', accountId: douyin.id, title: '抖音防晒外套' }),
    ]))
    const invalid = await call(base, workspaceId, 'catalog.import.batch', { products_json: JSON.stringify([{ platform: 'taobao', account_id: taobao.id, title: '将失败的商品' }, { platform: 'not-platform', account_id: taobao.id, title: '不应写入' }]) })
    expect(invalid.error?.code).toBe('PRODUCT_IMPORT_BATCH_INVALID')
    expect(service.listProducts(workspaceId, { query: '不应写入' })).toHaveLength(0)
    const invalidFacts = await call(base, workspaceId, 'catalog.import.batch', { products_json: JSON.stringify([{ platform: 'taobao', account_id: taobao.id, title: '不应静默修正', price: -1, skus: [{ id: 'sku-negative', name: '异常 SKU', price: -1, stock: -2 }] }]) })
    expect(invalidFacts.error?.code).toBe('PRODUCT_IMPORT_BATCH_INVALID')
    expect(service.listProducts(workspaceId, { query: '不应静默修正' })).toHaveLength(0)
    const existing = service.importProduct({ workspaceId, platform: 'taobao', accountId: taobao.id, localProductKey: 'existing-product', title: '原始商品', price: 99, stock: 5 })
    const failedAfterMutation = await call(base, workspaceId, 'catalog.import.batch', { products_json: JSON.stringify([{ platform: 'taobao', account_id: taobao.id, local_product_key: 'existing-product', title: '不应覆盖原始商品', price: 1 }, { platform: 'douyin', account_id: douyin.id, title: '卖点不完整', selling_points: [{ text: '', source_ids: [] }] }]) })
    expect(failedAfterMutation.error?.code).toBe('SELLING_POINT_PROOF_REQUIRED')
    expect(service.products.get(existing.id)).toMatchObject({ title: '原始商品', price: 99, stock: 5 })
  })

  it('updates product-level and per-SKU facts through the audited MCP boundary', async () => {
    const base = await start(); const workspaceId = `ws_product_update_${Date.now()}`
    const imported = await call(base, workspaceId, 'catalog.import', { platform: 'taobao', title: '待修正外套', price: '199', stock: '3', skus_json: JSON.stringify([{ id: 'sku-a', name: '雾蓝/M', price: 199, stock: 3 }]) })
    const productId = imported.data.result.product_id
    const product = await call(base, workspaceId, 'catalog.product.update', { product_id: productId, title: '已修正防晒外套', images_json: JSON.stringify(['fixture://hero.jpg']), attributes_json: JSON.stringify({ material: '锦纶' }), expected_version: String(imported.data.result.version) })
    expect(product.error).toBeNull(); expect(product.data.result).toMatchObject({ title: '已修正防晒外套', factsConfirmationRequired: true, factsConfirmed: false })
    const sku = await call(base, workspaceId, 'catalog.sku.update', { product_id: productId, sku_id: 'sku-a', price: '209', stock: '7', expected_version: String(product.data.result.version) })
    expect(sku.error).toBeNull(); expect(sku.data.result.skus[0]).toMatchObject({ id: 'sku-a', price: 209, stock: 7 }); expect(sku.data.result.factsConfirmationRequired).toBe(true)
  })

  it('binds uploaded workspace assets to imported products for later image optimization', async () => {
    const base = await start(); const workspaceId = `ws_product_asset_binding_${Date.now()}`
    const asset = service.registerAsset({ workspaceId, name: '商品原图.png', mimeType: 'image/png', sizeBytes: 9, sha256: 'b'.repeat(64), storageKey: `quarantine/${workspaceId}/product.png` })
    const imported = await call(base, workspaceId, 'catalog.import', { platform: 'taobao', title: '素材绑定商品', asset_ids_json: JSON.stringify([asset.id]), stock: '5' })
    expect(imported.error).toBeNull()
    expect(imported.data.result).toMatchObject({ sourceAssetIds: [asset.id], product_id: expect.any(String) })
  })

  it('stores automation policy and scans without unattended resubmission', async () => {
    const base = await start(); const workspaceId = `ws_auto_${Date.now()}`
    const updated = await call(base, workspaceId, 'automation.policy.update', { enabled: 'true', frequency_minutes: '30', retry_limit: '2', reason: '开启每日风险扫描' })
    expect(updated.error).toBeNull(); expect(updated.data.result.unattendedAutoResubmit).toBe(false)
    const tick = await call(base, workspaceId, 'automation.tick', {})
    expect(tick.error).toBeNull(); expect(tick.data.result.unattendedAutoResubmit).toBe(false); expect(tick.data.result.executed).toHaveLength(1)
    const scan = await call(base, workspaceId, 'automation.scan', {})
    expect(scan.error).toBeNull(); expect(scan.data.result.unattendedAutoResubmit).toBe(false); expect(scan.data.result.humanConfirmationRequired).toBe(true); expect(scan.data.result.recommendations).toEqual(expect.any(Array)); expect(scan.data.result.counts).toHaveProperty('alertsUpserted')
    const alerts = await call(base, workspaceId, 'ops.alerts.list', { status: 'open' })
    expect(alerts.error).toBeNull(); expect(Array.isArray(alerts.data.result)).toBe(true)
    const filteredAlerts = await call(base, workspaceId, 'ops.alerts.list', { status: 'open', entity_id: 'does-not-exist' })
    expect(filteredAlerts.error).toBeNull(); expect(filteredAlerts.data.result).toEqual([])
    const invalidAlertFilter = await call(base, workspaceId, 'ops.alerts.list', { platform: 'not-a-platform' })
    expect(invalidAlertFilter.error).toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('enforces the configured manual sync retry limit without auto-resubmitting', async () => {
    const base = await start(); const workspaceId = `ws_auto_retry_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `remote-${workspaceId}`, credentialRef: 'vault://fixture' })
    const policy = await call(base, workspaceId, 'automation.policy.update', { platform: 'taobao', account_id: account.id, enabled: 'true', retry_limit: '1', reason: '仅允许一次人工同步重试' })
    expect(policy.error).toBeNull()
    const source = service.createSyncJob({ workspaceId, platform: 'taobao', accountId: account.id })
    source.state = 'failed'; source.failedItems = [{ id: 'failure-1', pageNumber: 1, code: 'RATE_LIMIT', message: 'temporary', retryable: true, createdAt: new Date().toISOString() }]
    const first = await call(base, workspaceId, 'sync.retry_failed', { job_id: source.id })
    expect(first.error).toBeNull(); expect(first.data.result.jobs[0].retryCount).toBe(1)
    const retryJob = first.data.result.jobs[0]
    retryJob.state = 'failed'; retryJob.failedItems = [{ id: 'failure-2', pageNumber: 1, code: 'RATE_LIMIT', message: 'temporary', retryable: true, createdAt: new Date().toISOString() }]
    const second = await call(base, workspaceId, 'sync.retry_failed', { job_id: retryJob.id })
    expect(second.error).toMatchObject({ code: 'AUTOMATION_RETRY_LIMIT_REACHED' })
  })

  it('allows only one concurrent automation tick per workspace', async () => {
    const base = await start(); const workspaceId = `ws_auto_lease_${Date.now()}`
    process.env.AUTOMATION_TICK_LEASE_TEST_DELAY_MS = '25'
    try {
      const updated = await call(base, workspaceId, 'automation.policy.update', { enabled: 'true', frequency_minutes: '30', reason: '并发租约回归' })
      expect(updated.error).toBeNull()
      const [first, second] = await Promise.all([
        call(base, workspaceId, 'automation.tick', {}),
        call(base, workspaceId, 'automation.tick', {}),
      ])
      expect(first.error).toBeNull(); expect(second.error).toBeNull()
      const results = [first.data.result, second.data.result]
      expect(results.filter(item => item.skipped === true)).toHaveLength(1)
      expect(results.filter(item => item.skipped !== true)).toHaveLength(1)
    } finally {
      delete process.env.AUTOMATION_TICK_LEASE_TEST_DELAY_MS
    }
  })

  it('enforces automation execution windows and records deferred runs', async () => {
    const base = await start(); const workspaceId = `ws_auto_window_${Date.now()}`
    const now = new Date(); const startMinutes = (now.getHours() * 60 + now.getMinutes() + 120) % 1440; const endMinutes = (startMinutes + 1) % 1440
    const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    const updated = await call(base, workspaceId, 'automation.policy.update', { enabled: 'true', window_start: hhmm(startMinutes), window_end: hhmm(endMinutes), reason: '只允许夜间扫描' })
    expect(updated.error).toBeNull(); expect(updated.data.result.policy).toMatchObject({ windowStart: hhmm(startMinutes), windowEnd: hhmm(endMinutes) })
    const tick = await call(base, workspaceId, 'automation.tick', {})
    expect(tick.error).toBeNull(); expect(tick.data.result.executed).toContainEqual(expect.objectContaining({ deferred: true, reason: 'outside_execution_window' }))
    const invalid = await call(base, workspaceId, 'automation.policy.update', { enabled: 'true', window_start: '25:00', reason: '无效窗口' })
    expect(invalid.error?.code).toBe('AUTOMATION_WINDOW_INVALID')
    const cleared = await call(base, workspaceId, 'automation.policy.update', { enabled: 'true', clear_window: 'true', reason: '恢复全天扫描' })
    expect(cleared.error).toBeNull(); expect(cleared.data.result.policy.windowStart).toBeUndefined(); expect(cleared.data.result.policy.windowEnd).toBeUndefined()
  })

  it('requires an existing platform account for store-scoped automation', async () => {
    const base = await start(); const workspaceId = `ws_auto_scope_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'douyin', remoteAccountId: 'douyin-store-a', credentialRef: `fixture-secret/douyin/${workspaceId}` })
    const updated = await call(base, workspaceId, 'automation.policy.update', { platform: 'douyin', account_id: account.id, enabled: 'true', reason: '开启该店铺风险扫描' })
    expect(updated.error).toBeNull(); expect(updated.data.result.policy).toMatchObject({ platform: 'douyin', accountId: account.id, enabled: true })
    const listed = await call(base, workspaceId, 'automation.policy.list', {})
    expect(listed.error).toBeNull(); expect(listed.data.result).toMatchObject({ count: 1, policies: [expect.objectContaining({ platform: 'douyin', accountId: account.id, store: expect.objectContaining({ accountId: account.id }), humanConfirmationRequired: true })] })
    const missingPlatform = await call(base, workspaceId, 'automation.scan', { account_id: account.id })
    expect(missingPlatform.error?.code).toBe('STORE_PLATFORM_REQUIRED')
    const missingAccount = await call(base, workspaceId, 'automation.scan', { platform: 'douyin', account_id: 'not-a-store' })
    expect(missingAccount.error?.code).toBe('PLATFORM_ACCOUNT_NOT_FOUND')
    const scan = await call(base, workspaceId, 'automation.scan', { platform: 'douyin', account_id: account.id })
    expect(scan.error).toBeNull(); expect(scan.data.result.scope).toEqual({ platform: 'douyin', accountId: account.id })
    const paused = await call(base, workspaceId, 'automation.pause', { platform: 'douyin', account_id: account.id, reason: '店铺临时停运' })
    expect(paused.error).toBeNull(); expect(paused.data.result.policy).toMatchObject({ enabled: false, pauseReason: '店铺临时停运' })
    const audit = await call(base, workspaceId, 'ops.audit.list', { limit: '20' })
    expect(audit.data.result.map((item: { action: string }) => item.action)).toContain('automation.policy.pause')
  })

  it('runs scoped catalog sync from automation without publishing', async () => {
    const base = await start(); const workspaceId = `ws_auto_sync_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-sync', credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const updated = await call(base, workspaceId, 'automation.policy.update', { platform: 'taobao', account_id: account.id, enabled: 'true', sync_enabled: 'true', reason: '开启店铺同步和风险巡检' })
    expect(updated.error).toBeNull(); expect(updated.data.result.policy).toMatchObject({ syncEnabled: true, mode: 'scan_sync_alert_manual_retry' })
    const tick = await call(base, workspaceId, 'automation.tick', {})
    expect(tick.error).toBeNull(); expect(tick.data.result.executed[0].syncError).toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(tick.data.result.unattendedAutoResubmit).toBe(false)
    expect(tick.data.result.executed[0]).not.toHaveProperty('publishJobId')
    const afterTick = await call(base, workspaceId, 'automation.policy.get', { platform: 'taobao', account_id: account.id })
    expect(afterTick.error).toBeNull()
    expect(afterTick.data.result.policy).not.toHaveProperty('claimedAt')
  })

  it('surfaces revoked store authorization as an automation risk', async () => {
    const base = await start(); const workspaceId = `ws_auto_reauth_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-reauth', credentialRef: `fixture-secret/taobao/${workspaceId}` })
    await call(base, workspaceId, 'automation.policy.update', { platform: 'taobao', account_id: account.id, enabled: 'true', reason: '开启店铺巡检' })
    service.revokePlatformAccount(workspaceId, account.id, 'taobao')
    const scan = await call(base, workspaceId, 'automation.scan', { platform: 'taobao', account_id: account.id })
    expect(scan.error).toBeNull()
    expect(scan.data.result.risks).toContainEqual(expect.objectContaining({ kind: 'authorization', account_id: account.id }))
    expect(scan.data.result.recommendations).toContainEqual(expect.objectContaining({ kind: 'authorization', method: 'platform.connect', execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }))
    const tick = await call(base, workspaceId, 'automation.tick', {})
    expect(tick.error).toBeNull()
    expect(tick.data.result.executed).toContainEqual(expect.objectContaining({ paused: true, syncSkipped: true, pauseReason: expect.stringContaining('自动暂停') }))
    const policy = await call(base, workspaceId, 'automation.policy.get', { platform: 'taobao', account_id: account.id })
    expect(policy.data.result.policy).toMatchObject({ enabled: false, pauseReason: expect.stringContaining('自动暂停') })
    const audit = await call(base, workspaceId, 'ops.audit.list', { limit: '20' })
    expect(audit.data.result.map((item: { action: string }) => item.action)).toContain('automation.policy.auto_paused')
  })

  it('turns low-stock findings into scoped interactive optimization recommendations', async () => {
    const base = await start(); const workspaceId = `ws_auto_low_stock_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-low-stock', credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '低库存建议测试商品', category: '女装外套', stock: 3 })
    const scan = await call(base, workspaceId, 'automation.scan', { platform: 'taobao', account_id: account.id })
    expect(scan.error).toBeNull()
    expect(scan.data.result.risks).toContainEqual(expect.objectContaining({ kind: 'low_stock', product_id: product.id }))
    expect(scan.data.result.recommendations).toContainEqual(expect.objectContaining({ kind: 'low_stock', method: 'catalog.sync.start', parameters: { platform: 'taobao', account_id: account.id }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }))
  })

  it('runs a scoped risk scan immediately after a sync job completes', async () => {
    const base = await start(); const workspaceId = `ws_auto_post_sync_${Date.now()}`
    const first = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-post-sync-a', credentialRef: `fixture-secret/taobao/${workspaceId}/a` })
    const second = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-post-sync-b', credentialRef: `fixture-secret/taobao/${workspaceId}/b` })
    service.importProduct({ workspaceId, platform: 'taobao', accountId: first.id, title: '同步后低库存商品', stock: 2 })
    service.importProduct({ workspaceId, platform: 'taobao', accountId: second.id, title: '另一店铺缺货商品', stock: 0 })
    const policy = await call(base, workspaceId, 'automation.policy.update', { platform: 'taobao', account_id: first.id, enabled: 'true', reason: '同步完成后立即巡检' })
    expect(policy.error).toBeNull()
    const job = service.createSyncJob({ workspaceId, platform: 'taobao', accountId: first.id })
    const completed = await fetch(`${base}/v1/sync-jobs/${job.id}/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ state: 'succeeded' }) }).then(response => response.json() as Promise<Envelope>)
    expect(completed.error).toBeNull()
    expect(completed.data).toMatchObject({ automation: { triggered: true, scope: { platform: 'taobao', accountId: first.id }, humanConfirmationRequired: true, unattendedAutoResubmit: false } })
    expect(completed.data.automation.risks).toContainEqual(expect.objectContaining({ kind: 'low_stock', account_id: first.id }))
    expect(completed.data.automation.risks).not.toContainEqual(expect.objectContaining({ account_id: second.id }))
    const audit = await call(base, workspaceId, 'ops.audit.list', { limit: '20' })
    expect(audit.data.result).toContainEqual(expect.objectContaining({ action: 'automation.post_sync_scan', resourceId: policy.data.result.policy.id }))
  })

  it('runs the same scoped scan after a published receipt without auto-republishing', async () => {
    const base = await start(); const workspaceId = `ws_auto_post_publish_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-post-publish', credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '发布后低库存商品', stock: 2 })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId, taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `post-publish-${Date.now()}`, accountId: account.id })
    const policy = await call(base, workspaceId, 'automation.policy.update', { platform: 'taobao', account_id: account.id, enabled: 'true', reason: '发布成功后立即巡检' })
    expect(policy.error).toBeNull()
    const observed = await fetch(`${base}/v1/publish-jobs/${job.id}/observation`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ status: { found: true, state: 'published', remote_id: 'remote-post-publish', request_id: 'request-post-publish', simulated: false } }) }).then(response => response.json() as Promise<Envelope>)
    expect(observed.error).toBeNull()
    expect(observed.data).toMatchObject({ remoteState: 'published', automation: { triggered: true, scope: { platform: 'taobao', accountId: account.id }, unattendedAutoResubmit: false } })
    expect(observed.data.automation.risks).toContainEqual(expect.objectContaining({ kind: 'low_stock', product_id: product.id }))
  })

  it('automatically pauses automation when an applicable rule expires', async () => {
    const base = await start(); const workspaceId = `ws_auto_rule_pause_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'taobao-store-rule-pause', credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '规则自动暂停测试商品', category: '女装外套', stock: 3 })
    const packId = `automation-expired-${Date.now()}`
    const version = service.publishRuleVersion({ packId, name: '自动化过期规则', version: '1.0.0', scope: 'category', scopeValue: '女装外套', effectiveTo: '2026-01-01T00:00:00.000Z', source: { kind: 'official', reference: 'manual://automation-expired', checkedAt: '2025-12-01T00:00:00.000Z' }, checks: { forbiddenTerms: ['过期规则'] }, actorId: 'rules-owner', reason: '验证自动化规则失效暂停' })
    service.setRuleStatus({ packId, version: version.version, status: 'active', actorId: 'rules-owner', reason: '启用测试规则' })
    const updated = await call(base, workspaceId, 'automation.policy.update', { platform: 'taobao', account_id: account.id, enabled: 'true', sync_enabled: 'true', reason: '开启规则监控' })
    expect(updated.error).toBeNull()
    const tick = await call(base, workspaceId, 'automation.tick', {})
    expect(tick.error).toBeNull()
    expect(tick.data.result.executed).toContainEqual(expect.objectContaining({ paused: true, syncSkipped: true, pauseReason: expect.stringContaining('自动暂停') }))
    expect(service.listProducts(workspaceId, { query: product.title })).toHaveLength(1)
  })

  it('exposes audited operations queue controls without allowing blind publish replay', async () => {
    const base = await start(); const workspaceId = 'ws_demo'; const product = service.products.get('prod_fixture_1')!
    const generationTask = service.createTask({ workspaceId, productId: product.id, platform: product.platform })
    service.selectDirection(generationTask.id, 'A'); service.confirmProductionPlan(workspaceId, generationTask.id, 'operator')
    const generation = service.enqueueGeneration({ workspaceId, taskId: generationTask.id, idempotencyKey: `ops-retry-${Date.now()}` })
    service.failGeneration({ workspaceId, jobId: generation.id, code: 'PROVIDER_TIMEOUT', message: 'provider timeout' })
    const retried = await call(base, workspaceId, 'ops.marketing.generation.retry', { job_id: generation.id, reason: '运营确认超时后重新入队' })
    expect(retried.error).toBeNull(); expect(retried.data.result).toMatchObject({ id: generation.id, state: 'queued' })
    const assigned = await call(base, workspaceId, 'ops.marketing.queue.assign', { item_type: 'generation', item_id: generation.id, operator_id: 'operator_a', expected_revision: String(retried.data.result.revision), reason: '运营台分配负责人' })
    expect(assigned.error).toBeNull(); expect(assigned.data.result).toMatchObject({ assignedOperatorId: 'operator_a' })

    const visualJob = service.enqueueImageGeneration({ workspaceId, productId: product.id, idempotencyKey: `ops-visual-${Date.now()}`, count: 1 })
    await service.completeImageGeneration({ workspaceId, jobId: visualJob.id })
    const visualRef = `dvis_${'Z'.repeat(24)}`
    service.archiveImageGenerationOutputs(workspaceId, visualJob.id, [{ visualRef, ordinal: 1, storageKey: `quarantine/${workspaceId}/${visualJob.id}/candidate-1.webp`, mimeType: 'image/webp', sizeBytes: 9, sha256: 'z'.repeat(64), createdAt: new Date().toISOString(), reviewStatus: 'unreviewed' }], 'archived')
    const uploadedAsset = service.registerAsset({ workspaceId, name: '待扫描商品图.webp', mimeType: 'image/webp', sizeBytes: 9, sha256: 'a'.repeat(64), storageKey: `quarantine/${workspaceId}/pending/asset.webp` })
    const queue = await call(base, workspaceId, 'ops.marketing.queue', { limit: '20' })
    expect(queue.error).toBeNull(); expect(queue.data.result.visuals).toContainEqual(expect.objectContaining({ visualRef, reviewStatus: 'unreviewed', skuIds: expect.any(Array) }))
    expect(queue.data.result.uploadedAssetRisks).toContainEqual(expect.objectContaining({ id: uploadedAsset.id, readiness: expect.objectContaining({ status: 'draft', reasons: expect.arrayContaining(['等待安全扫描', '等待素材事实解析', '等待商用权益确认', '等待商家确认素材事实']) }), nextAction: expect.objectContaining({ method: 'asset.scan', label: '提交安全扫描结果' }) }))
    const filteredQueue = await call(base, workspaceId, 'ops.marketing.queue', { limit: '20', platform: product.platform, product_id: product.id, state: 'visual_review' })
    expect(filteredQueue.error).toBeNull(); expect(filteredQueue.data.result.filters).toMatchObject({ platform: product.platform, productId: product.id, state: 'visual_review' }); expect(filteredQueue.data.result.visuals).toContainEqual(expect.objectContaining({ visualRef })); expect(filteredQueue.data.result.generation).toHaveLength(0); expect(filteredQueue.data.result.uploadedAssetRisks).toHaveLength(0)
    const invalidFilter = await call(base, workspaceId, 'ops.marketing.queue', { platform: 'not-a-platform' })
    expect(invalidFilter.error).toMatchObject({ code: 'INVALID_REQUEST' })
    const visualReview = await call(base, workspaceId, 'ops.marketing.visual.review', { visual_refs_json: JSON.stringify([visualRef]), status: 'passed', expected_revision: String(visualJob.revision), reason: '运营完成归档候选审查' })
    expect(visualReview.error).toBeNull(); expect(visualReview.data.result).toMatchObject({ status: 'passed', visualRefs: [visualRef] })

    const publishTask = service.createTask({ workspaceId, productId: product.id, platform: product.platform })
    service.selectDirection(publishTask.id, 'A'); const draft = service.createDraft(publishTask.id); service.approveContent(publishTask.id, draft.id)
    const preview = service.preparePublish(publishTask.id)
    const publish = service.confirmPublish({ workspaceId, taskId: publishTask.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `ops-publish-${Date.now()}` })
    service.recordPublishObservation({ workspaceId, publishJobId: publish.id, status: { found: true, state: 'rejected', rejection: { rawCode: 'TOP-1', message: '标题违规', fields: [{ path: 'title', rawCode: 'TITLE', message: '标题违规' }] } } })
    const acknowledged = await call(base, workspaceId, 'ops.marketing.publish.acknowledge', { publish_job_id: publish.id, reason: '读取平台回执，转人工处理' })
    expect(acknowledged.error).toBeNull(); expect(acknowledged.data.result.operatorAcknowledgement.actorId).toBe('actor_demo')
    const revision = await call(base, workspaceId, 'ops.marketing.revision.create', { publish_job_id: publish.id, changes_json: JSON.stringify({ title: '合规新标题' }), reason: '根据平台驳回创建修正版' })
    expect(revision.error).toBeNull(); expect(revision.data.result.version).toMatchObject({ parentId: draft.id, state: 'review_required' })
    const audit = await call(base, workspaceId, 'ops.audit.list', { limit: '20' })
    expect(audit.data.result.map((item: { action: string }) => item.action)).toEqual(expect.arrayContaining(['ops.marketing.generation.retry', 'ops.marketing.queue.assign', 'ops.marketing.visual.review', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create']))
  })
})
