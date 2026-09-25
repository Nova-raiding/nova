import { assetReadiness, isUsableAssetWithoutScan, type AssetMetadata, type ImageGenerationJob, type MerchantService } from '../../../packages/application/src/service.js'

export function publicImageJob(job: ImageGenerationJob, assets: MerchantService['assets']) {
  return {
    jobId: job.id, productId: job.productId, taskId: job.taskId ?? null, contentVersionId: job.contentVersionId ?? null, revision: job.revision,
    state: job.state, artifactRole: 'candidate', imageMode: job.imageMode, direction: job.direction, requestedCount: job.count, skuIds: job.skuIds ?? [], sourceAssetIds: job.sourceAssetIds ?? [],
    ...(job.continuation ? { continuationState: job.continuation.state, continuationUserActionRequired: job.continuation.state === 'awaiting_rights' } : {}),
    createdAt: job.createdAt, updatedAt: job.updatedAt, archiveState: job.archiveState,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}), ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    binding: job.contentVersionId ? 'exact' : 'unbound', candidateCount: job.outputs?.length ?? job.images?.length ?? 0,
    candidates: (job.outputs ?? []).map(output => ({ visualRef: output.visualRef, ...(output.assetId ? { assetId: output.assetId } : {}), ordinal: output.ordinal, mimeType: output.mimeType, sizeBytes: output.sizeBytes, reviewStatus: output.reviewStatus, scanStatus: output.assetId ? assets.get(output.assetId)?.scanStatus ?? 'missing' : 'unknown' })),
    ...(job.preferredSelection ? { preferredCandidate: { visualRef: job.preferredSelection.visualRef, selectedAt: job.preferredSelection.selectedAt, status: 'preferred', reviewRequired: true, approvalRequired: true, platformPublished: false } } : {}),
    platformUsage: { status: 'not_submitted', observed: false }, selectionRequired: true,
  }
}

export function publicImageJobForCommercialRead(job: ImageGenerationJob, candidatesReadable: boolean, assets: MerchantService['assets']) {
  const projected = publicImageJob(job, assets)
  return candidatesReadable ? projected : { ...projected, archiveState: 'pending', candidateCount: 0, candidates: [], preferredCandidate: undefined, commercialDeliveryBlocked: true }
}

export function assetDisplayProjection(asset: AssetMetadata & { readiness?: ReturnType<typeof assetReadiness> }, allowUnscannedAssets: boolean) {
  const readiness = asset.readiness ?? assetReadiness(asset, allowUnscannedAssets)
  const base = { sourceState: readiness.status, reasons: readiness.reasons }
  if (asset.scanStatus === 'blocked') return { ...base, primaryStatus: 'scan_blocked', label: '安全检查未通过', nextAction: { method: 'asset.upload', label: '重新上传素材', allowed: true } }
  if (!isUsableAssetWithoutScan(asset, allowUnscannedAssets)) return { ...base, primaryStatus: 'awaiting_scan', label: '正在安全检查', nextAction: { method: 'asset.list', label: '刷新状态', allowed: true } }
  if (asset.parseStatus === 'failed') return { ...base, primaryStatus: 'parse_failed', label: '内容读取失败', nextAction: { method: 'asset.facts.confirm', label: '人工确认素材事实', allowed: true } }
  if (asset.parseStatus !== 'succeeded') return { ...base, primaryStatus: 'awaiting_parse', label: '正在读取内容', nextAction: { method: 'asset.parse', label: '读取素材内容', allowed: true } }
  if (asset.rightsStatus === 'rejected' || asset.rightsScope === 'unusable') return { ...base, primaryStatus: 'rights_blocked', label: '使用权益受限', nextAction: { method: 'asset.rights.update', label: '重新确认使用权', allowed: true } }
  if (asset.rightsStatus !== 'approved') return { ...base, primaryStatus: 'awaiting_rights', label: '等待确认使用权', nextAction: { method: 'asset.rights.update', label: '确认商用权益', allowed: true } }
  if (!asset.factsConfirmedBy || !asset.factsConfirmedAt) return { ...base, primaryStatus: 'awaiting_facts_confirmation', label: '等待核对素材事实', nextAction: { method: 'asset.facts.confirm', label: '核对素材事实', allowed: true } }
  return { ...base, primaryStatus: 'ready', label: '可以用于当前任务', nextAction: null }
}

