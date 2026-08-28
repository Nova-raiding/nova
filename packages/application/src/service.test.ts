import { describe, expect, it, vi } from 'vitest'
import { DomainError, MerchantService } from './service.js'

describe('MerchantService', () => {
  it('reuses a deterministic campaign task id and rejects a different scope', () => {
    const service = new MerchantService({ fixtureMode: true })
    const input = { workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' as const, brandId: 'brand_1', campaignId: 'campaign_1', campaignItemId: 'item_1', taskId: 'task_campaign_fixed' }
    const first = service.createTask(input)
    expect(service.createTask(input)).toBe(first)
    expect(() => service.createTask({ ...input, campaignItemId: 'item_2' })).toThrowError(expect.objectContaining({ code: 'TASK_IDEMPOTENCY_CONFLICT' }))
  })

  it('freezes approved competitor differentiation references into the generation context', () => {
    let providerInput: { competitorReference?: unknown } | undefined
    const service = new MerchantService({ fixtureMode: true, knowledgeContextProvider: input => { providerInput = input; return { rules: [], assets: [], confirmedLearningSuggestions: [], ...(input.competitorReference ? { competitorReferences: [input.competitorReference] } : {}) } } })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    const reference = { competitorAnalysisId: 'competitor_1', structuralObservations: ['先利益点后参数'], expressionObservations: ['短句 CTA'], differentiationAngles: ['突出轻量'], safeExpressionGuidance: ['只使用已确认事实'], compliance: { originalTextCopied: false, competitorBrandReused: false } }
    service.answerTask('ws_demo', task.id, { competitor_reference_json: JSON.stringify(reference) })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'operator')
    expect(providerInput?.competitorReference).toEqual(reference)
    expect(task.inputSnapshot?.knowledgeContext?.competitorReferences).toEqual([reference])
  })

  it('supports safe operations queue transitions without replaying external writes', async () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    const generationTask = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: product.platform })
    service.selectDirection(generationTask.id, 'A')
    service.confirmProductionPlan('ws_demo', generationTask.id, 'operator')
    const generation = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: generationTask.id, idempotencyKey: 'ops-retry-generation' })
    service.failGeneration({ workspaceId: 'ws_demo', jobId: generation.id, code: 'PROVIDER_TIMEOUT', message: 'provider timeout' })
    const retried = service.retryGeneration({ workspaceId: 'ws_demo', jobId: generation.id })
    expect(retried).toMatchObject({ id: generation.id, state: 'queued', errorCode: undefined, errorMessage: undefined })
    expect(() => service.retryGeneration({ workspaceId: 'ws_demo', jobId: generation.id })).toThrowError(expect.objectContaining({ code: 'GENERATION_RETRY_NOT_ALLOWED' }))
    const assignmentRevision = retried.revision
    const assignedGeneration = service.assignMarketingQueueItem({ workspaceId: 'ws_demo', itemType: 'generation', itemId: generation.id, operatorId: 'operator_a', expectedRevision: assignmentRevision })
    expect(assignedGeneration).toMatchObject({ assignedOperatorId: 'operator_a', assignedAt: expect.any(String) })
    expect(() => service.assignMarketingQueueItem({ workspaceId: 'ws_demo', itemType: 'generation', itemId: generation.id, operatorId: 'operator_b', expectedRevision: assignmentRevision })).toThrowError(expect.objectContaining({ code: 'QUEUE_ASSIGNMENT_VERSION_CONFLICT' }))

    const publishTask = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: product.platform })
    service.selectDirection(publishTask.id, 'A')
    const draft = service.createDraft(publishTask.id)
    service.approveContent(publishTask.id, draft.id)
    const preview = service.preparePublish(publishTask.id)
    const publish = service.confirmPublish({ workspaceId: 'ws_demo', taskId: publishTask.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'ops-revision-publish' })
    service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: publish.id, status: { found: true, state: 'rejected', rejection: { rawCode: 'TOP-1', message: '标题违规', fields: [{ path: 'title', rawCode: 'TITLE', message: '标题违规' }] } } })
    const acknowledged = service.acknowledgePublish({ workspaceId: 'ws_demo', publishJobId: publish.id, actorId: 'operator', reason: '已读取平台回执，转人工处理' })
    expect(acknowledged.operatorAcknowledgement).toMatchObject({ actorId: 'operator', reason: '已读取平台回执，转人工处理' })
    const assignedPublish = service.assignMarketingQueueItem({ workspaceId: 'ws_demo', itemType: 'publish', itemId: publish.id, operatorId: 'operator_b', expectedRevision: acknowledged.revision })
    expect(assignedPublish).toMatchObject({ assignedOperatorId: 'operator_b', assignedAt: expect.any(String) })
    const restarted = new MerchantService({ fixtureMode: true })
    restarted.hydrateSnapshot({ entityType: 'publish_job', entity: structuredClone(assignedPublish) })
    expect(restarted.publishJobs.get(publish.id)).toMatchObject({ assignedOperatorId: 'operator_b', assignedAt: assignedPublish.assignedAt, revision: assignedPublish.revision })
    const revision = service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: draft.id, changes: { title: '合规新标题' }, reason: '根据平台驳回创建运营修正版' })
    expect(revision.version).toMatchObject({ parentId: draft.id, state: 'review_required', body: { title: '合规新标题' } })
  })

  it('keeps generated images as durable version-bound candidates without mutating product images', async () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    const originalImages = product.images ? [...product.images] : undefined
    const originalVersion = product.version
    const task = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: product.platform })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const job = service.enqueueImageGeneration({ workspaceId: 'ws_demo', productId: product.id, taskId: task.id, contentVersionId: draft.id, idempotencyKey: 'bound-image-1', count: 1 })
    const completed = await service.completeImageGeneration({ workspaceId: 'ws_demo', jobId: job.id })
    expect(completed.images).toHaveLength(1)
    expect(product.images).toEqual(originalImages)
    expect(product.version).toBe(originalVersion)

    const archived = service.archiveImageGenerationOutputs('ws_demo', job.id, [{ visualRef: `dvis_${'A'.repeat(24)}`, ordinal: 1, storageKey: `quarantine/ws_demo/${job.id}/candidate-1.webp`, mimeType: 'image/webp', sizeBytes: 9, sha256: 'a'.repeat(64), createdAt: '2026-08-25T00:00:00.000Z', reviewStatus: 'unreviewed' }], 'archived')
    expect(archived.images).toBeUndefined()
    const assignedVisual = service.assignMarketingVisual({ workspaceId: 'ws_demo', jobId: job.id, operatorId: 'visual_operator', expectedRevision: archived.revision })
    expect(assignedVisual).toMatchObject({ assignedOperatorId: 'visual_operator', assignedAt: expect.any(String) })
    expect(service.reviewImageGenerationOutputs('ws_demo', [`dvis_${'A'.repeat(24)}`], 'passed')).toHaveLength(1)
    service.approveContent(task.id, draft.id)
    expect(service.listDeliverables('ws_demo').items[0]).toMatchObject({ visual: { binding: 'exact', candidateCount: 1, representative: { visualRef: `dvis_${'A'.repeat(24)}`, publishable: false }, platformPublished: false }, boundaries: { includesImages: false, includesUrls: false, exactImageVersionBinding: true } })
    expect(() => service.enqueueImageGeneration({ workspaceId: 'ws_demo', productId: product.id, taskId: task.id, contentVersionId: draft.id, idempotencyKey: 'bound-image-after-freeze' })).toThrowError(expect.objectContaining({ code: 'IMAGE_CONTENT_VERSION_FROZEN' }))

    const restarted = new MerchantService({ fixtureMode: true })
    restarted.hydrateSnapshot({ entityType: 'image_generation_job', entity: structuredClone(archived) })
    expect(restarted.getImageGenerationJob('ws_demo', job.id).outputs).toHaveLength(1)
    expect(restarted.resolveImageGenerationByVisualRef('ws_demo', `dvis_${'A'.repeat(24)}`).id).toBe(job.id)
    expect(() => restarted.resolveImageGenerationByVisualRef('ws_other', `dvis_${'A'.repeat(24)}`)).toThrowError(expect.objectContaining({ code: 'VISUAL_NOT_FOUND' }))
  })

  it('freezes image candidates to the selected SKU scope', () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.importProduct({ workspaceId: 'ws_image_sku', platform: 'taobao', title: 'SKU 图片商品', skuCount: 2, skus: [{ id: 'sku-blue-m', name: '蓝色/M', price: 129, stock: 3 }, { id: 'sku-black-l', name: '黑色/L', price: 139, stock: 5 }] })
    const task = service.createTask({ workspaceId: 'ws_image_sku', productId: product.id, platform: product.platform })
    const answered = service.answerTask('ws_image_sku', task.id, { confirm_facts: true, sku_id: 'sku-blue-m' }, task.version)
    service.selectDirection(answered.id, 'A')
    const draft = service.createDraft(answered.id)
    const job = service.enqueueImageGeneration({ workspaceId: 'ws_image_sku', productId: product.id, taskId: answered.id, contentVersionId: draft.id, skuIds: ['sku-blue-m'], idempotencyKey: 'sku-scoped-image-1', count: 1 })
    expect(job.skuIds).toEqual(['sku-blue-m'])
    expect(() => service.enqueueImageGeneration({ workspaceId: 'ws_image_sku', productId: product.id, taskId: answered.id, contentVersionId: draft.id, skuIds: ['sku-black-l'], idempotencyKey: 'sku-scoped-image-2', count: 1 })).toThrowError(expect.objectContaining({ code: 'IMAGE_SKU_SCOPE_MISMATCH' }))
  })

  it('persists product source assets and uses them as the default optimization scope', () => {
    const service = new MerchantService({ fixtureMode: true })
    const asset = service.registerAsset({ workspaceId: 'ws_product_assets', name: 'product-source.png', mimeType: 'image/png', sizeBytes: 9, sha256: 'a'.repeat(64), storageKey: 'quarantine/ws_product_assets/product-source.png' })
    const product = service.importProduct({ workspaceId: 'ws_product_assets', platform: 'taobao', title: '绑定素材商品', sourceAssetIds: [asset.id], stock: 5 })
    expect(product.sourceAssetIds).toEqual([asset.id])
    const job = service.enqueueImageGeneration({ workspaceId: 'ws_product_assets', productId: product.id, imageMode: 'optimize', idempotencyKey: 'product-source-default' })
    expect(job).toMatchObject({ imageMode: 'optimize', sourceAssetIds: [asset.id] })
    expect(() => service.importProduct({ workspaceId: 'ws_product_assets', platform: 'taobao', title: '错误素材商品', sourceAssetIds: ['asset-from-other-workspace'] })).toThrowError(expect.objectContaining({ code: 'PRODUCT_SOURCE_ASSET_NOT_FOUND' }))
  })

  it('creates an immutable reviewed visual selection and fails closed before unsupported image publishing', async () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    const task = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: product.platform })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const job = service.enqueueImageGeneration({ workspaceId: 'ws_demo', productId: product.id, taskId: task.id, contentVersionId: draft.id, idempotencyKey: 'visual-select-generate', count: 2 })
    await service.completeImageGeneration({ workspaceId: 'ws_demo', jobId: job.id })
    const refs = [`dvis_${'B'.repeat(24)}`, `dvis_${'C'.repeat(24)}`]
    service.archiveImageGenerationOutputs('ws_demo', job.id, refs.map((visualRef, index) => ({ visualRef, ordinal: index + 1, storageKey: `quarantine/ws_demo/${job.id}/candidate-${index + 1}.webp`, mimeType: 'image/webp', sizeBytes: 9 + index, sha256: String(index + 1).repeat(64), createdAt: '2026-08-25T00:00:00.000Z', reviewStatus: 'unreviewed' })), 'archived')
    expect(() => service.selectVisuals({ workspaceId: 'ws_demo', contentVersionId: draft.id, visualRefs: [refs[1]!], expectedRevision: draft.revision, idempotencyKey: 'select-visual-1', selectedBy: 'merchant', reason: '选择第二张作为主图' })).toThrowError(expect.objectContaining({ code: 'VISUAL_REVIEW_REQUIRED' }))
    service.reviewImageGenerationOutputs('ws_demo', refs, 'passed')

    const selected = service.selectVisuals({ workspaceId: 'ws_demo', contentVersionId: draft.id, visualRefs: [refs[1]!, refs[0]!], expectedRevision: draft.revision, idempotencyKey: 'select-visual-1', selectedBy: 'merchant', reason: '第二张作为主图，第一张作为辅图' })
    expect(selected.source.visualSelection).toBeUndefined()
    expect(selected.version).toMatchObject({ parentId: draft.id, state: 'review_required', visualSelection: { items: [{ visualRef: refs[1], ordinal: 2 }, { visualRef: refs[0], ordinal: 1 }] } })
    expect(service.selectVisuals({ workspaceId: 'ws_demo', contentVersionId: draft.id, visualRefs: [refs[1]!, refs[0]!], expectedRevision: draft.revision, idempotencyKey: 'select-visual-1', selectedBy: 'merchant', reason: '第二张作为主图，第一张作为辅图' }).version.id).toBe(selected.version.id)
    service.approveContent(task.id, selected.version.id)
    const preview = service.preparePublish(task.id)
    expect(preview.visualPreview).toMatchObject({ imageMode: 'replace_pending_adapter', count: 2, executionReady: false, blocker: 'IMAGE_PUBLISH_ADAPTER_UNAVAILABLE', items: [{ visualRef: refs[1], firstIsMainImage: true }, { visualRef: refs[0], firstIsMainImage: false }] })
    expect(preview.changes).not.toContain('images')
    expect(() => service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: selected.version.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'publish-selected-visuals' })).toThrowError(expect.objectContaining({ code: 'IMAGE_PUBLISH_ADAPTER_UNAVAILABLE' }))
  })

  it('freezes the exact non-image publish payload and never falls back to mutable product images', () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    product.images = ['https://example.com/current-platform-image.jpg']
    const task = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: product.platform })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    expect(preview.visualPreview).toMatchObject({ imageMode: 'unchanged', count: 0, executionReady: true })
    expect(task.pendingPublish?.payloadSnapshot.fields).not.toHaveProperty('images')
    product.images = ['https://example.com/changed-after-preview.jpg']
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'publish-frozen-payload' })
    expect(job.payloadSnapshot).toEqual(task.pendingPublish?.payloadSnapshot)
    expect(job.payloadSnapshot.fields).not.toHaveProperty('images')
  })

  it('lists approved content as a safe paginated virtual deliverable index', () => {
    const service = new MerchantService()
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: 'shop-safe', credentialRef: 'vault://safe' })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: account.id, requestText: '秋季详情页' })
    const base = { taskId: task.id, body: { title: '轻云外套秋季版', detail: '不应出现在列表', sellingPoints: ['保暖'] }, factVersionIds: [], ruleVersionIds: [], state: 'approved' as const, revision: 1 }
    service.contentVersions.set('cv_safe_1', { id: 'cv_safe_1', version: 1, ...base })
    service.contentVersions.set('cv_safe_2', { id: 'cv_safe_2', version: 2, ...base, body: { ...base.body, title: '轻云外套秋季版 v2' } })
    task.contentVersionId = 'cv_safe_2'

    const first = service.listDeliverables('ws_demo', { platform: 'taobao', accountId: account.id, limit: 1 })
    expect(first).toMatchObject({ count: 1, totalMatched: 2, hasMore: true, storageMode: 'virtual_index' })
    expect(first.items[0]).toMatchObject({ deliverableRef: expect.stringMatching(/^dlv_/), state: 'approved', boundaries: { virtualIndex: true, includesBody: false, includesImages: false } })
    expect(JSON.stringify(first.items[0])).not.toContain('cv_safe_')
    expect(JSON.stringify(first.items[0])).not.toContain('不应出现在列表')
    const second = service.listDeliverables('ws_demo', { platform: 'taobao', accountId: account.id, limit: 1, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.deliverableRef).not.toBe(first.items[0]!.deliverableRef)
    expect(() => service.listDeliverables('ws_demo', { query: 'different', limit: 1, cursor: first.nextCursor! })).toThrowError(expect.objectContaining({ code: 'DELIVERABLE_CURSOR_INVALID' }))
  })

  it('does not call drafts deliverables by default and requires platform for store scope', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.contentVersions.set('cv_draft_only', { id: 'cv_draft_only', taskId: task.id, version: 1, body: { title: '草稿', detail: '草稿正文', sellingPoints: [] }, factVersionIds: [], ruleVersionIds: [], state: 'draft', revision: 1 })
    expect(service.listDeliverables('ws_demo').items).toEqual([])
    expect(service.listDeliverables('ws_demo', { state: 'draft' }).items).toHaveLength(1)
    expect(() => service.listDeliverables('ws_demo', { accountId: 'acct_taobao_1' })).toThrowError(expect.objectContaining({ code: 'STORE_PLATFORM_REQUIRED' }))
  })
  it('exposes active rule versions with source metadata and keeps admin changes auditable', () => {
    const service = new MerchantService()
    expect(service.listRulePacks()).toHaveLength(8)
    expect(service.listRulePacks().every(rule => rule.status === 'active' && rule.checksum.length === 64)).toBe(true)
    const published = service.publishRuleVersion({
      packId: 'cn-commerce', name: '中国电商广告表达', version: 'cn-commerce-2.0.0', scope: 'global', actorId: 'rules-owner', reason: '平台规则核验更新',
      source: { kind: 'official', reference: 'ticket://RULE-2', checkedAt: '2026-08-23T00:00:00.000Z' },
      checks: { forbiddenTerms: ['最强', '第一', '绝对化', '宇宙第一'] },
    })
    expect(published.status).toBe('draft')
    service.setRuleStatus({ packId: 'cn-commerce', version: published.version, status: 'active', actorId: 'rules-owner', reason: '审核通过，替换旧版本' })
    expect(service.listRulePacks().find(rule => rule.id === 'cn-commerce@cn-commerce-2.0.0')?.status).toBe('active')
    expect(service.listRuleHistory('cn-commerce').map(rule => rule.status)).toEqual(['inactive', 'active'])
    expect(service.listRuleAudit('cn-commerce').at(-1)).toMatchObject({ action: 'activated', actorId: 'rules-owner', reason: '审核通过，替换旧版本' })
  })

  it('fails closed when a saved content version points to a deactivated rule', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.setRuleStatus({ packId: 'cn-commerce', version: 'cn-commerce-1.0.0', status: 'inactive', actorId: 'rules-owner', reason: '平台规则待复核' })
    expect(service.reviewContent('ws_demo', draft.id)).toContainEqual(expect.objectContaining({ code: 'MISSING_RULE_VERSION', severity: 'error' }))
    expect(() => service.approveContent(task.id, draft.id)).toThrowError(/REVIEW_BLOCKED|阻断/)
  })

  it('surfaces expired or conflicting rules as a blocking task question before generation', () => {
    const service = new MerchantService()
    const expiredRule = service.publishRuleVersion({
      packId: 'expired-task-rule', name: '已过期任务规则', version: 'expired-task-rule-1.0.0', scope: 'global',
      effectiveTo: '2026-01-01T00:00:00.000Z',
      source: { kind: 'official', reference: 'manual://expired-task-rule', checkedAt: '2025-12-01T00:00:00.000Z' }, checks: { forbiddenTerms: ['过期规则'] },
      actorId: 'rules-owner', reason: '测试过期规则前置阻断',
    })
    service.setRuleStatus({ packId: 'expired-task-rule', version: expiredRule.version, status: 'active', actorId: 'rules-owner', reason: '测试启用过期规则' })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    expect(task.missingQuestions).toContainEqual(expect.objectContaining({ id: 'rule_conflict', kind: 'blocking' }))
    expect(task.state).toBe('draft')
  })

  it('exposes the local-review evidence boundary for image review', () => {
    const service = new MerchantService()
    const product = service.listProducts('ws_demo')[0]
    expect(product).toBeDefined()
    const result = service.reviewProductImages('ws_demo', product!.id)
    expect(result.evidenceBoundary).toContain('外部平台审核')
    expect(result.externallyUnverified).toContain('平台最终审核')
    for (const finding of result.findings) expect(finding).toMatchObject({ status: 'open', evidence: { externalVerification: 'not_performed' } })
  })

  it('binds an authorized platform account to its workspace and platform', () => {
    const service = new MerchantService()
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: 'remote-acct-1', credentialRef: 'vault://opaque-1' })
    expect(service.getPlatformAccount('ws_demo', account.id, 'taobao')).toMatchObject({ tokenState: 'connected', credentialRef: 'vault://opaque-1' })
    expect(() => service.getPlatformAccount('ws_other', account.id, 'taobao')).toThrowError(DomainError)
    expect(() => service.getPlatformAccount('ws_demo', account.id, 'jd')).toThrowError(DomainError)
  })

  it('keeps store aliases unique per platform without changing authorization generation', () => {
    const service = new MerchantService({ seedFixture: false })
    const jdNorth = service.registerPlatformAccount({ workspaceId: 'ws_alias', platform: 'jd', remoteAccountId: 'north', credentialRef: 'vault://north', grantedScopes: [' product.read ', 'product.read', 'product.write'], accessTokenExpiresAt: '2026-09-01T00:00:00Z', credentialRefreshable: true })
    const jdSouth = service.registerPlatformAccount({ workspaceId: 'ws_alias', platform: 'jd', remoteAccountId: 'south', credentialRef: 'vault://south' })
    const taobaoNorth = service.registerPlatformAccount({ workspaceId: 'ws_alias', platform: 'taobao', remoteAccountId: 'north', credentialRef: 'vault://tb-north' })
    const authRevision = jdNorth.authRevision
    service.setPlatformAccountAlias({ workspaceId: 'ws_alias', platform: 'jd', accountId: jdNorth.id, alias: ' 北区 ', expectedRevision: jdNorth.revision })
    expect(jdNorth).toMatchObject({ storeAlias: '北区', authRevision, grantedScopes: ['product.read', 'product.write'], accessTokenExpiresAt: '2026-09-01T00:00:00.000Z', credentialRefreshable: true, lastAuthorizedAt: expect.any(String), tokenStateUpdatedAt: expect.any(String) })
    expect(() => service.setPlatformAccountAlias({ workspaceId: 'ws_alias', platform: 'jd', accountId: jdSouth.id, alias: '  北区  ', expectedRevision: jdSouth.revision })).toThrowError(expect.objectContaining({ code: 'STORE_ALIAS_CONFLICT' }))
    expect(() => service.setPlatformAccountAlias({ workspaceId: 'ws_alias', platform: 'jd', accountId: jdSouth.id, alias: '隐\u200B形', expectedRevision: jdSouth.revision })).toThrowError(expect.objectContaining({ code: 'STORE_ALIAS_INVALID' }))
    expect(service.setPlatformAccountAlias({ workspaceId: 'ws_alias', platform: 'taobao', accountId: taobaoNorth.id, alias: '北区', expectedRevision: taobaoNorth.revision }).storeAlias).toBe('北区')
    const revoked = service.revokePlatformAccount('ws_alias', jdNorth.id, 'jd')
    expect(revoked).toMatchObject({ tokenState: 'revoked', revokedAt: expect.any(String), tokenStateUpdatedAt: expect.any(String) })
    const reauthorized = service.registerPlatformAccount({ workspaceId: 'ws_alias', platform: 'jd', remoteAccountId: 'north', credentialRef: 'vault://north-v2', grantedScopes: ['product.read'], credentialRefreshable: false })
    expect(reauthorized).toMatchObject({ storeAlias: '北区', tokenState: 'connected', grantedScopes: ['product.read'], credentialRefreshable: false })
    expect(reauthorized.accessTokenExpiresAt).toBeUndefined()
    expect(reauthorized.revokedAt).toBeUndefined()
    expect(reauthorized.authRevision).toBe((revoked.authRevision ?? 0) + 1)
  })

  it('uses the product store binding and rejects a different task account', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.upsertSyncedProducts({ workspaceId: 'ws_store_scope', platform: 'jd', accountId: 'acct-a', items: [{ remoteId: 'sku-a', title: 'A 店商品', sku: [], stock: 5, source: 'official_api' }] })[0]!
    expect(service.createTask({ workspaceId: 'ws_store_scope', productId: product.id, platform: 'jd' }).accountId).toBe('acct-a')
    expect(() => service.createTask({ workspaceId: 'ws_store_scope', productId: product.id, platform: 'jd', accountId: 'acct-b' })).toThrowError(expect.objectContaining({ code: 'STORE_CONTEXT_MISMATCH' }))
  })

  it('deduplicates an asset by workspace and sha256 without replacing its object or rights state', () => {
    const service = new MerchantService({ seedFixture: false })
    const sha256 = 'A'.repeat(64)
    const first = service.registerAsset({
      workspaceId: 'ws_assets', name: 'original.png', mimeType: 'image/png', sizeBytes: 12,
      sha256, storageKey: 'quarantine/ws_assets/asset-1/original.png',
      rightsStatus: 'pending', rightsScope: 'limited_use', aiModificationAllowed: false,
    })
    first.scanStatus = 'clean'
    first.rightsStatus = 'approved'
    first.revision = 3

    const duplicate = service.registerAsset({
      workspaceId: 'ws_assets', name: 'renamed-copy.png', mimeType: 'image/png', sizeBytes: 12,
      sha256: sha256.toLowerCase(), storageKey: 'quarantine/ws_assets/asset-2/renamed-copy.png',
      rightsStatus: 'rejected', rightsScope: 'unusable', aiModificationAllowed: true,
    })

    expect(duplicate.id).toBe(first.id)
    expect(duplicate.storageKey).toBe(first.storageKey)
    expect(duplicate.deduplication).toEqual({ mode: 'deduplicated', reusedAssetId: first.id, reusedStorageKey: first.storageKey, rightsAndScanStatePreserved: true, referenceAdded: true })
    expect(duplicate).toMatchObject({ name: 'original.png', scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'limited_use', aiModificationAllowed: false, revision: 4 })
    expect(duplicate.references.map(reference => reference.name)).toEqual(['original.png', 'renamed-copy.png'])
    const retry = service.registerAsset({ workspaceId: 'ws_assets', name: 'RENAMED-COPY.PNG', mimeType: 'IMAGE/PNG', sizeBytes: 12, sha256, storageKey: 'quarantine/ws_assets/retry.png' })
    expect(retry.deduplication.referenceAdded).toBe(false)
    expect(retry.revision).toBe(4)
    expect(retry.references).toHaveLength(2)
    expect(service.assets.size).toBe(1)
  })

  it('does not deduplicate the same sha256 across workspaces', () => {
    const service = new MerchantService({ seedFixture: false })
    const input = { name: 'same.png', mimeType: 'image/png', sizeBytes: 1, sha256: 'b'.repeat(64), storageKey: 'quarantine/ws_a/asset-1/same.png' }
    const first = service.registerAsset({ workspaceId: 'ws_a', ...input })
    const other = service.registerAsset({ workspaceId: 'ws_b', ...input, storageKey: 'quarantine/ws_b/asset-2/same.png' })
    expect(other.id).not.toBe(first.id)
    expect(other.deduplication.mode).toBe('created')
    expect(service.assets.size).toBe(2)
  })

  it('does not partially apply a rejected asset rights update', () => {
    const service = new MerchantService({ seedFixture: false })
    const asset = service.registerAsset({
      workspaceId: 'ws_asset_rights_atomic', name: 'source.png', mimeType: 'image/png', sizeBytes: 1,
      sha256: 'e'.repeat(64), storageKey: 'quarantine/ws_asset_rights_atomic/source.png',
    })
    asset.scanStatus = 'clean'
    const before = { ...asset, applicableRegions: asset.applicableRegions, usageScopes: asset.usageScopes }

    expect(() => service.updateAssetRights({
      workspaceId: 'ws_asset_rights_atomic', assetId: asset.id, rightsStatus: 'approved', rightsScope: 'commercial_authorized',
      applicableRegions: ['CN'], usageScopes: ['commercial'], validFrom: 'not-a-date', aiModificationAllowed: true,
    })).toThrowError(expect.objectContaining({ code: 'ASSET_RIGHTS_DATE_INVALID' }))
    expect(asset).toEqual(before)

    expect(() => service.updateAssetRights({ workspaceId: 'ws_asset_rights_atomic', assetId: asset.id, rightsStatus: 'approved', validFrom: '2026-09-02', validTo: '2026-09-01' })).toThrowError(expect.objectContaining({ code: 'ASSET_RIGHTS_DATE_INVALID' }))
    expect(asset).toEqual(before)
  })

  it('rejects invalid rights status, scope, and platform values without mutating the asset', () => {
    const service = new MerchantService({ seedFixture: false })
    const asset = service.registerAsset({
      workspaceId: 'ws_asset_rights_values', name: 'source.png', mimeType: 'image/png', sizeBytes: 1,
      sha256: 'f'.repeat(64), storageKey: 'quarantine/ws_asset_rights_values/source.png',
    })
    asset.scanStatus = 'clean'
    const before = structuredClone(asset)
    expect(() => service.updateAssetRights({ workspaceId: 'ws_asset_rights_values', assetId: asset.id, rightsStatus: 'approved', rightsScope: 'not-a-scope' as never })).toThrowError(expect.objectContaining({ code: 'ASSET_RIGHTS_SCOPE_INVALID' }))
    expect(asset).toEqual(before)
    expect(() => service.updateAssetRights({ workspaceId: 'ws_asset_rights_values', assetId: asset.id, rightsStatus: 'not-a-status' as never })).toThrowError(expect.objectContaining({ code: 'ASSET_RIGHTS_STATUS_INVALID' }))
    expect(asset).toEqual(before)
    expect(() => service.updateAssetRights({ workspaceId: 'ws_asset_rights_values', assetId: asset.id, rightsStatus: 'pending', applicablePlatforms: ['not-a-platform' as never] })).toThrowError(expect.objectContaining({ code: 'ASSET_PLATFORM_SCOPE_INVALID' }))
    expect(asset).toEqual(before)
  })

  it('projects asset lifecycle readiness without weakening generation gates', () => {
    const service = new MerchantService({ seedFixture: false })
    const asset = service.registerAsset({ workspaceId: 'ws_asset_readiness', name: 'source.png', mimeType: 'image/png', sizeBytes: 1, sha256: 'd'.repeat(64), storageKey: 'quarantine/ws_asset_readiness/source.png' })
    expect(service.listAssets('ws_asset_readiness')[0]?.readiness).toEqual({ status: 'draft', reasons: ['等待安全扫描', '等待素材事实解析', '等待商用权益确认', '等待商家确认素材事实'] })

    asset.scanStatus = 'blocked'
    expect(service.listAssets('ws_asset_readiness')[0]?.readiness).toMatchObject({ status: 'blocked', reasons: expect.arrayContaining(['安全扫描阻断']) })

    asset.scanStatus = 'clean'
    asset.parseStatus = 'succeeded'
    asset.rightsStatus = 'approved'
    asset.rightsScope = 'commercial_authorized'
    asset.factsConfirmedBy = 'merchant'
    asset.factsConfirmedAt = new Date().toISOString()
    expect(service.listAssets('ws_asset_readiness')[0]?.readiness).toEqual({ status: 'ready', reasons: [] })
  })

  it('revokes an account while preserving identity and blocking operations', () => {
    const service = new MerchantService()
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'jd', remoteAccountId: 'remote-revoke', credentialRef: 'vault://opaque' })
    const revoked = service.revokePlatformAccount('ws_demo', account.id, 'jd')
    expect(revoked).toMatchObject({ tokenState: 'revoked', remoteAccountId: 'remote-revoke', revision: 2 })
    expect(() => service.getActivePlatformAccount('ws_demo', account.id, 'jd')).toThrowError(/重新授权/)
  })

  it('disables a product without deleting history and blocks new tasks', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_disable', platform: 'jd', title: '待停用商品', stock: 1, skuCount: 1 })
    const historicalTask = service.createTask({ workspaceId: 'ws_disable', productId: product.id, platform: 'jd' })
    const disabled = service.disableProduct({ workspaceId: 'ws_disable', productId: product.id, reason: '商品已下架' })
    expect(disabled).toMatchObject({ id: product.id, disabledReason: '商品已下架' })
    expect(service.listProducts('ws_disable', { productState: 'disabled' })).toEqual([disabled])
    expect(service.listProducts('ws_disable', { productState: 'active' })).toHaveLength(0)
    expect(service.listTasks('ws_disable', { productId: product.id })).toEqual([historicalTask])
    expect(() => service.createTask({ workspaceId: 'ws_disable', productId: product.id, platform: 'jd' })).toThrowError(expect.objectContaining({ code: 'PRODUCT_DISABLED' }))
    service.enableProduct('ws_disable', product.id)
    expect(service.createTask({ workspaceId: 'ws_disable', productId: product.id, platform: 'jd' }).state).toBe('draft')
  })

  it('keeps task flow explicit and blocks publishing before approval', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    expect(task.state).toBe('ready_for_direction')
    expect(() => service.preparePublish(task.id)).toThrowError(DomainError)
    service.selectDirection(task.id, 'A')
    expect(task.productionPlan).toMatchObject({ placement: '商品详情页', outputFormat: 'Markdown + JSON + ZIP', lockedFields: expect.arrayContaining(['Logo/印花/包装文字']) })
    service.confirmProductionPlan('ws_demo', task.id, 'merchant-1', task.version)
    expect(task.state).toBe('plan_confirmed')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'idem-1' })
    expect(job.state).toBe('queued')
    expect(job.accountId).toBe('acct_taobao_1')
  })

  it('blocks a queued publish after account authorization is revoked', () => {
    const service = new MerchantService()
    const account = service.registerPlatformAccount({ workspaceId: 'ws_demo', platform: 'taobao', remoteAccountId: 'remote-race', credentialRef: 'vault://opaque' })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'revoke-race' })
    service.revokePlatformAccount('ws_demo', account.id, 'taobao')
    expect(() => service.assertPublishExecutionAllowed({ workspaceId: 'ws_demo', publishJobId: job.id })).toThrowError(/撤销或发生变化/)
  })

  it('allows only executable publish states and preserves the payload hash gate', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    service.approveContent(task.id, version.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: version.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'execution-gate' })

    const executableStates = ['queued', 'submitting', 'submitted', 'reviewing', 'reconciling', 'unknown'] as const
    for (const state of executableStates) {
      job.state = state
      expect(service.assertPublishExecutionAllowed({ workspaceId: 'ws_demo', publishJobId: job.id })).toBe(job)
    }
    for (const state of ['published', 'rejected', 'manual_attention'] as const) {
      job.state = state
      expect(() => service.assertPublishExecutionAllowed({ workspaceId: 'ws_demo', publishJobId: job.id })).toThrowError(expect.objectContaining({ code: 'PUBLISH_JOB_NOT_EXECUTABLE' }))
    }

    expect(job.payloadHash).toBe(preview.payloadHash)
    expect(job.payloadSnapshot).toEqual(task.pendingPublish?.payloadSnapshot)
    job.state = 'queued'
    expect(() => service.hydrateSnapshot({ entityType: 'publish_job', entity: { ...job, payloadHash: 'not-a-sha256' } })).toThrowError(expect.objectContaining({ code: 'PUBLISH_JOB_SNAPSHOT_INVALID' }))
    expect(() => service.hydrateSnapshot({ entityType: 'publish_job', entity: { ...job, payloadSnapshot: undefined } })).toThrowError(expect.objectContaining({ code: 'PUBLISH_JOB_SNAPSHOT_INVALID' }))
  })

  it('deduplicates repeated publish confirmation', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    const input = { workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'same-idem' }
    const first = service.confirmPublish(input)
    const second = service.confirmPublish(input)
    expect(second.id).toBe(first.id)
    expect(service.publishJobs.size).toBe(1)
  })

  it('scopes publish idempotency keys to the workspace', () => {
    const service = new MerchantService({ seedFixture: false })
    const prepare = (workspaceId: string) => {
      const product = service.importProduct({ workspaceId, platform: 'taobao', title: `${workspaceId} 商品`, stock: 1 })
      service.confirmProductFacts(workspaceId, product.id)
      const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao' })
      service.selectDirection(task.id, 'A')
      const version = service.createDraft(task.id)
      service.approveContent(task.id, version.id)
      return { task, version, preview: service.preparePublish(task.id) }
    }
    const first = prepare('ws_publish_a')
    const second = prepare('ws_publish_b')
    const firstJob = service.confirmPublish({ workspaceId: 'ws_publish_a', taskId: first.task.id, contentVersionId: first.version.id, confirmationHash: first.preview.confirmationHash, remoteSnapshotHash: first.preview.remoteSnapshotHash, idempotencyKey: 'shared-publish-key' })
    const secondJob = service.confirmPublish({ workspaceId: 'ws_publish_b', taskId: second.task.id, contentVersionId: second.version.id, confirmationHash: second.preview.confirmationHash, remoteSnapshotHash: second.preview.remoteSnapshotHash, idempotencyKey: 'shared-publish-key' })
    expect(secondJob.id).not.toBe(firstJob.id)
    expect(service.publishJobs.size).toBe(2)
  })

  it('projects only explicit remote evidence to delivered and keeps unknown recoverable', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    service.approveContent(task.id, version.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: version.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'observation-1' })
    service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: job.id, status: { found: false, state: 'unknown', simulated: false } })
    expect(job.state).toBe('unknown')
    expect(task.state).toBe('publishing')
    const revisionBeforeInvalidObservation = job.revision
    expect(() => service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: job.id, status: { found: true, state: 'published', simulated: false } })).toThrowError(DomainError)
    expect(() => service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: job.id, status: { found: true, state: 'published', remoteId: 'fake-1', simulated: true } })).toThrowError(DomainError)
    expect(() => service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: job.id, status: { found: false, state: 'published', remoteId: 'forged-1', simulated: false } })).toThrowError(DomainError)
    expect(job.state).toBe('unknown')
    expect(job.remoteState).toBe('unknown')
    expect(job.revision).toBe(revisionBeforeInvalidObservation)
    service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: job.id, status: { found: true, state: 'published', remoteId: 'TB-1', simulated: false } })
    expect(job.state).toBe('published')
    expect(task.state).toBe('delivered')
    expect(version.state).toBe('delivered')
  })

  it('freezes rejection evidence on the failed job and requires a reviewed child version before another publish', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.selectDirection(task.id, 'A')
    const source = service.createDraft(task.id)
    service.approveContent(task.id, source.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: source.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'rejection-correction' })
    service.recordPublishObservation({ workspaceId: 'ws_demo', publishJobId: job.id, status: { found: true, state: 'rejected', simulated: false, rejection: { rawCode: 'TOP-27', message: '标题过长', fields: [{ path: 'title', rawCode: 'TITLE-LONG', message: '缩短标题' }] } } })
    expect(job).toMatchObject({ state: 'rejected', rejection: { rawCode: 'TOP-27', fields: [{ path: 'title' }] } })
    expect(task.state).toBe('failed_recoverable')
    const modified = service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: source.id, changes: { title: '较短标题' }, reason: 'platform_rejection:TOP-27' })
    expect(modified.version).toMatchObject({ parentId: source.id, state: 'review_required' })
    expect(modified.task.state).toBe('review_required')
    expect(service.getContentVersion('ws_demo', source.id).body.title).not.toBe('较短标题')
    expect(() => service.preparePublish(task.id)).toThrowError(DomainError)
    expect(job.state).toBe('rejected')
  })

  it('derives content and confirmation from the selected product snapshot', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    expect(draft.body.detail).toContain('轻云防晒外套 2026')
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    expect(() => service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: 'tampered', remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'tampered-hash' })).toThrowError(DomainError)
    expect(() => service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: 'stale', idempotencyKey: 'stale-snapshot' })).toThrowError(DomainError)
  })

  it('restores the confirmed task input snapshot after an API restart', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_restart_snapshot', platform: 'taobao', title: '冻结外套', price: 199, stock: 12 })
    service.confirmProductFacts('ws_restart_snapshot', product.id)
    const task = service.createTask({ workspaceId: 'ws_restart_snapshot', productId: product.id, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_restart_snapshot', task.id, 'merchant')
    const persistedTask = structuredClone(service.getTask(task.id))
    product.title = '后来修改的标题'
    product.price = 299
    product.stock = 1

    const restarted = new MerchantService({ seedFixture: false })
    restarted.hydrateSnapshot({ entityType: 'product', entity: structuredClone(product) })
    restarted.hydrateSnapshot({ entityType: 'task', entity: persistedTask })
    const restored = restarted.taskInputSnapshots.get(persistedTask.inputSnapshotId)
    expect(restored).toMatchObject({ product: { title: '冻结外套', price: 199, stock: 12 } })
    const draft = restarted.createDraft(task.id)
    expect(draft.body.title).toContain('冻结外套')
    expect(draft.body.detail).toContain('库存 12')
  })

  it('freezes scoped yuan promotion prices and rejects ambiguous or expired promotion input', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_promotion', platform: 'taobao', title: '促销外套', stock: 20, skus: [
      { id: 'sku-black-m', name: '黑色 M', price: 199, stock: 10 },
      { id: 'sku-black-l', name: '黑色 L', price: 219, stock: 10 },
    ] })
    service.confirmProductFacts('ws_promotion', product.id)
    const task = service.createTask({ workspaceId: 'ws_promotion', productId: product.id, platform: 'taobao' })
    expect(() => service.answerTask('ws_promotion', task.id, { promotion_json: JSON.stringify([{ kind: 'activity', label: '秋季活动', price_cny: 179.99, valid_to: '2026-12-31T23:59:59Z' }]) })).toThrowError(expect.objectContaining({ code: 'PROMOTION_SKU_SCOPE_REQUIRED' }))
    const answered = service.answerTask('ws_promotion', task.id, { sku_id: 'sku-black-m', promotion_json: JSON.stringify([{ kind: 'activity', label: '秋季活动', original_price_cny: 199, price_cny: 179.99, sku_ids: ['sku-black-m'], valid_from: '2026-08-25T00:00:00Z', valid_to: '2026-12-31T23:59:59Z' }]) })
    expect(answered.answers.promotion_json).toContain('179.99')
    const selected = service.selectDirection(task.id, 'A')
    expect(selected.productionPlan?.promotionPriceDiff).toEqual([{ promotionId: expect.any(String), label: '秋季活动', skuId: 'sku-black-m', basePriceCny: 199, displayPriceCny: 179.99, deltaCny: -19.01 }])
    expect(() => service.confirmProductionPlan('ws_promotion', task.id, 'merchant')).toThrowError(expect.objectContaining({ code: 'PRICE_IMPACT_CONFIRMATION_REQUIRED' }))
    service.confirmProductionPlan('ws_promotion', task.id, 'merchant', undefined, true)
    expect(service.taskInputSnapshots.get(task.inputSnapshotId)?.promotions).toMatchObject([{ skuIds: ['sku-black-m'], priceCny: 179.99, validTo: '2026-12-31T23:59:59.000Z' }])
    expect(service.createDraft(task.id).body.brief?.priceExpression).toContain('179.99')
    const expiredTask = service.createTask({ workspaceId: 'ws_promotion', productId: product.id, platform: 'taobao' })
    expect(() => service.answerTask('ws_promotion', expiredTask.id, { sku_id: 'sku-black-m', promotion_json: JSON.stringify([{ kind: 'coupon', label: '过期券', coupon_price_cny: 99, sku_ids: ['sku-black-m'], valid_to: '2026-01-01T00:00:00Z' }]) })).toThrowError(expect.objectContaining({ code: 'PROMOTION_EXPIRED' }))
  })

  it('revalidates a frozen promotion before export while preserving historical evidence', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_promotion_export', platform: 'taobao', title: '导出促销外套', stock: 10, price: 199 })
    service.confirmProductFacts('ws_promotion_export', product.id)
    const task = service.createTask({ workspaceId: 'ws_promotion_export', productId: product.id, platform: 'taobao' })
    const validTo = new Date(Date.now() + 2 * 86400000).toISOString()
    service.answerTask('ws_promotion_export', task.id, { promotion_json: JSON.stringify([{ kind: 'activity', label: '限时价', price_cny: 179.99, valid_to: validTo }]) })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_promotion_export', task.id, 'merchant', undefined, true)
    const version = service.createDraft(task.id)
    vi.setSystemTime(new Date(Date.parse(validTo) + 86400000))
    try {
      expect(() => service.exportContent('ws_promotion_export', version.id, 'manifest')).toThrowError(expect.objectContaining({ code: 'CONTENT_EXPORT_BLOCKED' }))
      expect(service.getContentVersion('ws_promotion_export', version.id)).toMatchObject({ deliveryStatus: 'expired', deliveryStatusReason: expect.stringContaining('过期') })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a publish confirmation when the product changed after preview', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    const product = service.products.get('prod_fixture_1')!
    product.stock += 1
    expect(() => service.confirmPublish({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: 'changed-product' })).toThrowError(/商品事实已发生变化/)
  })

  it('enqueues idempotent generation jobs and materializes one immutable content version', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'test-merchant')
    const first = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: task.id, idempotencyKey: 'gen-1' })
    const duplicate = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: task.id, idempotencyKey: 'gen-1' })
    expect(duplicate.id).toBe(first.id)
    const completed = service.completeGeneration({ workspaceId: 'ws_demo', jobId: first.id, body: { title: '模型标题', detail: '模型详情', sellingPoints: ['事实卖点'] } })
    expect(completed.job.state).toBe('succeeded')
    expect(completed.version.state).toBe('review_required')
    expect(service.generationJobs.size).toBe(1)
    expect(service.completeGeneration({ workspaceId: 'ws_demo', jobId: first.id, body: { title: '不同标题', detail: '不同详情', sellingPoints: ['不同卖点'] } }).version.id).toBe(completed.version.id)
  })

  it('serializes synchronous generation retries and replays the same content version', async () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'test-merchant')
    const [first, concurrent] = await Promise.all([
      service.generateDraft(task.id, 'sync-generation-1'),
      service.generateDraft(task.id, 'sync-generation-1'),
    ])
    expect(concurrent.id).toBe(first.id)
    expect(service.listContentVersions('ws_demo', task.id)).toHaveLength(1)
    expect((await service.generateDraft(task.id, 'sync-generation-1')).id).toBe(first.id)
    const otherTask = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(otherTask.id, 'A')
    service.confirmProductionPlan('ws_demo', otherTask.id, 'test-merchant')
    await expect(service.generateDraft(otherTask.id, 'sync-generation-1')).rejects.toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }))
  })

  it('preserves provider-success settlement failures instead of mapping them to provider failure', async () => {
    const contentGenerator = {
      generate: async () => { throw Object.assign(new Error('local settlement sink failed'), { code: 'MODEL_USAGE_SETTLEMENT_PENDING', receiptKey: 'relay-request-1', providerSucceeded: true }) },
    }
    const service = new MerchantService({ fixtureMode: true, contentGenerator })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'merchant')
    await expect(service.generateDraft(task.id)).rejects.toMatchObject({
      code: 'MODEL_USAGE_SETTLEMENT_PENDING',
      status: 503,
      details: { provider_succeeded: true, receipt_key: 'relay-request-1' },
    })
  })

  it('rejects malformed content.generate output before materializing a version', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'merchant')
    const job = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: task.id, idempotencyKey: 'schema-generate' })
    expect(() => service.completeGeneration({ workspaceId: 'ws_demo', jobId: job.id, body: { title: '标题', detail: '详情', sellingPoints: ['卖点'], brief: {} as never } })).toThrowError(expect.objectContaining({ code: 'CONTENT_SCHEMA_INVALID', status: 400 }))
    expect(job.state).not.toBe('succeeded')
    expect(service.listContentVersions('ws_demo', task.id)).toHaveLength(0)
  })

  it('rejects malformed content.codex.commit output before saving a formal version', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'merchant')
    expect(() => service.commitCodexDraft({ taskId: task.id, body: { title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'hero', title: '首屏', purpose: '用途', body: '内容', factSourceIds: [] }] as never } })).toThrowError(expect.objectContaining({ code: 'CONTENT_SCHEMA_INVALID', status: 400 }))
    expect(service.listContentVersions('ws_demo', task.id)).toHaveLength(0)
  })

  it('forces production content generation through the platform-managed model path', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const service = new MerchantService({ fixtureMode: true })
      const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
      service.selectDirection(task.id, 'A')
      service.confirmProductionPlan('ws_demo', task.id, 'merchant')
      expect(() => service.prepareCodexDraft(task.id)).toThrowError(expect.objectContaining({ code: 'PLATFORM_GENERATION_REQUIRED', status: 409 }))
      expect(() => service.commitCodexDraft({ taskId: task.id, body: { title: '标题', detail: '详情', sellingPoints: ['卖点'] } })).toThrowError(expect.objectContaining({ code: 'PLATFORM_GENERATION_REQUIRED', status: 409 }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects every formal generation entry before plan confirmation in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const service = new MerchantService({ fixtureMode: true })
      const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
      service.selectDirection(task.id, 'A')
      expect(() => service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: task.id, idempotencyKey: 'gate-generation' })).toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
      await expect(service.generateDraft(task.id)).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
      expect(() => service.prepareCodexDraft(task.id)).toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
      expect(() => service.commitCodexDraft({ taskId: task.id, body: { title: '标题', detail: '详情', sellingPoints: ['卖点'] } })).toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
      expect(() => service.enqueueImageGeneration({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', taskId: task.id, idempotencyKey: 'gate-image' })).toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('freezes product, sku, price, stock, rules and selected assets at plan confirmation', () => {
    const service = new MerchantService({ fixtureMode: true, seedFixture: false })
    const product = service.importProduct({
      workspaceId: 'ws_snapshot', platform: 'taobao', title: '快照外套', price: 199, stock: 12,
      skus: [{ id: 'sku-blue-m', name: '蓝色/M', price: 199, stock: 7 }], skuCount: 1,
    })
    const asset = service.registerAsset({ workspaceId: 'ws_snapshot', name: 'source.png', mimeType: 'image/png', sizeBytes: 10, sha256: 'c'.repeat(64), storageKey: 'quarantine/ws_snapshot/source.png', rightsStatus: 'approved', rightsScope: 'commercial_authorized', applicablePlatforms: ['taobao'], usageScopes: ['commercial'] })
    asset.scanStatus = 'clean'
    const task = service.createTask({ workspaceId: 'ws_snapshot', productId: product.id, platform: 'taobao' })
    service.answerTask('ws_snapshot', task.id, { asset_ids: [asset.id], confirm_facts: true })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_snapshot', task.id, 'merchant')
    const snapshot = service.taskInputSnapshots.get(task.inputSnapshotId)
    expect(snapshot).toMatchObject({ product: { title: '快照外套', price: 199, stock: 12 }, skuIds: ['sku-blue-m'], assets: [{ id: asset.id, revision: 1 }], ruleVersionIds: expect.arrayContaining(['cn-commerce-1.0.0']) })

    product.title = '实时已变更商品'
    product.price = 1
    product.stock = 0
    product.skus = [{ id: 'sku-new', name: '新 SKU', price: 1, stock: 0 }]
    service.ruleCenter.setStatus({ packId: 'cn-commerce', version: 'cn-commerce-1.0.0', status: 'inactive', actorId: 'rules-owner', reason: '测试规则变更' })

    const draft = service.createDraft(task.id)
    expect(draft.body.title).toContain('快照外套')
    expect(draft.body.detail).toContain('当前库存 12')
    expect(draft.versionVector).toMatchObject({ taskInputSnapshotId: snapshot?.id, skuIds: ['sku-blue-m'], ruleSnapshotId: expect.stringContaining('cn-commerce-1.0.0') })
  })

  it('blocks explicitly selected assets that are not authorized for generation', () => {
    const service = new MerchantService({ fixtureMode: true, seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_asset_scope', platform: 'taobao', title: '授权边界外套', price: 199, stock: 1 })
    const asset = service.registerAsset({ workspaceId: 'ws_asset_scope', name: 'cn-only.png', mimeType: 'image/png', sizeBytes: 10, sha256: '9'.repeat(64), storageKey: 'quarantine/ws_asset_scope/cn-only.png', rightsStatus: 'approved', rightsScope: 'commercial_authorized', applicablePlatforms: ['taobao'], applicableRegions: ['CN'], usageScopes: ['commercial'] })
    asset.scanStatus = 'clean'
    const task = service.createTask({ workspaceId: 'ws_asset_scope', productId: product.id, platform: 'taobao' })
    service.answerTask('ws_asset_scope', task.id, { asset_ids: [asset.id], confirm_facts: true })
    service.selectDirection(task.id, 'A')
    expect(() => service.confirmProductionPlan('ws_asset_scope', task.id, 'merchant')).toThrowError(expect.objectContaining({ code: 'ASSET_NOT_READY' }))
  })

  it('blocks unconfirmed document facts at the application boundary and releases after merchant confirmation', () => {
    const service = new MerchantService({ fixtureMode: true, seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_asset_facts', platform: 'taobao', title: '事实外套', price: 199, stock: 1 })
    const asset = service.registerAsset({ workspaceId: 'ws_asset_facts', name: '商品资料.txt', mimeType: 'text/plain', sizeBytes: 10, sha256: 'a'.repeat(64), storageKey: 'quarantine/ws_asset_facts/facts.txt', rightsStatus: 'approved', rightsScope: 'commercial_authorized', applicablePlatforms: ['taobao'], usageScopes: ['commercial'] })
    asset.scanStatus = 'clean'
    const task = service.createTask({ workspaceId: 'ws_asset_facts', productId: product.id, platform: 'taobao' })
    service.answerTask('ws_asset_facts', task.id, { asset_ids: [asset.id], confirm_facts: true })
    service.selectDirection(task.id, 'A')
    expect(() => service.confirmProductionPlan('ws_asset_facts', task.id, 'merchant')).toThrowError(expect.objectContaining({ code: 'ASSET_NOT_READY', details: expect.objectContaining({ parse_status: 'pending', facts_confirmed: false }) }))
    service.updateAssetParse({ workspaceId: 'ws_asset_facts', assetId: asset.id, state: 'succeeded', source: 'manual', confirmedBy: 'merchant', facts: { material: '防晒面料' } })
    expect(service.confirmProductionPlan('ws_asset_facts', task.id, 'merchant').state).toBe('plan_confirmed')
  })

  it('enforces a workspace-wide active job quota while preserving idempotent retries', () => {
    const service = new MerchantService({ fixtureMode: true, maxActiveJobsPerWorkspace: 1 })
    const firstTask = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(firstTask.id, 'A')
    service.confirmProductionPlan('ws_demo', firstTask.id, 'test-merchant')
    const first = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: firstTask.id, idempotencyKey: 'quota-1' })
    expect(service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: firstTask.id, idempotencyKey: 'quota-1' }).id).toBe(first.id)
    const secondTask = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(secondTask.id, 'A')
    service.confirmProductionPlan('ws_demo', secondTask.id, 'test-merchant')
    expect(() => service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: secondTask.id, idempotencyKey: 'quota-2' })).toThrowError(expect.objectContaining({ code: 'WORKSPACE_JOB_QUOTA_EXCEEDED', status: 429, details: expect.objectContaining({ retry_after_seconds: 5 }) }))
    service.completeGeneration({ workspaceId: 'ws_demo', jobId: first.id, body: { title: '完成', detail: '完成', sellingPoints: ['完成'] } })
    expect(service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: secondTask.id, idempotencyKey: 'quota-2' }).state).toBe('queued')
  })

  it('keeps a generation job queued and exposes the provider retry time when quota is exhausted', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'test-merchant')
    const job = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: task.id, idempotencyKey: 'quota-visible' })
    const deferred = service.deferGeneration({ workspaceId: 'ws_demo', jobId: job.id, code: 'QUOTA_EXHAUSTED', message: '等待模型额度恢复', retryAfterSeconds: 12 })
    expect(deferred).toMatchObject({ state: 'queued', errorCode: 'QUOTA_EXHAUSTED', waitingReason: 'provider_quota' })
    expect(Date.parse(deferred.nextAttemptAt!)).toBeGreaterThan(Date.now())
    expect(service.getJobQueueMetadata('ws_demo', { type: 'generation', jobId: job.id })).toMatchObject({ queue_position: 1, queue_state: 'waiting' })
  })

  it('persists synced products into the workspace catalog with a stable remote identity', () => {
    const service = new MerchantService()
    const first = service.upsertSyncedProducts({ workspaceId: 'ws_sync', platform: 'jd', items: [{ remoteId: 'JD-1', title: '夹克', sku: [{ id: 'sku-1' }], stock: 12, source: 'official_api' }] })
    const second = service.upsertSyncedProducts({ workspaceId: 'ws_sync', platform: 'jd', items: [{ remoteId: 'JD-1', title: '夹克更新', sku: [{ id: 'sku-1' }, { id: 'sku-2' }], stock: 9, source: 'official_api' }] })
    expect(first[0]?.id).toBe('prod_jd_JD-1')
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(service.listProducts('ws_sync')).toMatchObject([{ title: '夹克更新', skuCount: 2, stock: 9, factsConfirmed: false }])
  })

  it('supports tenant-scoped product and task history search filters', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_history', platform: 'jd', remoteId: 'jd-42', title: '春季夹克', storeName: '旗舰店', stock: 3, skuCount: 1 })
    service.upsertBrandProfile({ workspaceId: 'ws_history', name: '云朵轻户外' })
    expect(service.listProducts('ws_history', { query: '夹克', platform: 'jd', storeName: '旗舰' })).toHaveLength(1)
    expect(service.listProducts('ws_history', { brandName: '云朵' })).toHaveLength(1)
    expect(service.listProducts('ws_other', { query: '夹克' })).toHaveLength(0)
    const task = service.createTask({ workspaceId: 'ws_history', productId: product.id, platform: 'jd' })
    expect(service.listTasks('ws_history', { query: '春季', state: 'draft', brandName: '云朵' })).toEqual([expect.objectContaining({ id: task.id, productId: product.id })])
    expect(service.listTasks('ws_other')).toHaveLength(0)
  })

  it('supports PRD catalog and task history filters for SKU, remote identity, sync and publish state', () => {
    const service = new MerchantService()
    const accountId = 'acct-filter'
    const [product] = service.upsertSyncedProducts({ workspaceId: 'ws_filter', platform: 'taobao', accountId, items: [{ remoteId: 'TB-FILTER-1', title: '筛选外套', sku: [{ id: 'sku-filter', name: '蓝色/M', price: 99, stock: 4 }], stock: 4, source: 'official_api', listingStatus: 'on_sale' }] })
    const sync = service.createSyncJob({ workspaceId: 'ws_filter', platform: 'taobao', accountId })
    service.updateSyncJob('ws_filter', sync.id, { state: 'succeeded' })
    expect(service.listProducts('ws_filter', { skuId: 'sku-filter', remoteProductId: 'TB-FILTER-1', listingStatus: 'on_sale', syncStatus: 'succeeded' })).toEqual([product])
    const task = service.createTask({ workspaceId: 'ws_filter', productId: product!.id, platform: 'taobao', accountId })
    expect(service.listTasks('ws_filter', { accountId, storeName: 'taobao 店铺', remoteProductId: 'TB-FILTER-1' })).toEqual([task])
  })

  it('removes a not-yet-persisted sync job during failed request compensation', () => {
    const service = new MerchantService()
    const job = service.createSyncJob({ workspaceId: 'ws_sync_compensation', platform: 'taobao', accountId: 'acct-compensation' })
    expect(service.removeSyncJob('ws_other', job.id)).toBe(false)
    expect(service.removeSyncJob('ws_sync_compensation', job.id)).toBe(true)
    expect(() => service.getSyncJob('ws_sync_compensation', job.id)).toThrow('同步任务不存在或不属于当前工作区')
  })

  it('preserves per-SKU identity, price, stock and image mapping', () => {
    const service = new MerchantService()
    const imported = service.importProduct({ workspaceId: 'ws_sku', platform: 'taobao', title: '多 SKU 外套', stock: 8, skus: [
      { id: 'sku-blue-m', name: '雾蓝/M', price: 129, stock: 3, images: ['fixture://blue-m.jpg'] },
      { id: 'sku-black-l', name: '黑色/L', price: 139, stock: 5, images: ['fixture://black-l.jpg'] },
    ] })
    expect(imported).toMatchObject({ skuCount: 2, skus: [
      { id: 'sku-blue-m', price: 129, stock: 3, images: ['fixture://blue-m.jpg'] },
      { id: 'sku-black-l', price: 139, stock: 5, images: ['fixture://black-l.jpg'] },
    ] })
    const synced = service.upsertSyncedProducts({ workspaceId: 'ws_sku', platform: 'taobao', items: [{ remoteId: 'remote-sku', title: '同步外套', sku: [{ id: 'remote-blue', name: '蓝色', price: 99, stock: 2 }], stock: 2, source: 'official_api' }] })
    expect(synced[0]).toMatchObject({ skuCount: 1, skus: [{ id: 'remote-blue', price: 99, stock: 2 }] })
    const updated = service.updateProductSku({ workspaceId: 'ws_sku', productId: imported.id, skuId: 'sku-blue-m', price: 139, stock: 7, attributes: { color: '雾蓝', size: 'M' } })
    expect(updated).toMatchObject({ factsConfirmed: false, stock: 12 })
    expect(updated.skus).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sku-blue-m', price: 139, stock: 7, attributes: { color: '雾蓝', size: 'M' } }),
    ]))
    const productUpdated = service.updateProductFacts({ workspaceId: 'ws_sku', productId: imported.id, title: '雾蓝防晒外套', category: '女装/外套', images: ['fixture://hero.jpg', 'fixture://detail.jpg'], attributes: { material: '锦纶' }, expectedVersion: updated.version })
    expect(productUpdated).toMatchObject({ title: '雾蓝防晒外套', category: '女装/外套', factsConfirmed: false, images: ['fixture://hero.jpg', 'fixture://detail.jpg'], attributes: { material: '锦纶' } })
    expect(() => service.updateProductSku({ workspaceId: 'ws_other', productId: imported.id, skuId: 'sku-blue-m', stock: 1 })).toThrowError(expect.objectContaining({ code: 'PRODUCT_NOT_FOUND' }))
  })

  it('records task-scoped feedback and enforces version and workspace boundaries', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    const feedback = service.submitFeedback({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: version.id, rating: 'needs_improvement', reason: '标题过长', comment: '请突出核心卖点', actorId: 'actor_1' })
    expect(feedback).toMatchObject({ taskId: task.id, contentVersionId: version.id, rating: 'needs_improvement', actorId: 'actor_1' })
    expect(service.listFeedback('ws_demo', task.id)).toEqual([feedback])
    expect(() => service.listFeedback('ws_other', task.id)).toThrowError(DomainError)
    expect(() => service.submitFeedback({ workspaceId: 'ws_demo', taskId: task.id, contentVersionId: 'cv_other', rating: 'liked', actorId: 'actor_1' })).toThrowError(DomainError)
    expect(() => service.submitFeedback({ workspaceId: 'ws_demo', taskId: task.id, rating: 'liked', comment: 'x'.repeat(2001), actorId: 'actor_1' })).toThrowError(DomainError)
  })

  it('requires an explicit facts confirmation before task creation can proceed', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_facts', platform: 'taobao', remoteId: 'facts-1', title: '待确认商品', stock: 2, skuCount: 1, storeName: '春风店', storeDifferentiation: '面向城市通勤客群，强调轻量化' })
    expect(product).toMatchObject({ storeName: '春风店', storeDifferentiation: '面向城市通勤客群，强调轻量化' })
    const draftTask = service.createTask({ workspaceId: 'ws_facts', productId: product.id, platform: 'taobao' })
    expect(draftTask.state).toBe('draft')
    expect(() => service.selectDirection(draftTask.id, 'A')).toThrowError(DomainError)
    service.confirmProductFacts('ws_facts', product.id)
    expect(service.createTask({ workspaceId: 'ws_facts', productId: product.id, platform: 'taobao' }).state).toBe('ready_for_direction')
  })

  it('does not overwrite another workspace when remote product or account ids collide', () => {
    const service = new MerchantService()
    const first = service.upsertSyncedProducts({ workspaceId: 'ws_one', platform: 'jd', items: [{ remoteId: 'same', title: 'one', sku: [], stock: 1, source: 'official_api' }] })[0]!
    const second = service.upsertSyncedProducts({ workspaceId: 'ws_two', platform: 'jd', items: [{ remoteId: 'same', title: 'two', sku: [], stock: 2, source: 'official_api' }] })[0]!
    expect(first.id).not.toBe(second.id)
    expect(service.listProducts('ws_one')).toEqual([expect.objectContaining({ title: 'one', remoteId: 'same' })])
    expect(service.listProducts('ws_two')).toEqual([expect.objectContaining({ title: 'two', remoteId: 'same' })])
    const accountOne = service.registerPlatformAccount({ workspaceId: 'ws_one', platform: 'jd', remoteAccountId: 'same-account', credentialRef: 'vault://one' })
    const accountTwo = service.registerPlatformAccount({ workspaceId: 'ws_two', platform: 'jd', remoteAccountId: 'same-account', credentialRef: 'vault://two' })
    expect(accountOne.id).not.toBe(accountTwo.id)
    expect(service.getPlatformAccount('ws_one', accountOne.id).credentialRef).toBe('vault://one')
    expect(service.getPlatformAccount('ws_two', accountTwo.id).credentialRef).toBe('vault://two')
    const storeOne = service.upsertSyncedProducts({ workspaceId: 'ws_multi', platform: 'jd', accountId: 'store-a', items: [{ remoteId: 'same-product', title: '店铺 A 商品', sku: [], stock: 1, source: 'official_api' }] })[0]!
    const storeTwo = service.upsertSyncedProducts({ workspaceId: 'ws_multi', platform: 'jd', accountId: 'store-b', items: [{ remoteId: 'same-product', title: '店铺 B 商品', sku: [], stock: 2, source: 'official_api' }] })[0]!
    expect(storeOne.id).not.toBe(storeTwo.id)
    expect(storeOne.accountId).toBe('store-a')
    expect(storeTwo.accountId).toBe('store-b')
  })

  it('keeps approved and delivered versions immutable and restores by creating a new version', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const approvedSource = service.createDraft(task.id)
    service.approveContent(task.id, approvedSource.id)
    const sourceBody = JSON.stringify(approvedSource.body)
    approvedSource.state = 'delivered'

    const restored = service.restoreContentVersion('ws_demo', approvedSource.id)
    expect(restored.source.id).toBe(approvedSource.id)
    expect(restored.source.state).toBe('delivered')
    expect(restored.version.parentId).toBe(approvedSource.id)
    expect(restored.version.version).toBe(2)
    expect(restored.version.state).toBe('review_required')
    expect(JSON.stringify(approvedSource.body)).toBe(sourceBody)
    expect(restored.task.contentVersionId).toBe(restored.version.id)
    expect(restored.task.state).toBe('review_required')
    expect(service.listContentVersions('ws_demo', task.id).map(version => version.version)).toEqual([1, 2])
  })

  it('returns a deterministic diff and does not expose another workspace version', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const first = service.createDraft(task.id)
    const second = service.restoreContentVersion('ws_demo', first.id).version
    second.body.title = '恢复后的标题'
    const diff = service.diffContentVersions('ws_demo', second.id, first.id)
    expect(diff.changes).toContainEqual({ path: 'body.title', before: first.body.title, after: '恢复后的标题' })
    expect(() => service.listContentVersions('ws_other', task.id)).toThrowError(DomainError)
    expect(() => service.getContentVersion('ws_other', first.id)).toThrowError(DomainError)
  })

  it('keeps three active creative directions while versioning merge and modify operations', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    const initial = service.listCreativeDirections('ws_demo', task.id)
    const merged = service.updateCreativeDirections({ workspaceId: 'ws_demo', taskId: task.id, action: 'merge', directionIds: [initial[0]!.id, initial[1]!.id], expectedVersion: task.version })
    expect(merged.directions).toHaveLength(3)
    expect(merged.newDirection?.id).toBe('MERGE-v1')
    expect(merged.task.directionHistory).toHaveLength(3)
    const modified = service.updateCreativeDirections({ workspaceId: 'ws_demo', taskId: task.id, action: 'modify', directionId: 'MERGE-v1', changes: { visualDirection: '改为冷色中性背景' }, expectedVersion: merged.task.version })
    expect(modified.directions).toHaveLength(3)
    expect(modified.newDirection?.id).toBe('MERGE-v1-v2')
    expect(modified.task.directionHistory).toHaveLength(6)
  })

  it('exports structured content without inventing a publish receipt', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    const manifest = service.exportContent('ws_demo', version.id, 'manifest')
    expect(manifest.fileName).toBe('manifest-v1.json')
    const parsed = JSON.parse(manifest.body) as { publish_receipt: null; publish: { status: string }; files: string[] }
    expect(parsed.publish_receipt).toBeNull()
    expect(parsed.files).toEqual(expect.arrayContaining(['README.md', 'review-findings.json', 'source-map.json']))
    expect(parsed.publish.status).toBe('not_published')
    const markdown = service.exportContent('ws_demo', version.id, 'markdown')
    expect(markdown.contentType).toContain('text/markdown')
    expect(markdown.body).toContain('不代表平台已发布')
    const bundle = service.exportContent('ws_demo', version.id, 'bundle')
    expect(bundle.fileName).toBe('content-v1-bundle.zip')
    expect(bundle.contentType).toBe('application/zip')
    expect(Array.from(bundle.binaryBody?.slice(0, 4) ?? [])).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('always includes a static brief in generated content and exports it', () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    product.skus = [{ id: 'TB-SKU-WHITE-S', name: '云白/S', price: 169, stock: 10, images: ['fixture://sku-white-s.jpg'] }]
    product.skuCount = 1
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    expect(version.body.brief).toMatchObject({ platform: 'taobao', protectedAreas: expect.arrayContaining(['Logo']) })
    expect(version.body.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'hero', factSourceIds: expect.arrayContaining([expect.stringContaining('product:')]) }),
      expect.objectContaining({ key: 'sku', referencedSkuIds: expect.arrayContaining(['TB-SKU-WHITE-S']) }),
      expect.objectContaining({ key: 'solution' }),
      expect.objectContaining({ key: 'details_craft' }),
      expect.objectContaining({ key: 'usage_scenarios' }),
      expect.objectContaining({ key: 'size_guide' }),
      expect.objectContaining({ key: 'evidence' }),
      expect.objectContaining({ key: 'package' }),
      expect.objectContaining({ key: 'after_sales' }),
      expect.objectContaining({ key: 'brand' }),
      expect.objectContaining({ key: 'cta' }),
      expect.objectContaining({ key: 'platform' }),
    ]))
    expect(version.body.modules?.find(module => module.key === 'evidence')?.body).toContain('[待确认]')
    const json = service.exportContent('ws_demo', version.id, 'json')
    expect(JSON.parse(json.body).brief).toMatchObject({ placement: expect.any(String) })
    const markdown = service.exportContent('ws_demo', version.id, 'markdown')
    expect(markdown.body).toContain('静态素材 Brief')
  })

  it('does not upgrade or mutate historical versions during a read', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    version.body.modules = [{ key: 'legacy_visual', title: '历史视觉说明', purpose: '保留旧版本内容', body: '历史模块正文', factSourceIds: version.factVersionIds }]
    const before = JSON.stringify(version.body)
    const restored = service.listContentVersions('ws_demo', task.id)[0]!
    expect(restored.body.modules?.map(module => module.key)).toEqual(['legacy_visual'])
    expect(restored.body.modules?.find(module => module.key === 'legacy_visual')?.body).toBe('历史模块正文')
    expect(JSON.stringify(version.body)).toBe(before)
  })

  it('reviews legacy incomplete content snapshots without mutating or crashing', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    version.body.modules = [{ heading: '历史模块', body: '旧版正文' }] as unknown as typeof version.body.modules
    version.body.brief = { cta: '查看详情' } as unknown as typeof version.body.brief
    const before = JSON.stringify(version.body)

    const findings = service.reviewContent('ws_demo', version.id)

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_SOURCE', field: 'modules.legacy_1' }),
      expect.objectContaining({ code: 'VISUAL_BRIEF_INCOMPLETE', field: 'brief' }),
      expect.objectContaining({ code: 'TECHNICAL_SCHEMA_INVALID', field: 'content.schema' }),
    ]))
    expect(JSON.stringify(version.body)).toBe(before)
  })

  it('freezes approval review evidence so repeated historical bundles stay byte-identical', () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    const task = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    const approved = service.approveContent(task.id, version.id)
    expect(approved.version.reviewSnapshot).toMatchObject({ findings: expect.any(Array), reviewedAt: expect.any(String) })
    const first = service.exportContent('ws_demo', version.id, 'bundle').binaryBody
    product.title = '后来修改的商品标题'
    product.price = 9999
    product.images = ['https://example.com/a.jpg', 'https://example.com/a.jpg']
    product.version = (product.version ?? 1) + 1
    const second = service.exportContent('ws_demo', version.id, 'bundle').binaryBody
    expect(second).toEqual(first)
    const manifest = JSON.parse(service.exportContent('ws_demo', version.id, 'manifest').body) as { files: string[] }
    expect(manifest.files).toContain('review-findings.json')
  })

  it('runs deterministic review before approval', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    expect(service.reviewContent('ws_demo', draft.id)).toEqual([])
    expect(service.approveContent(task.id, draft.id).version.state).toBe('approved')
  })

  it('persists P1/P2 review decisions but never allows a P0 blocker to be bypassed', () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.products.get('prod_fixture_1')!
    product.images = ['https://cdn.example.com/main.jpg', 'https://cdn.example.com/main.jpg']
    const task = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    const warning = service.reviewContent('ws_demo', version.id).find(item => item.code === 'DUPLICATE_IMAGE')!
    const decided = service.setReviewFindingDecision({ workspaceId: 'ws_demo', contentVersionId: version.id, code: warning.code, field: warning.field, status: 'waived', reason: '候选图用于对比，发布前会删除', actorId: 'merchant-1', expectedRevision: version.revision })
    expect(decided.report.findings).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_IMAGE', status: 'waived', decision: expect.objectContaining({ reason: '候选图用于对比，发布前会删除' }) }))
    expect(decided.version.reviewDecisions).toHaveLength(1)

    product.images = []
    const blocker = service.reviewContent('ws_demo', version.id).find(item => item.code === 'MAIN_IMAGE_REQUIRED')!
    expect(() => service.setReviewFindingDecision({ workspaceId: 'ws_demo', contentVersionId: version.id, code: blocker.code, field: blocker.field, status: 'acknowledged', actorId: 'merchant-1' })).toThrowError(expect.objectContaining({ code: 'REVIEW_P0_DECISION_FORBIDDEN' }))
  })

  it('freezes the bound brand revision and blocks brand forbidden terms', () => {
    const service = new MerchantService({ fixtureMode: true })
    const brand = service.upsertBrandProfile({ workspaceId: 'ws_demo', name: '云朵', forbiddenTerms: ['顶级'] })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    expect(task.answers.brand_id).toBe(brand.id)
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    version.body.title = '云朵顶级防晒外套'

    service.upsertBrandProfile({ workspaceId: 'ws_demo', name: '云朵', forbiddenTerms: ['至尊'], resolutions: { forbiddenTerms: 'candidate' } })
    const report = service.reviewContentReport('ws_demo', version.id)
    const finding = report.findings.find(item => item.code === 'BRAND_FORBIDDEN_TERM')!
    expect(finding).toMatchObject({ priority: 'P0', evidence: { kind: 'brand', sourceIds: [`brand:${brand.id}:r${brand.revision}`] } })
    expect(report.categories.find(category => category.id === 'brand_consistency')).toMatchObject({ status: 'blocking', findingCount: 1 })
    expect(() => service.setReviewFindingDecision({ workspaceId: 'ws_demo', contentVersionId: version.id, code: finding.code, field: finding.field, status: 'acknowledged', actorId: 'merchant' })).toThrowError(expect.objectContaining({ code: 'REVIEW_P0_DECISION_FORBIDDEN' }))
    expect(() => service.approveContent(task.id, version.id)).toThrow('内容存在未解决的阻断检查项')

    const restarted = new MerchantService({ fixtureMode: true })
    restarted.hydrateSnapshot({ entityType: 'task', entity: structuredClone(service.getTask(task.id)) })
    restarted.hydrateSnapshot({ entityType: 'content_version', entity: structuredClone(version) })
    expect(restarted.reviewContentReport('ws_demo', version.id).findings).toContainEqual(expect.objectContaining({ code: 'BRAND_FORBIDDEN_TERM', evidence: expect.objectContaining({ sourceIds: [`brand:${brand.id}:r${brand.revision}`] }) }))
  })

  it('rejects a brand binding from another workspace', () => {
    const service = new MerchantService({ fixtureMode: true })
    const foreign = service.upsertBrandProfile({ workspaceId: 'ws_other', name: '其他品牌' })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    expect(() => service.answerTask('ws_demo', task.id, { brand_id: foreign.id })).toThrowError(expect.objectContaining({ code: 'BRAND_PROFILE_NOT_FOUND' }))
  })

  it('blocks a content module that explicitly references an unknown SKU', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    draft.body.modules = [...(draft.body.modules ?? []), { key: 'sku-invalid', title: 'SKU', purpose: 'test', body: 'unknown', factSourceIds: ['product:prod_fixture_1:v1'], referencedSkuIds: ['SKU-NOT-FOUND'] }]
    expect(service.reviewContent('ws_demo', draft.id).some(finding => finding.code === 'SKU_MISMATCH')).toBe(true)
    expect(() => service.approveContent(task.id, draft.id)).toThrow('内容存在未解决的阻断检查项')
  })

  it('preserves brand conflicts until the user explicitly resolves the candidate', () => {
    const service = new MerchantService()
    const first = service.upsertBrandProfile({ workspaceId: 'ws_brand_conflict', name: '云朵', positioning: '轻户外', source: 'brand-guide-v1' })
    const conflicted = service.upsertBrandProfile({ workspaceId: 'ws_brand_conflict', name: '云朵', positioning: '城市通勤', source: 'campaign-brief' })
    expect(first.positioning).toBe('轻户外')
    expect(conflicted.positioning).toBe('轻户外')
    expect(conflicted.conflicts).toEqual([expect.objectContaining({ field: 'positioning', existingValue: '轻户外', candidateValue: '城市通勤', state: 'pending', source: 'campaign-brief' })])
    const resolved = service.upsertBrandProfile({ workspaceId: 'ws_brand_conflict', name: '云朵', positioning: '城市通勤', source: 'campaign-brief', resolutions: { positioning: 'candidate' } })
    expect(resolved.positioning).toBe('城市通勤')
    expect(resolved.conflicts).toBeUndefined()
  })

  it('validates typed brand visual rules and blocks generation until visual rights are ready', () => {
    const service = new MerchantService()
    expect(() => service.upsertBrandProfile({ workspaceId: 'ws_visual', name: '视觉品牌', visualRules: { colors: { primary: ['red'], secondary: [], forbidden: [] } } })).toThrowError(expect.objectContaining({ code: 'BRAND_VISUAL_RULES_INVALID' }))
    expect(() => service.upsertBrandProfile({ workspaceId: 'ws_visual', name: '视觉品牌', visualRules: { colors: { primary: ['#123456'], secondary: [], forbidden: ['#123456'] } } })).toThrowError(expect.objectContaining({ code: 'BRAND_VISUAL_RULES_INVALID' }))

    const asset = service.registerAsset({ workspaceId: 'ws_visual', name: 'brand-logo.png', mimeType: 'image/png', sizeBytes: 9, sha256: 'c'.repeat(64), storageKey: 'quarantine/ws_visual/brand-logo.png' })
    const profile = service.upsertBrandProfile({ workspaceId: 'ws_visual', name: '视觉品牌', visualRules: { logo: { assetIds: [asset.id], allowRecolor: false, allowDistortion: false, allowRedraw: false }, colors: { primary: ['#123456'], secondary: ['#ABCDEF'], forbidden: ['#FF0000'] }, fonts: [{ family: '品牌字体', licenseStatus: 'unknown' }] } })
    expect(profile.visualRules?.logo).toMatchObject({ allowRecolor: false, allowDistortion: false, allowRedraw: false })
    expect(service.getBrandVisualReadiness('ws_visual', 'taobao')).toMatchObject({ ready: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'LOGO_ASSET_NOT_READY' }), expect.objectContaining({ code: 'FONT_LICENSE_NOT_APPROVED' })]) })
    expect(() => service.assertBrandVisualGenerationReady('ws_visual', 'taobao')).toThrowError(expect.objectContaining({ code: 'BRAND_VISUAL_RULES_BLOCKED' }))

    asset.scanStatus = 'clean'; asset.rightsStatus = 'approved'; asset.rightsScope = 'commercial_authorized'; asset.applicablePlatforms = ['taobao']; asset.applicableRegions = ['CN']
    service.upsertBrandProfile({ workspaceId: 'ws_visual', name: '视觉品牌', visualRules: { ...profile.visualRules!, fonts: [{ family: '品牌字体', licenseStatus: 'approved' }] }, resolutions: { visualRules: 'candidate' } })
    expect(() => service.assertBrandVisualGenerationReady('ws_visual', 'taobao')).toThrowError(expect.objectContaining({ code: 'BRAND_VISUAL_RULES_BLOCKED' }))
    expect(service.assertBrandVisualGenerationReady('ws_visual', 'taobao', 'CN')).toMatchObject({ ready: true, configured: true })
  })

  it('rejects visual assets from another workspace', () => {
    const service = new MerchantService()
    const foreign = service.registerAsset({ workspaceId: 'ws_foreign', name: 'foreign-logo.png', mimeType: 'image/png', sizeBytes: 9, sha256: 'd'.repeat(64), storageKey: 'quarantine/ws_foreign/foreign-logo.png' })
    expect(() => service.upsertBrandProfile({ workspaceId: 'ws_visual_owner', name: '视觉品牌', visualRules: { logo: { assetIds: [foreign.id], allowRecolor: false, allowDistortion: false, allowRedraw: false } } })).toThrowError(expect.objectContaining({ code: 'BRAND_VISUAL_ASSET_NOT_FOUND' }))
  })

  it('normalizes prohibited people, spokesperson, IP and content rules and audits generated copy', () => {
    const service = new MerchantService()
    const profile = service.upsertBrandProfile({ workspaceId: 'ws_demo', name: '主体规则品牌', visualRules: { restrictedSubjects: { people: [' 某艺人 ', '某艺人'], spokespersons: ['竞品代言人'], intellectualProperties: ['未授权动漫角色'], prohibitedContent: ['吸烟场景'] } } })
    expect(profile.visualRules?.restrictedSubjects).toEqual({ people: ['某艺人'], spokespersons: ['竞品代言人'], intellectualProperties: ['未授权动漫角色'], prohibitedContent: ['吸烟场景'] })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    draft.body.detail = '联名未授权动漫角色，打造通勤体验。'
    expect(service.reviewContent('ws_demo', draft.id)).toContainEqual(expect.objectContaining({ severity: 'error', priority: 'P0', evidence: expect.objectContaining({ kind: 'brand' }) }))
  })

  it('rechecks frozen visual-rule assets before approval when rights later become invalid', () => {
    const service = new MerchantService()
    const logo = service.registerAsset({ workspaceId: 'ws_demo', name: 'brand-logo.png', mimeType: 'image/png', sizeBytes: 9, sha256: 'e'.repeat(64), storageKey: 'quarantine/ws_demo/brand-logo.png' })
    logo.scanStatus = 'clean'; logo.rightsStatus = 'approved'; logo.rightsScope = 'owned'; logo.applicablePlatforms = ['taobao']
    service.upsertBrandProfile({ workspaceId: 'ws_demo', name: '视觉品牌', visualRules: { logo: { assetIds: [logo.id], allowRecolor: false, allowDistortion: false, allowRedraw: false } } })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    logo.rightsStatus = 'rejected'
    expect(service.reviewContent('ws_demo', draft.id)).toContainEqual(expect.objectContaining({ code: 'BRAND_VISUAL_ASSET_NOT_READY', priority: 'P0', field: 'visualRules.logo' }))
    expect(() => service.approveContent(task.id, draft.id)).toThrowError(/阻断/u)
  })

  it('records explicit historical-asset preferences and feeds only eligible excellent assets into generation', () => {
    const service = new MerchantService()
    const asset = service.registerAsset({ workspaceId: 'ws_demo', name: '历史优秀主图.png', mimeType: 'image/png', sizeBytes: 9, sha256: 'f'.repeat(64), storageKey: 'quarantine/ws_demo/history.png' })
    asset.scanStatus = 'clean'; asset.rightsStatus = 'approved'; asset.rightsScope = 'owned'; asset.applicablePlatforms = ['taobao']
    expect(() => service.updateAssetPreference({ workspaceId: 'ws_demo', assetId: asset.id, verdict: 'excellent', reasons: [], actorId: 'merchant' })).toThrowError(expect.objectContaining({ code: 'ASSET_PREFERENCE_REASON_REQUIRED' }))
    const preferred = service.updateAssetPreference({ workspaceId: 'ws_demo', assetId: asset.id, verdict: 'excellent', reasons: ['商品主体清晰', '留白适合移动端'], actorId: 'merchant' })
    expect(preferred.preference).toMatchObject({ verdict: 'excellent', reasons: ['商品主体清晰', '留白适合移动端'], updatedBy: 'merchant' })

    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'merchant')
    expect(service.prepareCodexDraft(task.id).referenceAssets).toEqual([expect.objectContaining({ id: asset.id, preference: expect.objectContaining({ verdict: 'excellent', reasons: ['商品主体清晰', '留白适合移动端'] }) })])

    service.updateAssetPreference({ workspaceId: 'ws_demo', assetId: asset.id, verdict: 'disliked', reasons: ['背景干扰商品主体'], actorId: 'merchant', expectedRevision: preferred.revision })
    const blockedTask = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.answerTask('ws_demo', blockedTask.id, { asset_ids: [asset.id] })
    service.selectDirection(blockedTask.id, 'A')
    expect(() => service.confirmProductionPlan('ws_demo', blockedTask.id, 'merchant')).toThrowError(expect.objectContaining({ code: 'ASSET_PREFERENCE_BLOCKED' }))
  })

  it('keeps asset preference writes tenant-scoped and revision-safe', () => {
    const service = new MerchantService()
    const asset = service.registerAsset({ workspaceId: 'ws_asset_owner', name: 'history.png', mimeType: 'image/png', sizeBytes: 9, sha256: '1'.repeat(64), storageKey: 'quarantine/ws_asset_owner/history.png' })
    expect(() => service.updateAssetPreference({ workspaceId: 'ws_other', assetId: asset.id, verdict: 'excellent', reasons: ['清晰'], actorId: 'merchant' })).toThrowError(expect.objectContaining({ code: 'ASSET_NOT_FOUND' }))
    expect(() => service.updateAssetPreference({ workspaceId: 'ws_asset_owner', assetId: asset.id, verdict: 'excellent', reasons: ['清晰'], actorId: 'merchant', expectedRevision: asset.revision + 1 })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }))
  })

  it('binds the task to the exact immutable version selected for approval', () => {
    const service = new MerchantService()
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', accountId: 'acct_taobao_1' })
    service.selectDirection(task.id, 'A')
    const first = service.createDraft(task.id)
    const second = service.restoreContentVersion('ws_demo', first.id).version
    const approved = service.approveContent(task.id, first.id)
    expect(approved.version.id).toBe(first.id)
    expect(approved.task.contentVersionId).toBe(first.id)
    expect(approved.task.contentVersionId).not.toBe(second.id)
    expect(service.preparePublish(task.id).confirmationHash).toBeTruthy()
  })

  it('clones a historical task as a fresh input so stale content and promotion snapshots cannot leak', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_clone', platform: 'taobao', title: '复制边界外套', stock: 10, price: 199 })
    service.confirmProductFacts('ws_clone', product.id)
    const source = service.createTask({ workspaceId: 'ws_clone', productId: product.id, platform: 'taobao', accountId: 'store-taobao-1' })
    service.answerTask('ws_clone', source.id, { confirm_facts: true, promotion_json: JSON.stringify([{ kind: 'activity', label: '历史活动', price_cny: 179, sku_ids: [], valid_to: '2026-12-31T00:00:00Z' }]) })
    service.selectDirection(source.id, 'A')
    const draft = service.createDraft(source.id)
    const cloned = service.cloneTask('ws_clone', source.id, '重新制作常规价详情')
    expect(cloned).toMatchObject({ platform: 'taobao', accountId: 'store-taobao-1', state: 'ready_for_direction' })
    expect(cloned.id).not.toBe(source.id)
    expect(cloned.inputSnapshotId).not.toBe(source.inputSnapshotId)
    expect(cloned.contentVersionId).toBeUndefined()
    expect(cloned.answers.promotion_json).toBeUndefined()
    expect(service.listContentVersions('ws_clone', cloned.id)).toEqual([])
    expect(service.getContentVersion('ws_clone', draft.id).taskId).toBe(source.id)
  })

  it('clones a task to another platform only from an explicitly selected target product', () => {
    const service = new MerchantService({ seedFixture: false })
    const sourceProduct = service.importProduct({ workspaceId: 'ws_cross_clone', platform: 'taobao', title: '跨平台源商品', stock: 10, price: 199 })
    const targetProduct = service.importProduct({ workspaceId: 'ws_cross_clone', platform: 'jd', title: '京东目标商品', stock: 8, price: 209, accountId: 'store-jd-1' })
    service.confirmProductFacts('ws_cross_clone', sourceProduct.id)
    service.confirmProductFacts('ws_cross_clone', targetProduct.id)
    const source = service.createTask({ workspaceId: 'ws_cross_clone', productId: sourceProduct.id, platform: 'taobao', accountId: 'store-taobao-1' })
    service.selectDirection(source.id, 'A')
    service.createDraft(source.id)
    const cloned = service.cloneTask('ws_cross_clone', source.id, undefined, { productId: targetProduct.id, platform: 'jd' })
    expect(cloned).toMatchObject({ platform: 'jd', productId: targetProduct.id, accountId: 'store-jd-1', state: 'ready_for_direction' })
    expect(cloned.id).not.toBe(source.id)
    expect(cloned.contentVersionId).toBeUndefined()
    expect(cloned.answers.promotion_json).toBeUndefined()
  })
})
