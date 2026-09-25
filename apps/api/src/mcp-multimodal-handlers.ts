import type { GenerationContext } from '../../../packages/multimodal/src/index.js'

type Dependencies = Record<string, any>

export async function handleMultimodalMcpMethod(method: string, params: Record<string, unknown>, dependencies: Dependencies): Promise<unknown> {
  const {
    req, workspaceId, result, observeLegacyWalletShadow, required, DomainError, ERROR_CODES,
    createImageEditCandidate, requireProtectedProductIntent, protectedProductConclusion,
    assetForWorkspace, isUsableAssetWithoutScan, demoUnscannedAssetsEnabled,
    getStoredObjectWithRetry, service, canonicalProductReadControl, resolveCanonicalTaskScope,
    requireGenerationRulePreflight, requireRuleSafeGenerationText, enforceMcpCommercialAccess,
    requirePlatformModelCostGate, reserveCreativePointsForModel, requestActor,
    refundPluginWalletDebit, persistEvent, isProduction, executionContract,
    imageEditGenerator, appendProtectedProductConstraints, archiveGeneratedImages,
    persistSnapshot, providerSucceededButSettlementPending, releaseReservedModelPoints,
    generationRulePreflight, enforceProductBrandAccess, createOneSentenceGenerationRequest,
    evaluateStoryboardBeforeRendering, requireVideoModelCostPreflight, contentGenerator,
    imageGenerator, createHash, sourceImagesForImageJob, imageJobOutputsAreClean,
    readArchivedGeneratedImages, createVideoRenderingRequest, createVideoGenerationRequest,
    videoGenerator, header, isExemptUnboundImageCandidateProduct, enforceAssetAccess,
    requireApprovedAssetForImageGeneration, recordActionSettlement, randomUUID,
    assertVideoProviderJobScope, archiveCompletedVideo, modelSettlementDomainError,
    publicImageJob,
  } = dependencies
  switch (method) {
    case 'multimodal.image.edit': {
      await observeLegacyWalletShadow(workspaceId)
      let request: unknown
      try { request = JSON.parse(required(params, 'request_json')) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'request_json 必须是合法 JSON', 400) }
      const candidate = createImageEditCandidate(request as never)
      if (!candidate.ok) throw new DomainError(ERROR_CODES.INVALID_REQUEST, candidate.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 400)
      const protectedProductValidation = requireProtectedProductIntent(candidate.value.prompt)
      const productProtection = protectedProductConclusion(protectedProductValidation)
      const sourceAsset = assetForWorkspace(workspaceId, candidate.value.sourceImageId)
      const sourceReady = sourceAsset.mimeType.toLowerCase().startsWith('image/')
        && isUsableAssetWithoutScan(sourceAsset, demoUnscannedAssetsEnabled())
        && sourceAsset.rightsStatus === 'approved'
        && sourceAsset.rightsScope !== 'unusable'
        && sourceAsset.aiModificationAllowed === true
        && (!sourceAsset.usageScopes?.length || sourceAsset.usageScopes.includes('commercial') || sourceAsset.usageScopes.includes('ai_generation'))
        && (!sourceAsset.validFrom || Date.parse(sourceAsset.validFrom) <= Date.now())
        && (!sourceAsset.validTo || Date.parse(sourceAsset.validTo) >= Date.now())
      if (!sourceReady) throw new DomainError('IMAGE_SOURCE_ASSET_INVALID', '图片编辑必须使用当前工作区内已通过扫描、权益和 AI 修改许可的素材', 409, { asset_id: sourceAsset.id, scan_status: sourceAsset.scanStatus, rights_status: sourceAsset.rightsStatus, scan_user_action_required: false, next_step: '平台会自动完成安全扫描；扫描通过后仅需确认权益和 AI 修改许可' })
      const sourceStored = await getStoredObjectWithRetry(workspaceId, sourceAsset.storageKey, { includeQuarantine: sourceAsset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() })
      const contextProduct = service.products.get(candidate.value.context.product.id)
      if ((await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') {
        if (!contextProduct || contextProduct.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '图片编辑引用的商品不存在或不属于当前工作区', 404)
        await resolveCanonicalTaskScope({ workspaceId, productId: contextProduct.id, platform: contextProduct.platform, ...(contextProduct.accountId ? { accountId: contextProduct.accountId } : {}), requireCanonical: true, requireListing: true })
      }
      if (contextProduct && contextProduct.workspaceId === workspaceId && !contextProduct.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '图片编辑需要先确认商品事实', 409)
      const rulePreflight = await requireGenerationRulePreflight(workspaceId, candidate.value.context.product.id, '图片编辑前平台规则校验未通过')
      requireRuleSafeGenerationText(rulePreflight, [candidate.value.prompt], '图片编辑指令命中当前平台规则禁用表达')
      const commercialDecision = await enforceMcpCommercialAccess(req, workspaceId, method)
      requirePlatformModelCostGate('image_edit')
      const walletDebitKey = `image-edit:${candidate.value.id}`
      const creativeReservation = await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)
      await observeLegacyWalletShadow(workspaceId)
      let walletRefunded = false
      const refundEditWallet = async (reason: string) => {
        if (walletRefunded) return
        walletRefunded = true
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason })
      }
      try {
        await persistEvent(workspaceId, candidate.value.id, 'multimodal.image.edit_requested', 1, { ...candidate.value, product_protection: productProtection } as unknown as Record<string, unknown>)
        if (!imageEditGenerator) {
          if (isProduction()) {
            await refundEditWallet('图片编辑 provider 未配置')
            throw new DomainError('IMAGE_EDIT_NOT_CONFIGURED', '生产环境未配置图片编辑中转服务', 503)
          }
          return result({ ...candidate.value, product_protection: productProtection, execution: executionContract('image_edit', false) })
        }
        let images: string[]
        images = await imageEditGenerator.generate({ prompt: appendProtectedProductConstraints(candidate.value.prompt), sourceImages: [{ bytes: sourceStored.body, mimeType: sourceStored.metadata.contentType }], region: candidate.value.region.rect, usageContext: { workspaceId, actionId: walletDebitKey, runKey: `image-edit:${walletDebitKey}` } })
        if (!contextProduct || contextProduct.workspaceId !== workspaceId) return result({ ...candidate.value, product_protection: productProtection, images, rendering: 'candidate', platformPublished: false, execution: executionContract('image_edit', true) })
        const editJob = service.enqueueImageGeneration({ workspaceId, productId: contextProduct.id, sourceAssetIds: [sourceAsset.id], direction: `局部编辑：${candidate.value.prompt}`, count: 1, idempotencyKey: `image-edit:${candidate.value.id}` })
        editJob.state = 'succeeded'
        const archived = await archiveGeneratedImages(workspaceId, editJob.id, images)
        await persistSnapshot(workspaceId, 'image_generation_job', archived, archived as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, archived.id, 'product.image_edit_candidate_generated', archived.revision, { job_id: archived.id, product_id: contextProduct.id, source_asset_id: sourceAsset.id, visual_refs: archived.outputs?.map(output => output.visualRef) ?? [], artifact_role: 'candidate', product_protection: productProtection })
        return result({ ...candidate.value, product_protection: productProtection, images, rendering: 'candidate', platformPublished: false, execution: executionContract('image_edit', true), job: publicImageJob(archived) })
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) {
          await releaseReservedModelPoints(workspaceId, walletDebitKey, '图片编辑失败', creativeReservation)
          await refundEditWallet('图片编辑任务或 provider 失败')
        }
        throw error
      }
    }
    case 'multimodal.generate': {
      let context: GenerationContext
      try { context = JSON.parse(required(params, 'context_json')) as GenerationContext } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'context_json 必须是合法 JSON', 400) }
      await enforceProductBrandAccess(req, workspaceId, context.product.id)
      if ((await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') {
        const product = service.products.get(context.product.id)
        if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '多模态请求引用的商品不存在或不属于当前工作区', 404)
        await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      }
      await observeLegacyWalletShadow(workspaceId)
      const rulePreflight = await generationRulePreflight(workspaceId, context.product.id)
      if (rulePreflight.blocking) throw new DomainError('PLATFORM_RULE_PREFLIGHT_BLOCKED', '当前店铺平台规则存在阻断项，不能继续生成', 409, { rule_preflight: rulePreflight })
      const modality = required(params, 'modality') as 'text' | 'image' | 'video'
      requireRuleSafeGenerationText(rulePreflight, [params.prompt], '多模态生成指令命中当前平台规则禁用表达')
      const request = createOneSentenceGenerationRequest(modality === 'video'
        ? { modality, prompt: required(params, 'prompt'), output: typeof params.output === 'string' ? params.output as 'script' | 'storyboard' | 'rendering' : 'script', context }
        : { modality, prompt: required(params, 'prompt'), context })
      if (!request.ok) throw new DomainError(ERROR_CODES.INVALID_REQUEST, request.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 400)
      const storyboardQuality = request.value.modality === 'video' && request.value.output === 'rendering' ? evaluateStoryboardBeforeRendering(context) : undefined
      if (request.value.modality === 'image') requirePlatformModelCostGate('image')
      if (request.value.modality === 'text' || (request.value.modality === 'video' && request.value.output !== 'rendering')) requirePlatformModelCostGate('text')
      if (request.value.modality === 'video' && request.value.output === 'rendering') await requireVideoModelCostPreflight()
      const commercialOperation = request.value.modality === 'image'
        ? 'catalog.image.generate'
        : request.value.modality === 'video'
          ? 'multimodal.video.request'
          : 'content.generate'
      const commercialDecision = await enforceMcpCommercialAccess(req, workspaceId, commercialOperation)
      const multimodalKey = createHash('sha256').update(JSON.stringify(request.value)).digest('hex')
      // Image execution derives its provider usage identity from the persisted
      // job idempotency key. Keep the commercial action and budget reservation
      // on that exact identity so the nested image relay cannot create a second,
      // permanently-active reservation.
      const walletDebitKey = request.value.modality === 'image'
        ? `image:multimodal-image:${multimodalKey}`
        : `multimodal:${multimodalKey}`
      const modelRunKey = request.value.modality === 'video' && request.value.output === 'rendering'
        ? `video:${walletDebitKey}`
        : walletDebitKey
      const creativeReservation = await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)
      await observeLegacyWalletShadow(workspaceId)
      let rendering: Awaited<ReturnType<NonNullable<typeof videoGenerator>['generate']>> | undefined
      let generatedImages: string[] | undefined
      let imageJob: ReturnType<typeof service.enqueueImageGeneration> | undefined
      let generatedText: Awaited<ReturnType<typeof service.generateOneSentenceText>> | undefined
      try {
        if (request.value.modality === 'text') {
          generatedText = await service.generateOneSentenceText({ workspaceId, productId: request.value.context.product.id, prompt: request.value.prompt, actionId: walletDebitKey })
        }
        if (request.value.modality === 'video' && request.value.output !== 'rendering') {
          generatedText = await service.generateOneSentenceText({ workspaceId, productId: request.value.context.product.id, prompt: `${request.value.output}：${request.value.prompt}`, actionId: walletDebitKey })
        }
        if (request.value.modality === 'image') {
          const product = service.products.get(request.value.context.product.id)
          if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '多模态图片请求引用的商品不存在或不属于当前工作区', 404)
          if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '多模态图片生成需要先确认商品事实', 409)
          service.assertBrandVisualGenerationReady(workspaceId, product.platform)
          imageJob = service.enqueueImageGeneration({ workspaceId, productId: product.id, direction: request.value.prompt, count: 1, idempotencyKey: `multimodal-image:${multimodalKey}` })
          const completed = await service.completeImageGeneration({ workspaceId, jobId: imageJob.id, runKey: modelRunKey, sourceImages: await sourceImagesForImageJob(workspaceId, imageJob) })
          // Multimodal image requests must converge through the same durable
          // candidate archive as catalog.image.generate. Returning the raw
          // provider payload here used to make the image visible in ChatGPT
          // while leaving no selectable/reviewable candidate behind.
          const archived = await archiveGeneratedImages(workspaceId, imageJob.id, completed.images)
          await persistSnapshot(workspaceId, 'image_generation_job', archived, archived as unknown as Record<string, unknown>)
          generatedImages = imageJobOutputsAreClean(archived)
            ? await readArchivedGeneratedImages(workspaceId, archived)
            : []
        }
        if (request.value.modality === 'video' && (request.value.output as string) === 'rendering') {
          if (!videoGenerator) throw new DomainError('VIDEO_GENERATION_NOT_CONFIGURED', '未配置视频生成中转服务', 503, { provider_executed: false })
          rendering = await archiveCompletedVideo(workspaceId, await videoGenerator.generate({ prompt: request.value.prompt, output: 'rendering', context: request.value.context, usageContext: { workspaceId, actionId: walletDebitKey, runKey: modelRunKey } }))
        }
        if (generatedText) requireRuleSafeGenerationText(rulePreflight, [generatedText], '多模态生成结果命中当前平台规则禁用表达')
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) {
          await releaseReservedModelPoints(workspaceId, walletDebitKey, '多模态生成失败', creativeReservation)
          await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '多模态生成 provider 调用失败' })
        }
        throw error
      }
      const providerExecuted = request.value.modality === 'text' || (request.value.modality === 'video' && request.value.output !== 'rendering')
        ? Boolean(contentGenerator)
        : request.value.modality === 'image' ? Boolean(imageGenerator) : Boolean(rendering)
      const execution = { status: rendering ? rendering.status : generatedImages || generatedText ? 'completed' as const : 'requested' as const, ...executionContract(request.value.modality === 'text' ? 'content' : request.value.modality, providerExecuted) }
      try {
        await persistEvent(workspaceId, `multimodal_${randomUUID()}`, rendering || generatedImages || generatedText ? 'multimodal.generation.completed' : 'multimodal.generation.requested', 1, { ...request.value as unknown as Record<string, unknown>, execution, rule_preflight: rulePreflight, ...(storyboardQuality ? { storyboard_quality: storyboardQuality } : {}), ...(imageJob ? { image_job_id: imageJob.id } : {}), ...(generatedText ? { content: generatedText } : {}), ...(generatedImages ? { images: generatedImages } : {}), ...(rendering ? { rendering } : {}) })
      } catch (error) {
        if (!providerExecuted) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '多模态结果记录失败' })
        throw error
      }
      return result({ ...request.value, execution, rule_preflight: rulePreflight, ...(storyboardQuality ? { storyboard_quality: storyboardQuality } : {}), ...(generatedText ? { content: generatedText } : {}), ...(imageJob ? { image_job_id: imageJob.id } : {}), ...(generatedImages ? { images: generatedImages } : {}), ...(rendering ? { rendering } : {}) })
    }
    case 'multimodal.video.request': {
      let context: GenerationContext
      try { context = JSON.parse(required(params, 'context_json')) as GenerationContext } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'context_json 必须是合法 JSON', 400) }
      const candidateOnly = context.candidateOnly === true
      const sourceProduct = service.products.get(context.product?.id)
      let sourceImage: string | undefined
      if (candidateOnly) {
        // Same exemption, same authorization fact as the image reads: a
        // merchant-settable `storeName` must not be able to turn a
        // brand-bound product into an unbound candidate.
        if (!sourceProduct || sourceProduct.workspaceId !== workspaceId || !sourceProduct.sourceAssetIds?.length || !(await isExemptUnboundImageCandidateProduct(workspaceId, sourceProduct.id))) throw new DomainError('VIDEO_CANDIDATE_SOURCE_REQUIRED', '未绑定视频必须引用当前工作区上传图片创建的候选商品', 409)
        for (const assetId of sourceProduct.sourceAssetIds) await enforceAssetAccess(req, workspaceId, assetId, 'viewer')
        requireApprovedAssetForImageGeneration(workspaceId, sourceProduct, sourceProduct.sourceAssetIds, true)
        const sourceAsset = assetForWorkspace(workspaceId, sourceProduct.sourceAssetIds[0]!)
        const sourceObject = await getStoredObjectWithRetry(workspaceId, sourceAsset.storageKey, { includeQuarantine: sourceAsset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() })
        sourceImage = `data:${sourceAsset.mimeType};base64,${Buffer.from(sourceObject.body).toString('base64')}`
      } else await enforceProductBrandAccess(req, workspaceId, context.product.id)
      if (!candidateOnly && (await canonicalProductReadControl(workspaceId)).mode === 'canonical_read') {
        const product = service.products.get(context.product.id)
        if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '视频请求引用的商品不存在或不属于当前工作区', 404)
        await resolveCanonicalTaskScope({ workspaceId, productId: product.id, platform: product.platform, ...(product.accountId ? { accountId: product.accountId } : {}), requireCanonical: true, requireListing: true })
      }
      await observeLegacyWalletShadow(workspaceId)
      const suppliedVideoRequestKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      if (isProduction() && !suppliedVideoRequestKey) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '生产视频请求必须提供 idempotency_key 或 Idempotency-Key 请求头', 400)
      const rulePreflight = await generationRulePreflight(workspaceId, context.product.id)
      if (!candidateOnly && rulePreflight.blocking) throw new DomainError('PLATFORM_RULE_PREFLIGHT_BLOCKED', '当前店铺平台规则存在阻断项，不能继续生成视频', 409, { rule_preflight: rulePreflight })
      const output = required(params, 'output') as 'script' | 'storyboard' | 'rendering'
      requireRuleSafeGenerationText(rulePreflight, [params.prompt], '视频生成指令命中当前平台规则禁用表达')
      if (output !== 'rendering') requirePlatformModelCostGate('text')
      const request = output === 'rendering'
        ? createVideoRenderingRequest({ prompt: required(params, 'prompt'), context })
        : createVideoGenerationRequest({ prompt: required(params, 'prompt'), output, context })
      if (!request.ok) throw new DomainError(ERROR_CODES.INVALID_REQUEST, request.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 400)
      const storyboardQuality = request.value.output === 'rendering' ? evaluateStoryboardBeforeRendering(context) : undefined
      if (request.value.output === 'rendering') await requireVideoModelCostPreflight(Boolean(sourceImage))
      const commercialDecision = await enforceMcpCommercialAccess(req, workspaceId, method)
      const videoRequestKey = suppliedVideoRequestKey || randomUUID()
      const walletDebitKey = `video:${videoRequestKey}`
      const modelRunKey = request.value.output === 'rendering' ? `video:${walletDebitKey}` : walletDebitKey
      const creativeReservation = await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)
      // Persist the authorization before calling the provider. Model usage
      // receipts carry this action key and the ledger enforces the FK, so a
      // successful provider request can be settled durably and idempotently.
      await recordActionSettlement({
        workspaceId,
        actionKey: walletDebitKey,
        actionKind: 'model_video',
        settlement: 'included_quota',
        amountFen: 0,
        actorId: requestActor(req),
        description: '商品视频生成（商品展示、卖点字幕与剪辑）',
        settlementStatus: 'authorized',
      })
      await observeLegacyWalletShadow(workspaceId)
      let rendering: Awaited<ReturnType<NonNullable<typeof videoGenerator>['generate']>> | undefined
      let generatedPlan: Awaited<ReturnType<typeof service.generateOneSentenceText>> | undefined
      try {
        if (request.value.output !== 'rendering') generatedPlan = await service.generateOneSentenceText({ workspaceId, productId: request.value.context.product.id, prompt: `${request.value.output}：${request.value.prompt}`, actionId: walletDebitKey })
        if ((request.value.output as string) === 'rendering') {
          if (!videoGenerator) throw new DomainError('VIDEO_GENERATION_NOT_CONFIGURED', '未配置视频生成中转服务', 503, { provider_executed: false })
          rendering = await archiveCompletedVideo(workspaceId, await videoGenerator.generate({ prompt: request.value.prompt, output: 'rendering', context: request.value.context, ...(sourceImage ? { sourceImage } : {}), usageContext: { workspaceId, actionId: walletDebitKey, runKey: modelRunKey } }))
        }
        if (generatedPlan) requireRuleSafeGenerationText(rulePreflight, [generatedPlan], '视频脚本或分镜命中当前平台规则禁用表达')
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) {
          await releaseReservedModelPoints(workspaceId, walletDebitKey, '视频生成失败', creativeReservation)
          await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '视频生成 provider 调用失败' })
        }
        throw error
      }
      const providerExecuted = Boolean(rendering ? videoGenerator : generatedPlan && contentGenerator)
      const execution = { status: rendering ? rendering.status : generatedPlan ? 'completed' as const : 'requested' as const, ...executionContract('video', providerExecuted, generatedPlan && contentGenerator ? 'text-relay' : undefined) }
      try {
        await persistEvent(workspaceId, `video_${randomUUID()}`, rendering || generatedPlan ? 'multimodal.video_completed' : 'multimodal.video.requested', 1, { ...request.value as unknown as Record<string, unknown>, execution, rule_preflight: rulePreflight, ...(storyboardQuality ? { storyboard_quality: storyboardQuality } : {}), ...(generatedPlan ? { plan: generatedPlan } : {}), ...(rendering ? { rendering } : {}) })
      } catch (error) {
        if (!providerExecuted) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '视频结果记录失败' })
        throw error
      }
      return result({ ...request.value, candidate_only: candidateOnly, ...(candidateOnly ? { candidate_status: '未绑定商品、仅候选、不可发布' } : {}), execution, rule_preflight: rulePreflight, ...(storyboardQuality ? { storyboard_quality: storyboardQuality } : {}), ...(generatedPlan ? { plan: generatedPlan } : {}), ...(rendering ? { rendering } : {}) })
    }
    case 'multimodal.video.get': {
      if (!videoGenerator) throw new DomainError('VIDEO_GENERATION_NOT_CONFIGURED', '未配置视频生成中转服务', 503, { provider_executed: false })
      const providerJobId = required(params, 'provider_job_id')
      try {
        await assertVideoProviderJobScope(workspaceId, providerJobId)
        const rendering = await archiveCompletedVideo(workspaceId, await videoGenerator.getStatus(providerJobId))
        await persistEvent(workspaceId, `video_${providerJobId}`, 'multimodal.video_status_observed', 1, { provider_job_id: providerJobId, ...rendering })
        return result({ provider_job_id: providerJobId, execution: executionContract('video', true), ...(rendering.assetId ? { asset_id: rendering.assetId, archive_state: rendering.archiveState, ...(rendering.archiveState === 'archived' ? { download_path: `/v1/assets/${encodeURIComponent(rendering.assetId)}/download` } : { availabilityWarning: '视频已安全归档到隔离区，平台自动安全扫描通过后才可下载或发布；无需商家或运营人员操作' }) } : {}), ...rendering })
      } catch (error) {
        if (error instanceof DomainError) throw error
        const archived = service.findAssetBySourceProviderJobId(workspaceId, providerJobId)
        if (archived) return result({ provider_job_id: providerJobId, status: 'completed', asset_id: archived.id, archive_state: isUsableAssetWithoutScan(archived, demoUnscannedAssetsEnabled()) ? 'archived' : 'quarantined', ...(isUsableAssetWithoutScan(archived, demoUnscannedAssetsEnabled()) ? { download_path: `/v1/assets/${encodeURIComponent(archived.id)}/download` } : { availabilityWarning: '视频已安全归档到隔离区，平台自动安全扫描通过后才可下载或发布；无需商家或运营人员操作' }), execution: executionContract('video', false) })
        const providerFailure = modelSettlementDomainError(error)
        if (providerFailure) throw providerFailure
        throw new DomainError('VIDEO_PROVIDER_STATUS_FAILED', error instanceof Error ? error.message : '视频 provider 状态查询失败', 503)
      }
    }
  }
  throw new DomainError('MCP_METHOD_NOT_FOUND', `不支持的多模态方法: ${method}`, 404)
}
