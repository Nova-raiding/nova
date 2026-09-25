import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedCleanAsset, isUsableAssetWithoutScan, type MerchantService } from '../../../packages/application/src/service.js'
import type { ImageGenerationExecutionRepository } from '../../../packages/persistence/src/image-generation-execution-repository.js'

type ImageJob = ReturnType<MerchantService['getImageGenerationJob']>

export interface HttpImageGenerationJobReadDependencies {
  service: MerchantService
  resolveWorkspace: (req: IncomingMessage, candidate?: unknown) => string
  hydrateWorkspace: (workspaceId: string) => Promise<unknown>
  accessibleProductIds: (req: IncomingMessage, workspaceId: string) => Promise<ReadonlySet<string> | undefined>
  paginationRequest: (url: URL) => { limit: number; offset: number }
  chargedImageCandidatesReadable: (workspaceId: string, job: ImageJob) => Promise<boolean>
  publicImageJobExecutionProjection: (workspaceId: string, jobId: string) => Promise<{ reconciliationRequired: boolean } & Record<string, unknown>>
  publicImageJobForCommercialRead: (job: ImageJob, candidatesReadable: boolean) => Record<string, unknown>
  enrichRequestObservation: (req: IncomingMessage, observation: { jobId: string }) => void
  isExemptUnboundImageCandidateProduct: (workspaceId: string, productId: string) => Promise<boolean>
  enforceProductBrandAccess: (req: IncomingMessage, workspaceId: string, productId: string) => Promise<unknown>
  demoUnscannedAssetsEnabled: () => boolean
  persistSnapshot: (workspaceId: string, entityType: 'image_generation_job', entity: ImageJob, value: Record<string, unknown>) => Promise<void>
  imageGenerationExecutions?: Pick<ImageGenerationExecutionRepository, 'get'>
  imageJobOutputsAreClean: (job: ImageJob) => boolean
  readArchivedGeneratedImages: (workspaceId: string, job: ImageJob) => Promise<string[]>
  respond: (res: ServerResponse, status: number, workspaceId: string, payload: unknown, req: IncomingMessage) => true
}

export async function handleHttpImageGenerationJobRead(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: HttpImageGenerationJobReadDependencies): Promise<boolean> {
  const { service, resolveWorkspace, hydrateWorkspace, accessibleProductIds, paginationRequest, chargedImageCandidatesReadable, publicImageJobExecutionProjection, publicImageJobForCommercialRead, enrichRequestObservation, isExemptUnboundImageCandidateProduct, enforceProductBrandAccess, demoUnscannedAssetsEnabled, persistSnapshot, imageGenerationExecutions, imageJobOutputsAreClean, readArchivedGeneratedImages, respond } = deps
  if (req.method === 'GET' && path === '/v1/image-generation-jobs') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    await hydrateWorkspace(workspaceId)
    const accessibleIds = await accessibleProductIds(req, workspaceId)
    const state = url.searchParams.get('state')?.trim()
    const all = service.listImageGenerationJobs(workspaceId).filter(job =>
      (accessibleIds === undefined || accessibleIds.has(job.productId))
      && (!state || job.state === state),
    )
    const page = paginationRequest(url)
    const items = await Promise.all(all.slice(page.offset, page.offset + page.limit).map(async job => {
      const candidatesReadable = await chargedImageCandidatesReadable(workspaceId, job)
      const executionProjection = await publicImageJobExecutionProjection(workspaceId, job.id)
      return {
        ...publicImageJobForCommercialRead(job, candidatesReadable),
        ...executionProjection,
        reconciliationRequired: !candidatesReadable || executionProjection.reconciliationRequired,
        productTitle: service.products.get(job.productId)?.title ?? null,
        platform: service.products.get(job.productId)?.platform ?? null,
        storeName: service.products.get(job.productId)?.storeName ?? null,
      }
    }))
    return respond(res, 200, workspaceId, { items, total: all.length, ...page }, req)
  }
  const imageGenerationJobGetMatch = path.match(/^\/v1\/image-generation-jobs\/([^/]+)$/u)
  if (req.method === 'GET' && imageGenerationJobGetMatch) {
    const workspaceId = resolveWorkspace(req)
    await hydrateWorkspace(workspaceId)
    let job = service.getImageGenerationJob(workspaceId, decodeURIComponent(imageGenerationJobGetMatch[1]!))
    const candidatesReadable = await chargedImageCandidatesReadable(workspaceId, job)
    enrichRequestObservation(req, { jobId: job.id })
    // `catalog.image.get` is workspace scoped, so the brand boundary has to be
    // enforced here (the MCP read does the same, through the same predicate).
    // Standalone uploaded-image candidates use a local shell product with no
    // canonical binding; reading their status/results must not require a brand
    // grant — binding, selecting and publishing stay permission gated.
    const unboundCandidate = await isExemptUnboundImageCandidateProduct(workspaceId, job.productId)
    if (!unboundCandidate) await enforceProductBrandAccess(req, workspaceId, job.productId)
    // Scanner promotion can finish after the Provider callback. The callback
    // leaves the job pending until every output is clean; promote that durable
    // state on the REST read as well as the MCP read path so the merchant UI
    // does not remain stuck on a queued task after scanning completes.
    const outputsClean = (job.outputs ?? []).length > 0 && (job.outputs ?? []).every(output => {
      const asset = output.assetId ? service.assets.get(output.assetId) : undefined
      return Boolean(asset && isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled()))
    })
    if (candidatesReadable && job.archiveState !== 'archived' && outputsClean) {
      job = service.archiveImageGenerationOutputs(workspaceId, job.id, job.outputs ?? [], 'archived')
      await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
    }
    const execution = await imageGenerationExecutions?.get({ workspaceId, jobId: job.id })
    const images = candidatesReadable && imageJobOutputsAreClean(job) ? await readArchivedGeneratedImages(workspaceId, job) : []
    return respond(res, 200, workspaceId, {
      job_id: job.id,
      revision: job.revision,
      state: job.state,
      archive_state: candidatesReadable ? job.archiveState : 'pending',
      product_id: job.productId,
      task_id: job.taskId ?? null,
      content_version_id: job.contentVersionId ?? null,
      image_mode: job.imageMode,
      direction: job.direction,
      requested_count: job.count,
      source_asset_ids: job.sourceAssetIds ?? [],
      source_product_version: job.sourceProductVersion,
      intent_hash: job.intentHash,
      execution_state: execution?.state ?? null,
      provider_request_id: execution?.providerRequestId ?? null,
      execution_attempt: execution?.attempt ?? null,
      reconciliation_required: !candidatesReadable || execution?.state === 'provider_reserved' || execution?.state === 'provider_dispatching' || execution?.state === 'provider_started' || execution?.state === 'outcome_unknown' || job.archiveState !== 'archived',
      error_code: job.errorCode ?? null,
      error_message: job.errorMessage ?? null,
      updated_at: job.updatedAt,
      created_at: job.createdAt,
      ...(candidatesReadable && job.preferredSelection ? { preferred_candidate: { visual_ref: job.preferredSelection.visualRef, selected_at: job.preferredSelection.selectedAt, status: 'preferred', review_required: true, approval_required: true, platform_published: false } } : {}),
      outputs: (candidatesReadable ? job.outputs ?? [] : []).map(output => {
        const asset = output.assetId ? service.assets.get(output.assetId) : undefined
        const blockers = [
          ...(job.archiveState !== 'archived' ? ['候选尚未完整归档'] : []),
          ...(!asset || !isTrustedCleanAsset(asset) ? ['安全扫描凭据尚未通过可信校验'] : []),
          ...(output.reviewStatus !== 'passed' ? ['尚未完成人工视觉审核'] : []),
        ]
        return {
          visual_ref: output.visualRef,
          ordinal: output.ordinal,
          asset_id: output.assetId ?? null,
          archive_receipt_id: output.archiveReceiptId ?? null,
          archive_receipt_digest: output.archiveReceiptDigest ?? null,
          storage_key: output.storageKey,
          mime_type: output.mimeType,
          size_bytes: output.sizeBytes,
          sha256: output.sha256,
          created_at: output.createdAt,
          review_status: output.reviewStatus,
          gate: {
            archive: job.archiveState,
            scan: asset?.scanStatus ?? 'unknown',
            rights: asset?.rightsStatus ?? 'unknown',
            authenticity: output.authenticity?.report?.publishable === true ? 'passed' : output.authenticity?.externallyUnverified ? 'unverified' : 'not_checked',
            selectable: blockers.length === 0,
            blockers,
          },
        }
      }),
      ...(images.length ? { images } : {}),
      ...(images.length ? {} : { availability_warning: !candidatesReadable ? '图片结果尚未通过原始用量、成本与创意点结算核验；候选暂不显示，等待对账。' : job.archiveState === 'archived' ? '候选已归档，安全扫描或真实性检查尚未完成。' : '图片任务尚未形成可交付候选。' }),
      next_action: !candidatesReadable || execution?.state === 'outcome_unknown' || execution?.state === 'provider_started' ? { type: 'reconcile', label: '等待结算证据对账或查看执行状态', allowed: true } : job.state === 'failed' ? { type: 'review_error', label: '查看失败原因', allowed: true } : job.state === 'succeeded' && images.length ? { type: 'review_candidates', label: '查看候选', allowed: true } : { type: 'refresh_status', label: '刷新任务状态', allowed: true },
    }, req)
  }
  return false
}
