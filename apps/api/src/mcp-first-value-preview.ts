import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { Platform, Product } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { FirstValuePreviewRuntime } from './server.js'

export async function merchantFirstValuePreview(workspaceId: string, params: Record<string, unknown>, req: IncomingMessage, dependencies: FirstValuePreviewRuntime) {
  const {
    contentGenerator, requirePlatformModelCostGate, createHash, enforceMcpCommercialAccess,
    assertProviderActionCanStart, reserveCreativePointsForModel, recordActionSettlement, requestActor,
    recordOperationAudit, providerSucceededButSettlementPending, persistence, unknownModelProviderReceipt,
    releaseReservedModelPoints, requireSettledContentExecutionEvidence, validateContentSchema,
    firstValueExecutionLabel, firstValueNextActions, isProduction, service,
  } = dependencies

  if (params.draft === 'true') {
    const idempotencyKey = typeof params.idempotency_key === 'string' ? params.idempotency_key.trim() : ''
    if (!idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '中转草稿生成必须携带幂等键', 400)
    if (!contentGenerator) throw new DomainError('AI_GENERATION_NOT_CONFIGURED', '平台文案模型中转未就绪，当前只能查看静态示例；请联系平台运营配置模型', 503, { provider_executed: false, candidate_only: true })
    requirePlatformModelCostGate('text')
    const title = typeof params.draft_title === 'string' && params.draft_title.trim() ? params.draft_title.trim() : '未绑定商品内容候选'
    const prompt = typeof params.draft_prompt === 'string' && params.draft_prompt.trim() ? params.draft_prompt.trim() : '生成一个结构化商品文案候选，仅使用创意表达，不作任何未经确认的商品事实或效果宣称。'
    const platform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() : 'general'
    const actionId = `content-draft:${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex')}`
    const decision = await enforceMcpCommercialAccess(req, workspaceId, 'content.draft.generate')
    await assertProviderActionCanStart(workspaceId, actionId)
    const creativeReservation = await reserveCreativePointsForModel(workspaceId, actionId, decision)
    let generated
    try {
      await recordActionSettlement({ workspaceId, actionKey: actionId, actionKind: 'model_text', settlement: 'included_quota', amountFen: 0, actorId: requestActor(req), description: '未绑定商品文案候选生成', settlementStatus: 'authorized' })
      await recordOperationAudit({ workspaceId, actorId: requestActor(req), action: 'content.draft.generate', resourceType: 'content_draft_candidate', resourceId: actionId, before: {}, after: { candidate_only: true, platform, title }, reason: '生成未绑定内容候选；不创建正式版本、不允许发布' })
      generated = await contentGenerator.generate({ platform, candidateOnly: true, directionId: prompt, product: { title, stock: 0, skuCount: 0 }, usageContext: { workspaceId, actionId, runKey: actionId } })
    } catch (error) {
      if (providerSucceededButSettlementPending(error)) {
        if ((error as { code?: unknown })?.code === 'MODEL_PROVIDER_OUTCOME_UNKNOWN') {
          try {
            const reservation = await persistence.creativePoints?.getReservationByActionKey?.(workspaceId, actionId)
            const receipt = reservation && unknownModelProviderReceipt(error, workspaceId, reservation.operationId)
            if (reservation && !receipt) throw new Error('MODEL_UNKNOWN_CORRELATION_ID_MISSING')
            if (receipt) {
              if (!persistence.creativePointLifecycle) throw new Error('MODEL_UNKNOWN_RECEIPT_STORE_UNAVAILABLE')
              await persistence.creativePointLifecycle.recordProviderReceipt(receipt)
            }
            await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: actionId, from: ['authorized'], to: 'pending_receipt' })
          } catch (recordError) {
            // Preserve the provider's unknown outcome and its active holds; a
            // failed evidence write must not be misreported as a model failure.
            console.error('model unknown correlation persistence failed', { workspaceId, actionId, code: (recordError as { code?: unknown })?.code ?? 'MODEL_UNKNOWN_RECEIPT_WRITE_FAILED' })
          }
        }
      } else await releaseReservedModelPoints(workspaceId, actionId, '文案候选生成失败', creativeReservation)
      throw error
    }
    await requireSettledContentExecutionEvidence(workspaceId, actionId)
    const body = validateContentSchema(generated, 'content.draft.generate', { candidateOnly: true })
    return { readOnly: true, previewOnly: true, candidateOnly: true, publishable: false, formalVersionCreated: false, product: { id: null, title, platform, factsConfirmed: false }, contentPreview: { id: actionId, taskId: null, version: null, state: 'candidate', body }, execution: { mode: 'platform_relay_candidate', simulated: false, providerExecuted: true, modelCalled: true, label: '平台中转模型已生成内容候选', message: '仅供预览；未创建正式内容版本，未批准、未发布' }, nextActions: ['绑定已授权店铺并确认商品事实后，创建正式任务', '正式商品内容必须通过 content.generate 生成并审核'] }
  }
  const example = params.example === 'true'
  if (example) {
    const nextActions = ['连接一个平台店铺并选择真实商品，查看基于商家事实的预览', '或上传商品资料后确认事实，再开始内容和视觉任务', '示例不会调用模型、写入商品或发布到平台']
    return {
      readOnly: true,
      previewOnly: true,
      example: true,
      product: { id: null, productId: null, facts: { title: '示例商品：轻云防晒外套', platform: null, storeName: null, accountId: null, remoteProductId: null, skuCount: 1, stock: null, price: null, category: '服饰示例', images: [], attributes: { note: '示例内容，不代表商家真实商品事实' }, sellingPoints: [], factsConfirmed: false, source: 'example', updatedAt: new Date().toISOString(), version: 1 }, sourceIds: ['example:first-value'] },
      contentPreview: { id: 'example-content-preview', taskId: null, version: 1, state: 'example', body: { title: '轻云防晒外套｜通勤轻户外详情页示例', detail: '这里展示详情页结构、卖点证据和平台适配方式。真实商品必须先绑定店铺并确认事实。', sellingPoints: ['结构化详情页模块', '卖点需要商家事实支持', '平台规则和 SEO/GEO 建议需单独确认'] }, sourceIds: ['example:first-value'], factSourceIds: [] },
      visualPreviewRefs: [],
      execution: { mode: 'read_only_preview', simulated: true, providerExecuted: false, modelCalled: false, label: '静态示例预览，未调用模型，未发布任何内容', message: '静态示例预览，未调用模型，未发布任何内容', content: firstValueExecutionLabel('content', true), visual: firstValueExecutionLabel('visual', false) },
      nextActions,
      next_actions: nextActions,
    }
  }
  const productId = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : undefined
  const platform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() as Platform : undefined
  const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
  if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 选择首个价值预览时必须同时指定 platform', 400)

  if (isProduction() && (!productId || !platform || !accountId)) {
    throw new DomainError('FIRST_VALUE_SELECTION_REQUIRED', '生产首个价值预览必须明确传入已授权店铺的 product_id、platform 和 account_id', 409, {
      next_actions: ['调用 workspace.health 查看已授权店铺', '调用 catalog.search 选择具体店铺商品', '重新调用 merchant.first_value 并传入 product_id、platform 和 account_id'],
    })
  }

  let product: import('../../../packages/application/src/service.js').Product | undefined
  if (productId) {
    product = service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404, { next_actions: ['调用 catalog.search 查看当前工作区商品'] })
    if (platform && product.platform !== platform) throw new DomainError('PLATFORM_SCOPE_MISMATCH', '首个价值预览的平台必须与商品所属平台一致', 409, { next_actions: ['重新选择该商品所属 platform'] })
    if (accountId && product.accountId !== accountId) throw new DomainError('STORE_CONTEXT_MISMATCH', '首个价值预览的商品不属于所选店铺', 409, { next_actions: ['重新选择与商品一致的 platform + account_id'] })
    if (isProduction()) {
      if (!product.accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产首个价值预览的商品必须绑定已授权店铺', 409, { next_actions: ['调用 catalog.search 选择已绑定店铺商品'] })
      service.getActionablePlatformAccount(workspaceId, product.accountId, product.platform)
    }
  } else if (accountId && platform) {
    service.getPlatformAccount(workspaceId, accountId, platform)
    product = service.listProducts(workspaceId, { platform, accountId })[0]
  } else if (platform) {
    throw new DomainError('STORE_SELECTION_REQUIRED', '请先明确选择 platform + account_id，首个价值预览不能跨店铺猜测商品', 409, { next_actions: ['调用 workspace.health 查看店铺列表', '明确选择 platform + account_id', '调用 catalog.search 查看该店铺商品'] })
  } else {
    // The fallback is deliberately limited to fixture data and the current
    // workspace. It must never turn an unscoped production request into a
    // real-store or cross-workspace preview.
    product = service.listProducts(workspaceId).find(item => item.source === 'fixture')
  }

  if (!product) {
    throw new DomainError('FIRST_VALUE_PRODUCT_REQUIRED', '当前范围没有可安全预览的商品；请先明确选择商品或同步/导入一件商品', 409, {
      next_actions: accountId && platform
        ? ['调用 catalog.sync.start 同步当前店铺商品', '或调用 catalog.import 导入商品资料', '完成后重新调用 merchant.first_value 并传入 product_id']
        : ['调用 catalog.search 选择一个具体店铺商品', '重新调用 merchant.first_value 并传入 product_id、platform 和 account_id'],
    })
  }

  const productVersion = product.version ?? 1
  const productSourceIds = [`product:${product.id}:v${productVersion}`]
  for (const sellingPoint of product.sellingPoints ?? []) productSourceIds.push(...sellingPoint.sourceIds)
  const productFacts = {
    title: product.title,
    platform: product.platform,
    storeName: product.storeName,
    accountId: product.accountId ?? null,
    remoteProductId: product.remoteId ?? null,
    skuCount: product.skuCount,
    stock: product.stock,
    price: product.price ?? null,
    category: product.category ?? null,
    images: product.images ?? [],
    attributes: product.attributes ?? {},
    sellingPoints: product.sellingPoints ?? [],
    factsConfirmed: product.factsConfirmed,
    source: product.source,
    updatedAt: product.updatedAt,
    version: productVersion,
  }

  const scopedTasks = service.listTasks(workspaceId, { productId: product.id, platform: product.platform })
    .filter(task => (task.accountId ?? null) === (product.accountId ?? null))
  const contentCandidates = scopedTasks.flatMap(task => service.listContentVersions(workspaceId, task.id).map(version => ({ task, version })))
    .sort((left, right) => right.version.version - left.version.version || right.task.createdAt.localeCompare(left.task.createdAt))
  const content = contentCandidates[0]
  const contentPreview = content ? {
    id: content.version.id,
    taskId: content.task.id,
    version: content.version.version,
    state: content.version.state,
    body: content.version.body,
    sourceIds: content.version.factVersionIds,
    factSourceIds: content.version.factVersionIds,
  } : null

  const visualPreviewRefs = [...service.imageGenerationJobs.values()]
    .filter(job => job.workspaceId === workspaceId && job.productId === product.id && job.archiveState === 'archived' && job.state === 'succeeded')
    .filter(job => !job.taskId || scopedTasks.some(task => task.id === job.taskId))
    .flatMap(job => (job.outputs ?? []).map(output => output.visualRef))
    .slice(0, 6)
  const execution = {
    mode: 'read_only_preview' as const,
    simulated: false,
    providerExecuted: false,
    modelCalled: false,
    label: '只读预览，未调用真实模型，未发布任何内容',
    message: '只读预览，未调用真实模型，未发布任何内容',
    content: firstValueExecutionLabel('content', Boolean(contentPreview)),
    visual: firstValueExecutionLabel('visual', visualPreviewRefs.length > 0),
  }
  const nextActions = firstValueNextActions(product, Boolean(contentPreview), visualPreviewRefs.length)
  return {
    readOnly: true,
    previewOnly: true,
    product: { id: product.id, productId: product.id, facts: productFacts, sourceIds: [...new Set(productSourceIds)] },
    contentPreview,
    visualPreviewRefs,
    execution,
    nextActions,
    next_actions: nextActions,
  }
}
