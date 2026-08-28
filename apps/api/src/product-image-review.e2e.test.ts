import { afterEach, beforeAll, describe, expect, it } from 'vitest'

let server: typeof import('./server.js').server
let service: typeof import('./server.js').service

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

describe('product image review API', () => {
  beforeAll(async () => { const module = await import('./server.js'); server = module.server; service = module.service })
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('returns deterministic findings and external verification boundaries', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_image_review' }
    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '主图检查商品', local_product_key: 'image-review', category: '服装', price: 99, stock: 5, images: ['http://unsafe.example/main.jpg'] }) }).then(response => response.json()) as { data: { id: string } }
    const reviewed = await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/image-review`, { headers: { 'x-workspace-id': 'ws_image_review' } }).then(response => response.json()) as { data: { findings: Array<{ code: string; severity: string }>; externallyUnverified: string[] } }
    expect(reviewed.data.findings).toEqual([expect.objectContaining({ code: 'IMAGE_URL_INVALID', severity: 'error' })])
    expect(reviewed.data.externallyUnverified).toContain('尺寸/清晰度')
  })

  it('generates, stores and reviews main-image variants through MCP', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.image.generate', params: { product_id: 'prod_fixture_1', count: '2', direction: '白底主图' } }),
    }).then(value => value.json()) as { data: { result: { job_id: string; execution: { mode: string; simulated: boolean; providerExecuted: boolean; label: string }; job: { state: string; artifactRole: string; archiveState: string; candidates: Array<{ visualRef: string }> }; product: { images?: string[] }; images: string[]; review: unknown[] } } }
    expect(response.data.result.execution).toMatchObject({ mode: 'simulated', simulated: true, providerExecuted: false, label: '本地演示图片，未调用图片模型' })
    expect(response.data.result.job.state).toBe('succeeded')
    expect(response.data.result.job).toMatchObject({ artifactRole: 'candidate', archiveState: 'archived' })
    expect(response.data.result.images).toHaveLength(2)
    expect(response.data.result.product.images).not.toEqual(response.data.result.images)
    expect(response.data.result.images[0]).toMatch(/^data:image\/webp;base64,/u)
    expect(response.data.result.review).toEqual([])
    expect(JSON.stringify(response.data.result.job)).not.toMatch(/storageKey|sha256|data:image/u)

    const historical = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'catalog.image.get', params: { visual_ref: response.data.result.job.candidates[0]!.visualRef } }),
    }).then(value => value.json()) as { data: { result: { images: string[]; historicalCandidate: boolean; platformPublished: boolean } } }
    expect(historical.data.result).toMatchObject({ historicalCandidate: true, platformPublished: false })
    expect(historical.data.result.images).toHaveLength(1)

    const reviewedDelimited = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'catalog.image.review', params: { product_id: 'prod_fixture_1', images: response.data.result.images.join(',') } }),
    }).then(value => value.json()) as { data: { result: { images: string[]; findings: unknown[] } } }
    expect(reviewedDelimited.data.result.images).toHaveLength(2)
    expect(reviewedDelimited.data.result.findings).toEqual([])

    const reviewedJson = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'catalog.image.review', params: { product_id: 'prod_fixture_1', images: JSON.stringify(response.data.result.images) } }),
    }).then(value => value.json()) as { data: { result: { images: string[]; findings: unknown[] } } }
    expect(reviewedJson.data.result.images).toHaveLength(2)
    expect(reviewedJson.data.result.findings).toEqual([])
  })

  it('rejects an explicitly selected platform or store that conflicts with the product', async () => {
    const base = await start()
    const workspaceId = `ws_visual_scope_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: 'store-taobao-a', localProductKey: 'visual-scope', title: '平台店铺边界商品', stock: 5, price: 99 })
    service.confirmProductFacts(workspaceId, product.id)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const platformMismatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'catalog.image.generate', params: { product_id: product.id, platform: 'jd', count: '1' } }) }).then(response => response.json()) as { error: { code: string; details: Record<string, string> } }
    expect(platformMismatch.error).toMatchObject({ code: 'IMAGE_PLATFORM_SCOPE_MISMATCH', details: { product_platform: 'taobao', requested_platform: 'jd' } })
    const accountMismatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'catalog.image.generate', params: { product_id: product.id, platform: 'taobao', account_id: 'store-taobao-b', count: '1' } }) }).then(response => response.json()) as { error: { code: string; details: Record<string, string> } }
    expect(accountMismatch.error).toMatchObject({ code: 'IMAGE_ACCOUNT_SCOPE_MISMATCH', details: { product_account_id: 'store-taobao-a', requested_account_id: 'store-taobao-b' } })
  })

  it('reviews and selects a candidate into a new version, then blocks unsupported platform image upload', async () => {
    const workspaceId = `ws_visual_select_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', localProductKey: 'visual-select', title: '显式选图商品', stock: 8, images: ['https://example.com/original.jpg'], skus: [{ id: 'sku-visual-blue-m', name: '蓝色 / M', price: 129, stock: 8 }] })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const originalImages = [...(product.images ?? [])]
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-visual-e2e' }
    const call = (id: number, method: string, params: Record<string, string>, extra: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(response => response.json())

    const generated = await call(20, 'catalog.image.generate', { product_id: product.id, task_id: task.id, content_version_id: draft.id, count: '2', idempotency_key: 'visual-select-generate-e2e' }) as { data: { result: { job: { candidates: Array<{ visualRef: string }> } } } }
    const refs = generated.data.result.job.candidates.map(candidate => candidate.visualRef)
    expect(refs).toHaveLength(2)
    expect(product.images).toEqual(originalImages)

    const reviewed = await call(21, 'catalog.image.review', { product_id: product.id, visual_refs_json: JSON.stringify(refs) }) as { data: { result: { persistedReviewStatus: string } } }
    expect(reviewed.data.result.persistedReviewStatus).toBe('passed')
    const selected = await call(22, 'content.visual.select', { content_version_id: draft.id, visual_refs_json: JSON.stringify([refs[1], refs[0]]), expected_revision: String(draft.revision), idempotency_key: 'visual-select-e2e', reason: '第二张作为主图' }) as { data: { result: { content_version_id: string; parent_content_version_id: string; state: string; reviewRequired: boolean; approvalRequired: boolean; visualSelection: { items: Array<{ visualRef: string }> } } } }
    expect(selected.data.result).toMatchObject({ parent_content_version_id: draft.id, state: 'review_required', reviewRequired: true, approvalRequired: true, visualSelection: { items: [{ visualRef: refs[1] }, { visualRef: refs[0] }] } })
    expect(selected.data.result.content_version_id).not.toBe(draft.id)

    const rereviewed = await call(23, 'content.review', { content_version_id: selected.data.result.content_version_id }) as { data: { result: { blocking: boolean; findings: unknown[] } } }
    expect(rereviewed.data.result).toMatchObject({ blocking: false, findings: [] })
    const approved = await call(24, 'content.approve', { task_id: task.id, content_version_id: selected.data.result.content_version_id }) as { data: { result: { task: { state: string }; version: { state: string } } } }
    expect(approved.data.result).toMatchObject({ task: { state: 'approved' }, version: { state: 'approved' } })

    const preview = await call(25, 'publish.prepare', { task_id: task.id }) as { data: { result: { confirmationHash: string; remoteSnapshotHash: string; payloadHash: string; selectionHash: string; visualPreview: { imageMode: string; executionReady: boolean; blocker: string; items: Array<{ visualRef: string; firstIsMainImage: boolean }> } } } }
    expect(preview.data.result).toMatchObject({ selectionHash: expect.any(String), payloadHash: expect.any(String), visualPreview: { imageMode: 'replace_pending_adapter', executionReady: false, blocker: 'IMAGE_PUBLISH_ADAPTER_UNAVAILABLE', items: [{ visualRef: refs[1], role: 'main', firstIsMainImage: true }, { visualRef: refs[0], role: 'secondary', firstIsMainImage: false }] } })
    const pending = service.getTask(task.id).pendingPublish
    expect(pending).toMatchObject({ contentVersionId: selected.data.result.content_version_id, payloadSnapshot: { imageMode: 'replace_pending_adapter' }, selectedVisuals: [{ visualRef: refs[1], role: 'main', skuIds: expect.any(Array) }, { visualRef: refs[0], role: 'secondary', skuIds: expect.any(Array) }] })
    expect(pending?.payloadSnapshot.fields).not.toHaveProperty('images')
    expect(product.images).toEqual(originalImages)

    const confirmed = await call(26, 'publish.confirm', { task_id: task.id, content_version_id: selected.data.result.content_version_id, confirmation_hash: preview.data.result.confirmationHash, remote_snapshot_hash: preview.data.result.remoteSnapshotHash }, { 'idempotency-key': 'visual-publish-e2e' }) as { error: { code: string; message: string; details: { selected_count: number } } }
    expect(confirmed.error).toMatchObject({ code: 'IMAGE_PUBLISH_ADAPTER_UNAVAILABLE' })
    expect(confirmed.error.message).toContain('禁止退回旧商品图')
    expect(confirmed.error.details).toMatchObject({ selected_count: 2 })
    expect(service.getTask(task.id)).toMatchObject({ state: 'publish_prepared', pendingPublish: { confirmationHash: preview.data.result.confirmationHash } })
    expect([...service.publishJobs.values()].filter(job => job.workspaceId === workspaceId)).toHaveLength(0)
  })

  it('blocks formal image generation until an approved AI-editable asset matches the product platform', async () => {
    const previous = process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION
    process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION = 'true'
    try {
      const base = await start()
      const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_image_asset_gate' }
      const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '素材门禁商品', local_product_key: 'image-asset-gate', price: 99, stock: 5 }) }).then(response => response.json()) as { data: { id: string } }
      const confirmed = await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/confirm`, { method: 'POST', headers, body: '{}' }).then(response => response.json()) as { data: { factsConfirmed: boolean } }
      expect(confirmed.data.factsConfirmed).toBe(true)

      const blocked = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'catalog.image.generate', params: { product_id: imported.data.id, count: '1' } }) }).then(response => response.json()) as { error: { code: string; message: string; details: { candidate_count: number; required: Record<string, unknown> } } }
      expect(blocked.error).toMatchObject({ code: 'APPROVED_ASSET_REQUIRED_FOR_GENERATION' })
      expect(blocked.error.message).toContain('已通过安全扫描')
      expect(blocked.error.details).toMatchObject({ candidate_count: 0, required: { scan_status: 'clean', rights_status: 'approved', ai_modification_allowed: true, applicable_platforms: ['taobao'] } })

      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
      const uploaded = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'asset.upload', params: { name: 'product-source.png', mime_type: 'image/png', content_base64: pngSignature.toString('base64'), applicable_platforms_json: '["taobao"]' } }) }).then(response => response.json()) as { data: { result: { id: string; scanStatus: string } } }
      expect(uploaded.data.result.scanStatus).toBe('quarantined')
      const scanned = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'asset.scan', params: { asset_id: uploaded.data.result.id, scan_evidence_ref: 'scanner://image-gate-test' } }) }).then(response => response.json()) as { data: { result: { scanStatus: string } } }
      expect(scanned.data.result.scanStatus).toBe('clean')
      const rights = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'asset.rights.update', params: { asset_id: uploaded.data.result.id, rights_status: 'approved', rights_scope: 'commercial_authorized', applicable_platforms_json: '["taobao"]', ai_modification_allowed: 'true' } }) }).then(response => response.json()) as { data: { result: { rightsStatus: string; aiModificationAllowed: boolean } } }
      expect(rights.data.result).toMatchObject({ rightsStatus: 'approved', aiModificationAllowed: true })

      const generated = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'catalog.image.generate', params: { product_id: imported.data.id, mode: 'optimize', count: '1', asset_ids_json: JSON.stringify([uploaded.data.result.id]), idempotency_key: 'image-gate-approved-1' } }) }).then(response => response.json()) as { data: { result: { images: string[]; job: { imageMode: string; sourceAssetIds: string[] } } } }
      expect(generated.data.result.images).toHaveLength(1)
      expect(generated.data.result.job).toMatchObject({ imageMode: 'optimize', sourceAssetIds: [uploaded.data.result.id] })
      const bound = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '默认素材商品', local_product_key: 'image-default-source', price: 109, stock: 5, asset_ids: [uploaded.data.result.id] }) }).then(response => response.json()) as { data: { id: string; sourceAssetIds: string[] } }
      expect(bound.data.sourceAssetIds).toEqual([uploaded.data.result.id])
      await fetch(`${base}/v1/products/${encodeURIComponent(bound.data.id)}/confirm`, { method: 'POST', headers, body: '{}' })
      const generatedFromDefault = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'catalog.image.generate', params: { product_id: bound.data.id, count: '1', idempotency_key: 'image-gate-default-source-1' } }) }).then(response => response.json()) as { data: { result: { images: string[]; job: { imageMode: string; sourceAssetIds: string[] } } } }
      expect(generatedFromDefault.data.result.images).toHaveLength(1)
      expect(generatedFromDefault.data.result.job).toMatchObject({ imageMode: 'optimize', sourceAssetIds: [uploaded.data.result.id] })
      const edited = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'multimodal.image.edit', params: { request_json: JSON.stringify({ kind: 'image_local_edit', id: 'edit-uploaded-source', sourceImage: { id: uploaded.data.result.id, uri: 'asset://workspace-source', width: 1200, height: 1200 }, prompt: '优化背景但保留商品结构', region: { id: 'background', rect: { x: 0, y: 0, width: 1, height: 1 } }, constraints: { editableRegions: [{ id: 'background', rect: { x: 0, y: 0, width: 1, height: 1 } }], nonModifiableRegions: [] }, context: { brand: { id: 'brand-1', version: '1', hash: 'sha256:brand' }, product: { id: 'product-1', version: '1', hash: 'sha256:product' }, rules: [{ id: 'rule-1', version: '1', hash: 'sha256:rule' }] } }) } }) }).then(response => response.json()) as { data: { result: { sourceImageId: string; status: string; originalPreserved: boolean } } }
      expect(edited.data.result).toMatchObject({ sourceImageId: uploaded.data.result.id, status: 'candidate', originalPreserved: true })
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION
      else process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION = previous
    }
  })

  it('creates fact-bound Banner, ad and video briefs without pretending to render media', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_creative_brief' }
    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: 'Brief 商品', local_product_key: 'brief-product', price: 129, stock: 8, skus: [{ id: 'sku-blue', name: '雾蓝/M', price: 129, stock: 8 }] }) }).then(response => response.json()) as { data: { id: string } }
    await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/confirm`, { method: 'POST', headers, body: '{}' })
    const banner = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'banner', platform: 'taobao', sku_ids_json: '["sku-blue"]' } }) }).then(response => response.json()) as { data: { result: { assetType: string; renderable: boolean; dimensions: { ratio: string; resolution: string }; layout: { productBinding: Array<{ skuId: string }> } } } }
    expect(banner.data.result).toMatchObject({ assetType: 'banner', renderable: false, dimensions: { ratio: '3:1', resolution: '1200x400' }, layout: { productBinding: [{ skuId: 'sku-blue' }] } })
    const video = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'video_storyboard', duration_seconds: '15' } }) }).then(response => response.json()) as { data: { result: { scenes: unknown[]; storyboardConfirmationRequired: boolean } } }
    expect(video.data.result.scenes).toHaveLength(4)
    expect(video.data.result.storyboardConfirmationRequired).toBe(true)
    const invalidPromotion = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'ad', promotion_json: '{"price":99}' } }) }).then(response => response.json()) as { error: { code: string } }
    expect(invalidPromotion.error.code).toBe('PROMOTION_VALIDITY_REQUIRED')
    const preview = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'creative.preview', params: { product_id: imported.data.id, asset_type: 'banner', platform: 'taobao', count: '2' } }) }).then(response => response.json()) as { data: { result: { images: string[]; width: number; height: number; renderMode: string; externallyUnverified: string[] } } }
    expect(preview.data.result.images).toHaveLength(2)
    expect(preview.data.result).toMatchObject({ width: 1200, height: 400 })
    expect(preview.data.result.images[0]).toMatch(/^data:image\/svg\+xml;base64,/u)
    expect(preview.data.result.renderMode).toBe('deterministic_review_preview')
    expect(preview.data.result.externallyUnverified).toContain('OCR 与平台最终审核')
  })

  it('keeps brand and asset onboarding inside MCP', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_mcp_assets' }
    const brand = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'brand.upsert', params: { name: '云朵品牌', positioning: '轻户外', tone_json: '["克制","清晰"]' } }) }).then(response => response.json()) as { data: { result: { name: string; revision: number } } }
    expect(brand.data.result).toMatchObject({ name: '云朵品牌', revision: 1 })
    const encoded = Buffer.from('title: 轻量外套\nmaterial: 防晒面料').toString('base64')
    const uploaded = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asset.upload', params: { name: 'facts.txt', mime_type: 'text/plain', content_base64: encoded, rights_scope: 'limited_use', applicable_platforms_json: '["taobao"]', applicable_regions_json: '["CN"," HK ","CN"]', usage_scopes_json: '["commercial","ai_generation"]', valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-12-31T23:59:59Z', ai_modification_allowed: 'false' } }) }).then(response => response.json()) as { data: { result: { id: string; scanStatus: string; rightsScope: string; applicablePlatforms: string[]; applicableRegions: string[]; usageScopes: string[]; aiModificationAllowed: boolean } } }
    expect(uploaded.data.result.scanStatus).toBe('quarantined')
    expect(uploaded.data.result).toMatchObject({ rightsScope: 'limited_use', applicablePlatforms: ['taobao'], applicableRegions: ['CN', 'HK'], usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: false })
    const scanned = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'asset.scan', params: { asset_id: uploaded.data.result.id, scan_evidence_ref: 'scanner://mcp-test' } }) }).then(response => response.json()) as { data: { result: { scanStatus: string } } }
    expect(scanned.data.result.scanStatus).toBe('clean')
    const rights = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'asset.rights.update', params: { asset_id: uploaded.data.result.id, rights_status: 'approved', rights_scope: 'commercial_authorized', applicable_platforms_json: '["taobao","tmall"]', applicable_regions_json: '["CN"]', usage_scopes_json: '["platform_publish"]', ai_modification_allowed: 'false' } }) }).then(response => response.json()) as { data: { result: { rightsStatus: string; rightsScope: string; applicablePlatforms: string[]; applicableRegions: string[]; usageScopes: string[] } } }
    expect(rights.data.result).toMatchObject({ rightsStatus: 'approved', rightsScope: 'commercial_authorized', applicablePlatforms: ['taobao', 'tmall'], applicableRegions: ['CN'], usageScopes: ['platform_publish'] })
    const parsed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'asset.parse', params: { asset_id: uploaded.data.result.id } }) }).then(response => response.json()) as { data: { result: { parseStatus: string; extractedFacts: Record<string, string> } } }
    expect(parsed.data.result).toMatchObject({ parseStatus: 'succeeded', extractedFacts: { title: '轻量外套', material: '防晒面料' } })
    const unusable = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'asset.rights.update', params: { asset_id: uploaded.data.result.id, rights_status: 'approved', rights_scope: 'unusable' } }) }).then(response => response.json()) as { data: { result: { rightsScope: string } } }
    expect(unusable.data.result.rightsScope).toBe('unusable')
    const merchantStart = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'merchant.start', params: {} }) }).then(response => response.json()) as { data: { result: { summary: { readyAssets: number } } } }
    expect(merchantStart.data.result.summary.readyAssets).toBe(0)
  })

  it('rejects executable and signature-mismatched uploads before quarantine', async () => {
    const base = await start()
    const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_asset_gate' }
    const executable = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'asset.upload', params: { name: 'logo.png', mime_type: 'image/png', content_base64: Buffer.from('MZ-not-an-image').toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(executable.error.code).toBe('ASSET_EXECUTABLE_REJECTED')
    const mismatch = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asset.upload', params: { name: 'logo.png', mime_type: 'image/png', content_base64: Buffer.from('plain text').toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(mismatch.error.code).toBe('ASSET_SIGNATURE_MISMATCH')
    const archive = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'asset.upload', params: { name: 'encrypted.zip', mime_type: 'application/zip', content_base64: Buffer.from('PK\x03\x04encrypted archive').toString('base64') } }) }).then(response => response.json()) as { error: { code: string } }
    expect(archive.error.code).toBe('ASSET_TYPE_UNSUPPORTED')
  })

})
