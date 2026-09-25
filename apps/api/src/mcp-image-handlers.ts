import type { IncomingMessage } from 'node:http'
import { DomainError, isUsableAssetWithoutScan, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { imageMcpRuntime } from './server.js'

type ImageMcpRuntime = ReturnType<typeof imageMcpRuntime>
export const MCP_IMAGE_METHODS = new Set(['catalog.image.generate', 'catalog.image.retry', 'catalog.image.get', 'catalog.image.select', 'catalog.image.review', 'content.visual.select'])

export async function handleImageMcpMethod(method: string, params: Record<string, unknown>, workspaceId: string, req: IncomingMessage, runtime: ImageMcpRuntime): Promise<unknown> {
  const {
    protectedProductConclusion, requireProtectedProductIntent, demoUnscannedAssetsEnabled,
    SUPPORTED_PLATFORMS, imageGenerator, service, executionContract, persistence,
    recordActionSettlement, observeLegacyImageEntitlementShadow, refundModelEntitlement,
    refundPluginWalletDebit, observeLegacyWalletShadow, requireGenerationRulePreflight,
    requireRuleSafeGenerationText, getStoredObjectWithRetry, enforceMcpCommercialAccess,
    imageCreativePointsEvidence, reserveCreativePointsForModel, releaseReservedModelPoints,
    withCommercialWorkerSnapshot, commercialWorkerSnapshotForReservation, persistEvent,
    persistSnapshot, persistSnapshotsAndEvent, workerAuthorizationSnapshot,
    serializedWorkerAuthorizationSnapshot, header, signedAssetDisplayUrl, imageTrace,
    chargedImageCandidatesReadable, providerSucceededButSettlementPending, requestActor,
    requirePlatformModelCostGate, required, platformGovernanceGatesRequired,
    reviewProductImagesForMcp, parseImageListForMcp, archiveGeneratedImages,
    readArchivedGeneratedImages, imageJobOutputsAreClean, sourceImagesForImageJob,
    publicImageJob, publicImageJobForCommercialRead, assetForWorkspace,
    requireApprovedAssetForImageGeneration, issueImageSelectionTickets,
    consumeImageSelectionTicket, resolveCanonicalTaskScope, assertCanonicalTaskScopeForAction,
    enforceAssetAccess, enforceProductBrandAccess, isExemptUnboundImageCandidateProduct,
    scopeContentVersion, evaluateVisualCandidates, requireSelectedVisualAuthenticity,
    canonicalProductReadControl,
  } = runtime
  switch (method) {
    case 'catalog.image.generate': {
      // A user-uploaded image may be generated before any store/product
      // binding. In that mode we materialize a local, unbound product shell
      // from the merchant-confirmed title and asset IDs. It is intentionally
      // never publishable; store binding remains required by publish/sync.
      let unboundCandidate = false
      let productId = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : ''
      const standaloneImageInputs = typeof params.asset_ids_json === 'string' && params.asset_ids_json.trim().length > 0
        && !(typeof params.task_id === 'string' && params.task_id.trim())
        && !(typeof params.content_version_id === 'string' && params.content_version_id.trim())
      // A model may carry a catalog product from conversational context even
      // when the merchant only asked for a standalone candidate. Do not make
      // an unrelated brand grant a prerequisite: if the request has approved
      // user assets and no task/version binding, discard that hint and use the
      // explicitly supported unbound path.
      if (productId && standaloneImageInputs) {
        try {
          await enforceProductBrandAccess(req, workspaceId, productId, 'editor')
        } catch (error) {
          if (error instanceof DomainError && ['FORBIDDEN', 'PRODUCT_NOT_FOUND'].includes(error.code)) productId = ''
          else throw error
        }
      }
      if (!productId) {
        const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : '未绑定候选图'
        if (!title || typeof params.asset_ids_json !== 'string' || !params.asset_ids_json.trim()) {
          throw new DomainError(ERROR_CODES.INVALID_REQUEST, '未绑定生成必须提供 title 和 asset_ids_json；已绑定生成必须提供 product_id', 400)
        }
        let assetIds: string[]
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid asset_ids_json')
          assetIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是非空的素材 ID 字符串数组 JSON', 400) }
        for (const assetId of assetIds) await enforceAssetAccess(req, workspaceId, assetId, 'viewer')
        const requestedPlatform = typeof params.platform === 'string' && SUPPORTED_PLATFORMS.includes(params.platform as Platform) ? params.platform as Platform : undefined
        // Standalone generation must not silently default to Taobao when the
        // uploaded material already carries a single confirmed platform
        // scope (for example JD). That made valid unbound requests fail with
        // IMAGE_SOURCE_ASSET_INVALID even though no store was being targeted.
        // Prefer the unique platform declared by the source assets; retain the
        // legacy Taobao fallback only when the assets are platform-neutral or
        // have conflicting scopes.
        const inferredPlatforms = [...new Set(assetIds.flatMap(assetId => service.assets.get(assetId)?.applicablePlatforms ?? []))]
        const platform = requestedPlatform ?? (inferredPlatforms.length === 1 ? inferredPlatforms[0]! : 'taobao')
        const local = service.importProduct({ workspaceId, platform, title, sourceAssetIds: assetIds, storeName: '未绑定商品' })
        service.confirmProductFacts(workspaceId, local.id)
        // The in-memory service is only the request-facing projection. Persist
        // the unbound shell before enqueueing a job so Postgres foreign keys
        // can resolve image_generation_jobs.product_id in real Docker runs.
        await persistSnapshot(workspaceId, 'product', local, local as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, local.id, 'product.facts_confirmed', local.version ?? 1, { product_id: local.id, facts_confirmed: true, unbound_candidate: true })
        productId = local.id
        unboundCandidate = true
      }
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      if (!unboundCandidate) await enforceProductBrandAccess(req, workspaceId, productId, 'editor')
      // Standalone candidates intentionally have no canonical listing yet;
      // canonical/listing scope is enforced when the merchant later binds and
      // publishes/synchronizes the product.
      if (!unboundCandidate && (await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '请先确认商品、SKU、价格和图片事实，再生成主图', 409)
      const protectedProductValidation = requireProtectedProductIntent(typeof params.direction === 'string' ? params.direction : '')
      const productProtection = protectedProductConclusion(protectedProductValidation)
      const requestedPlatform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() as Platform : undefined
      const requestedAccountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (requestedPlatform && requestedPlatform !== product.platform) throw new DomainError('IMAGE_PLATFORM_SCOPE_MISMATCH', '图片生成的平台必须与当前商品平台一致', 409, { product_platform: product.platform, requested_platform: requestedPlatform })
      if (requestedAccountId && product.accountId && requestedAccountId !== product.accountId) throw new DomainError('IMAGE_ACCOUNT_SCOPE_MISMATCH', '图片生成的店铺必须与当前商品绑定店铺一致', 409, { product_account_id: product.accountId, requested_account_id: requestedAccountId })
      let rulePreflight: Awaited<ReturnType<typeof requireGenerationRulePreflight>> | undefined
      if (!unboundCandidate) {
        rulePreflight = await requireGenerationRulePreflight(workspaceId, product.id, '主图生成前平台规则校验未通过')
        requireRuleSafeGenerationText(rulePreflight, [product.title, params.direction], '主图生成方向命中当前平台规则禁用表达')
      }
      const imageTask = typeof params.task_id === 'string' && params.task_id.trim() ? service.getTask(params.task_id.trim()) : undefined
      if (imageTask && imageTask.workspaceId !== workspaceId) throw new DomainError('TENANT_SCOPE_DENIED', '图片任务不属于当前工作区', 403)
      if (!unboundCandidate) service.assertBrandVisualGenerationReady(workspaceId, product.platform, imageTask?.region)
      let sourceAssetIds: string[] | undefined
      if (typeof params.asset_ids_json === 'string' && params.asset_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid asset_ids_json')
          sourceAssetIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是非空的素材 ID 字符串数组 JSON', 400) }
      }
      let skuIds: string[] | undefined
      if (typeof params.sku_ids_json === 'string' && params.sku_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.sku_ids_json)
          if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid sku_ids_json')
          skuIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'sku_ids_json 必须是 SKU ID 字符串数组 JSON', 400) }
      }
      const parseImageMarketingList = (field: string, maxItems: number, maxLength: number): string[] | undefined => {
        const raw = params[field]
        if (typeof raw !== 'string' || !raw.trim()) return undefined
        try {
          const parsed = JSON.parse(raw)
          if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error(field)
          return [...new Set(parsed.map(value => value.trim().slice(0, maxLength)))].slice(0, maxItems)
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${field} 必须是非空字符串数组 JSON`, 400) }
      }
      const requestedSellingPoints = parseImageMarketingList('selling_points_json', 6, 120)
      const requestedTrafficKeywords = parseImageMarketingList('traffic_keywords_json', 8, 60)
      const requestedPromotionLabels = parseImageMarketingList('promotion_labels_json', 4, 120)
      const requestedMarketingLabels = parseImageMarketingList('marketing_labels_json', 8, 120)
      const requestedHeadline = typeof params.headline === 'string' && params.headline.trim() ? params.headline.trim().slice(0, 120) : undefined
      const requestedSubheadline = typeof params.subheadline === 'string' && params.subheadline.trim() ? params.subheadline.trim().slice(0, 120) : undefined
      const requestedCta = typeof params.cta === 'string' && params.cta.trim() ? params.cta.trim().slice(0, 40) : undefined
      const marketingBrief = requestedSellingPoints || requestedTrafficKeywords || requestedPromotionLabels || requestedMarketingLabels || requestedHeadline || requestedSubheadline || requestedCta
        ? {
            ...(requestedSellingPoints ? { sellingPoints: requestedSellingPoints } : {}),
            ...(requestedTrafficKeywords ? { trafficKeywords: requestedTrafficKeywords } : {}),
            ...(requestedPromotionLabels ? { promotionLabels: requestedPromotionLabels } : {}),
            ...(requestedMarketingLabels ? { marketingLabels: requestedMarketingLabels } : {}),
            ...(requestedHeadline ? { headline: requestedHeadline } : {}),
            ...(requestedSubheadline ? { subheadline: requestedSubheadline } : {}),
            ...(requestedCta ? { cta: requestedCta } : {}),
          }
        : undefined
      const defaultSourceAssetIds = params.mode === 'create' ? undefined : service.productImageSourceAssetIds(product, skuIds ?? imageTask?.inputSnapshot?.skuIds ?? imageTask?.productionPlan?.skuIds)
      const imageMode = params.mode === undefined
        ? (sourceAssetIds?.length || defaultSourceAssetIds?.length ? 'optimize' : 'create')
        : params.mode === 'create' || params.mode === 'optimize' ? params.mode : undefined
      if (!imageMode) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'mode 必须是 create 或 optimize', 400)
      const effectiveSourceAssetIds = sourceAssetIds ?? (imageMode === 'optimize' ? defaultSourceAssetIds : undefined)
      if (imageMode === 'optimize' && !effectiveSourceAssetIds?.length) throw new DomainError('IMAGE_OPTIMIZATION_SOURCE_REQUIRED', '素材优化模式必须提供至少一个已授权商品素材', 400)
      imageTrace('generate.request', { workspace_id: workspaceId, product_id: product.id, platform: product.platform, mode: imageMode, size: typeof params.size === 'string' ? params.size : 'default', direction: typeof params.direction === 'string' ? params.direction.slice(0, 160) : 'default', source_asset_count: effectiveSourceAssetIds?.length ?? 0, requested_count: params.count ?? 'default' })
      requireApprovedAssetForImageGeneration(workspaceId, product, effectiveSourceAssetIds, unboundCandidate && !imageTask && !params.content_version_id)
      const commercialDecision = await enforceMcpCommercialAccess(req, workspaceId, method)
      requirePlatformModelCostGate('image')
      const durableImageGeneration = process.env.IMAGE_GENERATION_EXECUTION_MODE?.trim().toLowerCase() === 'durable'
      // Validate the durable execution boundary before reserving points. A
      // misconfigured worker must fail closed without leaving a customer
      // reservation stuck in `active` when no event can be enqueued.
      if (durableImageGeneration && (!persistence.persistSnapshotAndEvent || !persistence.outbox || !persistence.imageGenerationExecutions)) {
        throw new DomainError('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED', '普通图片 Durable Worker 尚未完成生产配置', 503)
      }
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim() || `image-${workspaceId}-${productId}-${typeof params.direction === 'string' ? params.direction : 'default'}`
      const existingImageJob = [...service.imageGenerationJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === idempotencyKey)
      const walletDebitKey = `image:${idempotencyKey}`
      let creativePoints: Awaited<ReturnType<typeof imageCreativePointsEvidence>> | undefined
      let entitlementConsumed = false
      const billingRequired = !existingImageJob || existingImageJob.continuation?.billingState === 'pending'
      const billingActorId = existingImageJob?.continuation?.requestedBy ?? requestActor(req)
      if (billingRequired) {
        entitlementConsumed = Boolean(await observeLegacyImageEntitlementShadow({ workspaceId, kind: 'image_generation' }))
        await observeLegacyWalletShadow(workspaceId)
        // Unbound candidate generation still needs a durable authorization
        // record so the worker's provider usage receipt can settle safely.
        // It is included-quota (zero customer charge), not a wallet debit.
        if (unboundCandidate && !(await persistence.actionLedger?.get(workspaceId, walletDebitKey))) {
          await recordActionSettlement({ workspaceId, actionKey: walletDebitKey, actionKind: 'model_image', settlement: 'included_quota', amountFen: 0, actorId: billingActorId, description: '图片生成候选（未绑定商品）', settlementStatus: 'authorized' })
        }
        if (existingImageJob?.continuation) {
          existingImageJob.continuation.billingState = 'settled'
          existingImageJob.continuation.state = 'executing'
          existingImageJob.continuation.updatedAt = new Date().toISOString()
          existingImageJob.updatedAt = existingImageJob.continuation.updatedAt
          existingImageJob.revision += 1
          await persistSnapshot(workspaceId, 'image_generation_job', existingImageJob, existingImageJob as unknown as Record<string, unknown>)
        }
      }
      const creativeReservation = await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)
      // Reserve before reading the evidence returned to MCP. This makes the
      // response reflect the current balance and the points held for this
      // request, including gifted/entitlement points.
      creativePoints = await imageCreativePointsEvidence(workspaceId, commercialDecision, walletDebitKey)
      let job: ReturnType<typeof service.enqueueImageGeneration>
      try {
        job = service.enqueueImageGeneration({ workspaceId, productId, idempotencyKey, imageMode, ...(typeof params.size === 'string' ? { size: params.size } : {}), ...(skuIds ? { skuIds } : {}), ...(effectiveSourceAssetIds ? { sourceAssetIds: effectiveSourceAssetIds } : {}), ...(typeof params.task_id === 'string' && params.task_id.trim() ? { taskId: params.task_id.trim() } : {}), ...(typeof params.content_version_id === 'string' && params.content_version_id.trim() ? { contentVersionId: params.content_version_id.trim() } : {}), ...(typeof params.direction === 'string' ? { direction: params.direction } : {}), ...(typeof params.count === 'string' && /^\d+$/u.test(params.count) ? { count: Number(params.count) } : {}), ...(marketingBrief ? { marketingBrief } : {}) })
      } catch (error) {
        await releaseReservedModelPoints(workspaceId, walletDebitKey, '图片任务创建失败', creativeReservation)
        if (entitlementConsumed) await refundModelEntitlement({ workspaceId, actionKey: walletDebitKey, reason: '图片任务创建失败' })
        else if (billingRequired) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: billingActorId, reason: '图片任务创建失败' })
        throw error
      }
      // Durable mode is explicit and fail-closed. It only admits the frozen
      // job here; the normal local fixture path below remains synchronous until
      // the image worker executor and callback are configured.
      if (durableImageGeneration) {
        const authorizationSnapshot = workerAuthorizationSnapshot(req, workspaceId, job.id, 'image_generation.execute', { method: 'catalog.image.generate', product_id: product.id, source_product_version: job.sourceProductVersion, intent_hash: job.intentHash })
        if (!authorizationSnapshot) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '图片生成缺少持久身份授权快照，已拒绝入队', 503)
        const sourceAssetDataUrls = await Promise.all((job.sourceAssetIds ?? []).map(async assetId => {
          const asset = assetForWorkspace(workspaceId, assetId)
          const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey, { includeQuarantine: asset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() })
          return `data:${asset.mimeType};base64,${Buffer.from(stored.body).toString('base64')}`
        }))
        const eventPayload: Record<string, unknown> = {
          job_id: job.id,
          workspace_id: workspaceId,
          product_id: job.productId,
          product_title: product.title,
          category: product.category ?? null,
          task_id: job.taskId ?? null,
          content_version_id: job.contentVersionId ?? null,
          intent_hash: job.intentHash,
          idempotency_key: job.idempotencyKey,
          image_mode: job.imageMode,
          direction: job.direction,
          requested_count: job.count,
          source_asset_ids: job.sourceAssetIds ?? [],
          source_asset_data_urls: sourceAssetDataUrls,
          source_product_version: job.sourceProductVersion,
          visual_brief: job.visualBrief ?? null,
          action_id: walletDebitKey,
          run_key: walletDebitKey,
          authorization_snapshot: serializedWorkerAuthorizationSnapshot(authorizationSnapshot),
        }
        const commercialAccessSnapshot = await commercialWorkerSnapshotForReservation(workspaceId, 'image_generation.execute', commercialDecision, creativeReservation?.id)
        if (commercialAccessSnapshot) eventPayload.commercial_access_snapshot = commercialAccessSnapshot
        if (!existingImageJob) {
          const guardedEventPayload = await withCommercialWorkerSnapshot(workspaceId, 'image.generation.requested', eventPayload)
          if (!persistence.persistSnapshotAndEvent) throw new DomainError('IMAGE_GENERATION_PERSISTENCE_UNAVAILABLE', '图片生成持久化写入未配置，已阻断任务入队', 503)
          await persistence.persistSnapshotAndEvent({ workspaceId, entityType: 'image_generation_job', entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown>, eventType: 'image.generation.requested', eventPayload: guardedEventPayload })
        }
        // The durable poll contract retains the historical automatic shape:
        // poll_request: { job_id: job.id, automatic: true, user_action_required: false }
        return ({ job_id: job.id, product_id: product.id, unbound_candidate: unboundCandidate, candidate_status: unboundCandidate ? '未绑定商品、仅候选、不可发布' : undefined, creative_points: creativePoints, execution: { mode: 'durable', state: 'queued', provider: 'configured relay', source: 'server' }, rule_preflight: rulePreflight, product_protection: productProtection, job: publicImageJob(job), poll_request: { job_id: job.id, automatic: true, user_action_required: false, next_action: { type: 'automatic_poll', label: '系统自动获取结果' } } })
      }
      // A nested model-usage callback may hydrate the pre-provider snapshot
      // while the provider request is in flight. Durable archived outputs are
      // authoritative proof that generation completed; recover that state
      // without calling or charging the provider again.
      if (job.state !== 'succeeded' && job.archiveState === 'archived' && Boolean(job.outputs?.length)) {
        job.state = 'succeeded'
        delete job.errorCode
        delete job.errorMessage
        job.updatedAt = new Date().toISOString()
        job.revision += 1
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
      }
      // The local Codex fixture completes immediately so merchants can exercise
      // the entire workflow. Production uses the same handle with an image worker
      // and object-storage provider before exposing the result.
      const imageExecution = executionContract('image', Boolean(imageGenerator))
      if (job.state === 'succeeded') {
        creativePoints = await imageCreativePointsEvidence(workspaceId, commercialDecision, walletDebitKey)
        const images = imageJobOutputsAreClean(job) ? await readArchivedGeneratedImages(workspaceId, job) : []
      return ({ job_id: job.id, product_id: product.id, unbound_candidate: unboundCandidate, candidate_status: unboundCandidate ? '未绑定商品、仅候选、不可发布' : undefined, creative_points: creativePoints, execution: imageExecution, rule_preflight: rulePreflight, product_protection: productProtection, job: publicImageJob(job), ...(images.length ? { images, review: reviewProductImagesForMcp(images) } : {}), ...(job.archiveState === 'external_unarchived' ? { availabilityWarning: '图片提供方仅返回外部地址，本批次未形成可持久读取的归档文件' } : {}) })
      }
      if (job.errorCode === 'IMAGE_ARTIFACT_RECONCILIATION_REQUIRED') {
        throw new DomainError('IMAGE_ARTIFACT_RECONCILIATION_REQUIRED', '图片模型已返回结果，但候选归档尚未确认；任务已停止自动重试并等待对账', 409, { retryable: false, reconciliation_required: true, job_id: job.id })
      }
      await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
      let completed: Awaited<ReturnType<typeof service.completeImageGeneration>>
      try {
        completed = await service.completeImageGeneration({ workspaceId, jobId: job.id, sourceImages: await sourceImagesForImageJob(workspaceId, job) })
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) {
          if (entitlementConsumed) await refundModelEntitlement({ workspaceId, actionKey: walletDebitKey, reason: '图片生成失败' })
          else if (billingRequired) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: billingActorId, reason: '图片生成失败' })
        }
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
        throw error
      }
      let archived: Awaited<ReturnType<typeof archiveGeneratedImages>>
      try {
        archived = await archiveGeneratedImages(workspaceId, job.id, completed.images)
      } catch (error) {
        const archiveErrorCode = (error as { code?: string })?.code ?? 'IMAGE_ARTIFACT_ARCHIVE_FAILED'
        job.state = 'running'
        job.archiveState = 'pending'
        job.errorCode = 'IMAGE_ARTIFACT_RECONCILIATION_REQUIRED'
        job.errorMessage = '图片模型已返回结果，但候选归档尚未确认；系统不会自动重复生成'
        job.updatedAt = new Date().toISOString()
        job.revision += 1
        delete job.images
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
        throw new DomainError('IMAGE_ARTIFACT_RECONCILIATION_REQUIRED', '图片模型已返回结果，但候选归档尚未确认；任务已停止自动重试并等待对账', 409, { retryable: false, reconciliation_required: true, archive_error_code: archiveErrorCode, job_id: job.id })
      }
      if (archived.continuation) {
        archived.continuation.state = 'completed'
        archived.continuation.updatedAt = new Date().toISOString()
        archived.updatedAt = archived.continuation.updatedAt
        archived.revision += 1
      }
      await persistSnapshot(workspaceId, 'image_generation_job', archived, archived as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'product.image_candidates_generated', archived.revision, { job_id: job.id, product_id: productId, task_id: archived.taskId ?? null, content_version_id: archived.contentVersionId ?? null, candidate_count: archived.outputs?.length ?? 0, archive_receipts: (archived.outputs ?? []).map(output => ({ visual_ref: output.visualRef, asset_id: output.assetId ?? null, receipt_id: output.archiveReceiptId ?? null, receipt_digest: output.archiveReceiptDigest ?? null })), archive_state: archived.archiveState, direction: archived.direction, artifact_role: 'candidate', product_protection: productProtection })
      const deliverableImages = imageJobOutputsAreClean(archived) ? completed.images : []
      imageTrace('generate.archive', { workspace_id: workspaceId, job_id: archived.id, state: archived.state, archive_state: archived.archiveState, candidate_count: archived.outputs?.length ?? 0, deliverable_image_count: deliverableImages.length, scan_statuses: (archived.outputs ?? []).map(output => output.assetId ? service.assets.get(output.assetId)?.scanStatus ?? 'missing' : 'missing') })
      creativePoints = await imageCreativePointsEvidence(workspaceId, commercialDecision, walletDebitKey)
      return ({ job_id: archived.id, product_id: completed.product.id, unbound_candidate: unboundCandidate, candidate_status: unboundCandidate ? '未绑定商品、仅候选、不可发布' : undefined, creative_points: creativePoints, execution: imageExecution, rule_preflight: rulePreflight, product_protection: productProtection, job: publicImageJob(archived), product: completed.product, ...(deliverableImages.length ? { images: deliverableImages, review: reviewProductImagesForMcp(deliverableImages) } : { availabilityWarning: '候选图已生成，平台正在自动执行交付前安全扫描；完成前不会返回图片内容，商家无需操作。' }) })
    }
    case 'catalog.image.retry': {
      const jobId = required(params, 'job_id')
      const previous = service.getImageGenerationJob(workspaceId, jobId)
      await enforceProductBrandAccess(req, workspaceId, previous.productId)
      requirePlatformModelCostGate('image')
      const commercialDecision = await enforceMcpCommercialAccess(req, workspaceId, 'catalog.image.generate')
      const durableRetry = process.env.IMAGE_GENERATION_EXECUTION_MODE?.trim().toLowerCase() === 'durable'
      if (durableRetry && (!persistence.persistSnapshotAndEvent || !persistence.outbox || !persistence.imageGenerationExecutions)) throw new DomainError('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED', '图片安全重试的 Durable Worker 尚未完成生产配置', 503)
      const durableAuthorizationSnapshot = durableRetry ? workerAuthorizationSnapshot(req, workspaceId, previous.id, 'image_generation.execute', { method: 'catalog.image.retry', product_id: previous.productId, source_product_version: previous.sourceProductVersion, intent_hash: previous.intentHash }) : undefined
      if (durableRetry && !durableAuthorizationSnapshot) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '图片安全重试缺少持久身份授权快照，已拒绝扣费和入队', 503)
      const retryKey = required(params, 'idempotency_key')
      const previousRunKey = durableRetry
        ? (await persistence.outbox!.listAggregateEvents(workspaceId, previous.id, 100)).find(event => event.eventType === 'image.generation.requested' && typeof event.payload.run_key === 'string' && event.payload.run_key.trim())?.payload.run_key
        : undefined
      const imageRunKey = typeof previousRunKey === 'string' ? previousRunKey.trim() : `image:${previous.idempotencyKey}`
      const billingActorId = requestActor(req)
      const walletDebitKey = `image:${retryKey}`
      const creativeReservation = await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)
      let creativePoints = await imageCreativePointsEvidence(workspaceId, commercialDecision, walletDebitKey)
      let entitlementConsumed = false
      const existingRetry = [...service.imageGenerationJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === retryKey)
      if (!existingRetry) {
        entitlementConsumed = Boolean(await observeLegacyImageEntitlementShadow({ workspaceId, kind: 'image_generation' }))
        await observeLegacyWalletShadow(workspaceId)
      }
      let retried: ReturnType<typeof service.retryImageGeneration>
      try {
        retried = service.retryImageGeneration({ workspaceId, jobId, idempotencyKey: retryKey, ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}) })
      } catch (error) {
          await releaseReservedModelPoints(workspaceId, walletDebitKey, '图片安全重试未创建任务', creativeReservation)
        if (entitlementConsumed) await refundModelEntitlement({ workspaceId, actionKey: walletDebitKey, reason: '图片安全重试未创建任务' })
        else await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: billingActorId, reason: '图片安全重试未创建任务' })
        throw error
      }
      const retryAuthorizationSnapshot = durableRetry ? workerAuthorizationSnapshot(req, workspaceId, retried.job.id, 'image_generation.execute', { method: 'catalog.image.retry', product_id: retried.job.productId, source_product_version: retried.job.sourceProductVersion, intent_hash: retried.job.intentHash }) : undefined
      if (durableRetry && !retryAuthorizationSnapshot) {
        await releaseReservedModelPoints(workspaceId, walletDebitKey, '图片安全重试缺少身份授权快照', creativeReservation)
        throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '图片安全重试缺少新任务的持久身份授权快照，已停止入队', 503)
      }
      if (!retried.alreadyExists) {
        await persistSnapshot(workspaceId, 'image_generation_job', retried.job, retried.job as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, retried.job.id, 'image.generation.retry_requested', retried.job.revision, { job_id: retried.job.id, previous_job_id: previous.id, idempotency_key: retryKey, source_intent_hash: previous.intentHash })
      }
      if (durableRetry) {
        if (!persistence.persistSnapshotAndEvent || !persistence.outbox || !persistence.imageGenerationExecutions) {
          await releaseReservedModelPoints(workspaceId, walletDebitKey, '图片安全重试持久化未配置', creativeReservation)
          throw new DomainError('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED', '图片安全重试的 Durable Worker 尚未完成生产配置', 503)
        }
        if (!existingRetry) {
          const commercialAccessSnapshot = await commercialWorkerSnapshotForReservation(workspaceId, 'image_generation.execute', commercialDecision, creativeReservation?.id)
          await persistence.persistSnapshotAndEvent({ workspaceId, entityType: 'image_generation_job', entityId: retried.job.id, entityVersion: retried.job.revision, payload: retried.job as unknown as Record<string, unknown>, eventType: 'image.generation.requested', eventPayload: { job_id: retried.job.id, workspace_id: workspaceId, product_id: retried.job.productId, intent_hash: retried.job.intentHash, idempotency_key: retried.job.idempotencyKey, image_mode: retried.job.imageMode, direction: retried.job.direction, requested_count: retried.job.count, source_asset_ids: retried.job.sourceAssetIds ?? [], source_product_version: retried.job.sourceProductVersion, visual_brief: retried.job.visualBrief ?? null, action_id: walletDebitKey, run_key: imageRunKey, authorization_snapshot: serializedWorkerAuthorizationSnapshot(retryAuthorizationSnapshot!), ...(commercialAccessSnapshot ? { commercial_access_snapshot: commercialAccessSnapshot } : {}), retry_of_job_id: previous.id }})
        }
        return ({ job_id: retried.job.id, previous_job_id: previous.id, state: 'queued', creative_points: creativePoints, execution: { mode: 'durable', state: 'queued', provider: 'configured relay', source: 'server' }, job: publicImageJob(retried.job), poll_request: { job_id: retried.job.id, automatic: true, user_action_required: false } })
      }
      try {
        const completed = await service.completeImageGeneration({ workspaceId, jobId: retried.job.id, runKey: imageRunKey, sourceImages: await sourceImagesForImageJob(workspaceId, retried.job) })
        const archived = await archiveGeneratedImages(workspaceId, retried.job.id, completed.images)
        await persistSnapshot(workspaceId, 'image_generation_job', archived, archived as unknown as Record<string, unknown>)
        creativePoints = await imageCreativePointsEvidence(workspaceId, commercialDecision, walletDebitKey)
        return ({ job_id: archived.id, previous_job_id: previous.id, state: archived.state, archive_state: archived.archiveState, retry_count: archived.retryCount ?? 1, creative_points: creativePoints, job: publicImageJob(archived), ...(imageJobOutputsAreClean(archived) ? { images: completed.images } : {}) })
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) {
          await releaseReservedModelPoints(workspaceId, walletDebitKey, '图片安全重试失败', creativeReservation)
          if (entitlementConsumed) await refundModelEntitlement({ workspaceId, actionKey: walletDebitKey, reason: '图片安全重试失败' })
          else if (!existingRetry) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: billingActorId, reason: '图片安全重试失败' })
        }
        await persistSnapshot(workspaceId, 'image_generation_job', retried.job, retried.job as unknown as Record<string, unknown>)
        throw error
      }
    }
    case 'catalog.image.get': {
      const jobId = typeof params.job_id === 'string' && params.job_id.trim() ? params.job_id.trim() : undefined
      const visualRef = typeof params.visual_ref === 'string' && params.visual_ref.trim() ? params.visual_ref.trim() : undefined
      if (Boolean(jobId) === Boolean(visualRef)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'job_id 与 visual_ref 必须且只能提供一个', 400)
      let job = jobId ? service.getImageGenerationJob(workspaceId, jobId) : service.resolveImageGenerationByVisualRef(workspaceId, visualRef!)
      // Standalone uploaded-image candidates use a local shell product with no
      // canonical binding. Reading their status/results must not require a
      // brand grant; binding/selecting/publishing remains permission-gated.
      // The exemption is a function of the durable canonical binding, never of
      // the merchant-settable `storeName` display field.
      const unboundCandidate = await isExemptUnboundImageCandidateProduct(workspaceId, job.productId)
      if (!unboundCandidate) await enforceProductBrandAccess(req, workspaceId, job.productId)
      if (!unboundCandidate && (await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') {
        const product = service.products.get(job.productId)
        if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
        await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      }
      // A terminal worker rejection (for example a stale authorization
      // snapshot) must close the user-facing job. Leaving it queued makes the
      // plugin poll forever and hides the actionable failure reason.
      const aggregateEvents = await persistence.outbox?.listAggregateEvents(workspaceId, job.id, 100)
      const terminalWorkerError = aggregateEvents?.find(event => event.eventType === 'image.generation.requested' && event.lastError?.retryable === false)?.lastError
      if (terminalWorkerError && job.state !== 'failed' && job.state !== 'succeeded') {
        job = service.markImageGenerationFailed({ workspaceId, jobId: job.id, errorCode: typeof terminalWorkerError.code === 'string' ? String(terminalWorkerError.code) : 'IMAGE_GENERATION_WORKER_REJECTED', errorMessage: typeof terminalWorkerError.message === 'string' ? String(terminalWorkerError.message) : '图片生成 worker 已终止任务' })
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
      }
      const execution = await persistence.imageGenerationExecutions?.get({ workspaceId, jobId: job.id })
      const commercialReady = await chargedImageCandidatesReadable(workspaceId, job, aggregateEvents, execution?.providerRequestId)
      // A scan callback can make quarantined outputs clean after the provider
      // callback originally left the job in `pending`. Promote that durable
      // state on read so the next ChatGPT request receives the real image.
      const cleanOutputs = job.outputs ?? []
      const outputsClean = cleanOutputs.length > 0 && cleanOutputs.every(output => {
        const asset = output.assetId ? service.assets.get(output.assetId) : undefined
        return Boolean(asset && isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled()))
      })
      if (commercialReady && job.archiveState !== 'archived' && outputsClean) {
        job = service.archiveImageGenerationOutputs(workspaceId, job.id, job.outputs ?? [], 'archived')
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
      }
      const images = commercialReady && imageJobOutputsAreClean(job, visualRef) ? await readArchivedGeneratedImages(workspaceId, job, visualRef) : []
      const selectedImages = images
      const selectedOutputs = selectedImages.length
        ? (job.outputs ?? []).filter(output => !visualRef || output.visualRef === visualRef)
        : []
      const signedUrls = selectedOutputs.length === selectedImages.length
        ? selectedOutputs.map(output => output.assetId ? signedAssetDisplayUrl(workspaceId, output.assetId) : undefined)
        : []
      const imageUrls = signedUrls.length && signedUrls.every((value): value is string => typeof value === 'string') ? signedUrls : []
      const selectionTickets = selectedOutputs.length === selectedImages.length && selectedImages.length
        ? await issueImageSelectionTickets(req, workspaceId, job, selectedOutputs)
        : []
      const reconciliationRequired = !commercialReady || execution?.state === 'provider_reserved' || execution?.state === 'provider_dispatching' || execution?.state === 'provider_started' || execution?.state === 'outcome_unknown'
      const creativePoints = await imageCreativePointsEvidence(workspaceId, undefined, `image:${job.idempotencyKey}`)
      imageTrace('get.result', { workspace_id: workspaceId, job_id: job.id, state: job.state, archive_state: job.archiveState, execution_state: execution?.state ?? 'none', selected_image_count: selectedImages.length, candidate_count: commercialReady ? job.outputs?.length ?? 0 : 0, reconciliation_required: reconciliationRequired })
      return ({ job_id: job.id, creative_points: creativePoints, execution: executionContract('image', Boolean(imageGenerator)), execution_state: execution?.state ?? null, provider_request_id: execution?.providerRequestId ?? null, execution_attempt: execution?.attempt ?? null, reconciliation_required: reconciliationRequired, ...(execution?.errorCode ? { error_code: execution.errorCode, error_message: execution.errorMessage ?? null } : {}), next_action: !commercialReady || execution?.state === 'outcome_unknown' || execution?.state === 'provider_started' ? { type: 'reconcile', label: '中转结果与结算证据待对账，暂不重试', allowed: true } : { type: 'refresh_status', label: '刷新任务状态', allowed: true }, ...(selectedImages.length ? { images: selectedImages, ...(imageUrls.length ? { image_urls: imageUrls, download_urls: imageUrls } : {}), selection_tickets: selectionTickets, review: reviewProductImagesForMcp(selectedImages) } : { availabilityWarning: !commercialReady ? '图片结果尚未通过原始用量、成本与创意点结算核验；已保留待对账，不会返回候选或自动重复扣费。' : execution?.state === 'outcome_unknown' ? '中转服务返回结果不确定，已停止自动重试，等待对账；不会重复扣费。' : '平台正在自动执行交付前安全扫描，完成前不会返回图片内容，商家无需操作。' }), job: publicImageJobForCommercialRead(job, commercialReady), historicalCandidate: true, platformPublished: false })
    }
    case 'catalog.image.select': {
      const jobId = required(params, 'job_id')
      const visualRef = required(params, 'visual_ref')
      const current = service.getImageGenerationJob(workspaceId, jobId)
      await enforceProductBrandAccess(req, workspaceId, current.productId, 'editor')
      if (!(await chargedImageCandidatesReadable(workspaceId, current))) throw new DomainError('IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING', '图片候选尚未通过原始用量、成本与创意点结算核验，禁止选择旧候选', 409, { reconciliation_required: true, retryable: false })
      if ((await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') {
        const product = service.products.get(current.productId)
        if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
        await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      }
      const expectedRevisionRaw = required(params, 'expected_revision')
      if (!/^[1-9][0-9]*$/u.test(expectedRevisionRaw)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是正整数字符串', 400)
      const expectedRevision = Number(expectedRevisionRaw)
      if (!Number.isSafeInteger(expectedRevision)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 超出安全整数范围', 400)
      const idempotencyKey = required(params, 'idempotency_key').trim()
      const selectedBy = requestActor(req).normalize('NFKC').trim()
      const reason = required(params, 'reason').normalize('NFKC').trim()
      await consumeImageSelectionTicket({ req, workspaceId, params, job: current, visualRef, expectedRevision, idempotencyKey, selectedBy, reason })
      const before = {
        revision: current.revision,
        updatedAt: current.updatedAt,
        preferredSelection: current.preferredSelection ? structuredClone(current.preferredSelection) : undefined,
        preferredSelectionHistory: current.preferredSelectionHistory ? structuredClone(current.preferredSelectionHistory) : undefined,
      }
      const selected = service.selectImageGenerationCandidate({ workspaceId, jobId, visualRef, expectedRevision, idempotencyKey, selectedBy, reason })
      const changed = selected.job.revision !== before.revision
      if (changed) {
        try {
          await persistSnapshotsAndEvent({ workspaceId, snapshots: [{ entityType: 'image_generation_job', entityId: selected.job.id, entityVersion: selected.job.revision, payload: selected.job as unknown as Record<string, unknown> }], aggregateId: selected.job.id, eventType: 'image.candidate.preferred', sequence: selected.job.revision, eventPayload: { job_id: selected.job.id, product_id: selected.job.productId, visual_ref: selected.preferredSelection.visualRef, selected_by: selected.preferredSelection.selectedBy, reason: selected.preferredSelection.reason, idempotency_key: selected.preferredSelection.idempotencyKey, intent_hash: selected.preferredSelection.intentHash, previous_visual_ref: before.preferredSelection?.visualRef ?? null, review_status: selected.reviewStatus, currently_usable: selected.currentlyUsable, candidate_publishable: selected.publishable, publish_job_created: false, remote_write_performed: false } })
        } catch (error) {
          selected.job.revision = before.revision
          selected.job.updatedAt = before.updatedAt
          if (before.preferredSelection) selected.job.preferredSelection = before.preferredSelection
          else delete selected.job.preferredSelection
          if (before.preferredSelectionHistory) selected.job.preferredSelectionHistory = before.preferredSelectionHistory
          else delete selected.job.preferredSelectionHistory
          throw error
        }
      }
      return ({ job_id: selected.job.id, product_id: selected.job.productId, visual_ref: selected.preferredSelection.visualRef, preference_status: 'selected', review_status: selected.reviewStatus, currently_usable: selected.currentlyUsable, candidate_publishable: selected.publishable, publishable: false, review_required: true, approval_required: true, platformPublished: false, remote_write_performed: false, revision: selected.job.revision, idempotent_replay: !changed })
    }
    case 'catalog.image.review': {
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      await enforceProductBrandAccess(req, workspaceId, product.id)
      if ((await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      let visualRefs: string[] | undefined
      if (typeof params.visual_refs_json === 'string' && params.visual_refs_json.trim()) {
        try {
          const parsed = JSON.parse(params.visual_refs_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.length > 6 || parsed.some(value => typeof value !== 'string') || new Set(parsed).size !== parsed.length) throw new Error('invalid')
          visualRefs = parsed
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_refs_json 必须是 1 至 6 个不重复候选引用的 JSON 数组', 400) }
      }
      let images = parseImageListForMcp(params.images) ?? product.images
      if (visualRefs) {
        images = []
        for (const visualRef of visualRefs) {
          const job = service.resolveImageGenerationByVisualRef(workspaceId, visualRef)
          if (job.productId !== product.id) throw new DomainError('VISUAL_SELECTION_SCOPE_MISMATCH', '图片候选不属于当前商品', 409)
          if (!(await chargedImageCandidatesReadable(workspaceId, job))) throw new DomainError('IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING', '图片候选尚未通过原始用量、成本与创意点结算核验，禁止读取或审阅旧候选', 409, { reconciliation_required: true, retryable: false })
          const archived = await readArchivedGeneratedImages(workspaceId, job)
          const index = job.outputs?.findIndex(output => output.visualRef === visualRef) ?? -1
          if (index < 0 || !archived[index]) throw new DomainError('VISUAL_NOT_READY', '图片候选不可读取', 409)
          images.push(archived[index]!)
        }
      }
      if (!visualRefs && platformGovernanceGatesRequired()) throw new DomainError('VISUAL_AUTHENTICITY_EVIDENCE_REQUIRED', '生产真实性审阅必须引用归档 visual_ref，不能仅信任调用者提供的图片地址', 409)
      const authenticityGate = visualRefs ? evaluateVisualCandidates(workspaceId, visualRefs, params) : undefined
      const findings = reviewProductImagesForMcp(images)
      if (visualRefs) {
        const jobs = service.reviewImageGenerationOutputs(workspaceId, visualRefs, findings.some(finding => finding.severity === 'error') ? 'blocked' : 'passed')
        for (const job of jobs) await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, jobs[0]!.id, 'product.image_candidates_reviewed', Math.max(...jobs.map(job => job.revision)), { product_id: product.id, visual_refs: visualRefs, review_status: findings.some(finding => finding.severity === 'error') ? 'blocked' : 'passed', finding_count: findings.length, authenticity_gate: authenticityGate?.map(item => ({ visual_ref: item.visual_ref, status: item.status, publishable: item.publishable, finding_codes: item.findings.map(finding => finding.code) })) ?? null })
      }
      return ({ productId, images: images ?? [], findings, ...(authenticityGate ? { authenticityGate } : {}), ...(visualRefs ? { visualRefs, persistedReviewStatus: findings.some(finding => finding.severity === 'error') ? 'blocked' : 'passed' } : {}), externallyUnverified: authenticityGate ? ['平台最终审核'] : ['视觉真实性证据', '尺寸/清晰度', '主体占比', 'OCR 文字合规', '平台最终审核'] })
    }
    case 'content.visual.select': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      await assertCanonicalTaskScopeForAction(scoped.task)
      let visualRefs: string[]
      try {
        const parsed = JSON.parse(required(params, 'visual_refs_json'))
        if (!Array.isArray(parsed) || !parsed.length || parsed.length > 6 || parsed.some(value => typeof value !== 'string') || new Set(parsed).size !== parsed.length) throw new Error('invalid')
        visualRefs = parsed
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_refs_json 必须是 1 至 6 个不重复候选引用的 JSON 数组', 400) }
      for (const visualRef of visualRefs) {
        const job = service.resolveImageGenerationByVisualRef(workspaceId, visualRef)
        if (!(await chargedImageCandidatesReadable(workspaceId, job))) throw new DomainError('IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING', '图片候选尚未通过原始用量、成本与创意点结算核验，禁止绑定到内容版本', 409, { reconciliation_required: true, retryable: false })
      }
      requireSelectedVisualAuthenticity(workspaceId, visualRefs)
      const expectedRevision = Number(required(params, 'expected_revision'))
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      if (!idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '选图必须提供幂等键', 400)
      const selected = service.selectVisuals({ workspaceId, contentVersionId: scoped.version.id, visualRefs, expectedRevision, idempotencyKey, selectedBy: requestActor(req), reason: required(params, 'reason') })
      await persistSnapshotsAndEvent({ workspaceId, snapshots: [
        { entityType: 'content_version', entityId: selected.version.id, entityVersion: selected.version.revision, payload: selected.version as unknown as Record<string, unknown> },
        { entityType: 'task', entityId: selected.task.id, entityVersion: selected.task.version, payload: selected.task as unknown as Record<string, unknown> },
      ], aggregateId: selected.version.id, eventType: 'content.visual_selected', sequence: selected.version.revision, eventPayload: { source_content_version_id: selected.source.id, content_version_id: selected.version.id, visual_refs: visualRefs, selected_count: visualRefs.length, reason: required(params, 'reason') } })
      return ({ content_version_id: selected.version.id, parent_content_version_id: selected.source.id, version: selected.version.version, revision: selected.version.revision, state: selected.version.state, visualSelection: { state: 'selected', count: selected.version.visualSelection!.items.length, items: selected.version.visualSelection!.items.map(item => ({ visualRef: item.visualRef, ordinal: item.ordinal, mimeType: item.mimeType, reviewStatus: item.reviewStatus, publishable: false })) }, reviewRequired: true, approvalRequired: true })
    }
  }
  throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知图片 MCP 方法: ${method}`, 400)
}
