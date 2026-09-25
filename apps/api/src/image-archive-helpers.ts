import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DomainError, imageArchiveReceiptDigest, imageGenerationCandidateUsability, isUsableAssetWithoutScan } from '../../../packages/application/src/service.js'
import { GENERATED_IMAGE_MIME, generatedImageSignatureMatches, imageArtifactBody } from './image-artifact-policy.js'
import type { imageArchiveRuntime } from './server.js'

type ImageArchiveRuntime = ReturnType<typeof imageArchiveRuntime>

export function createImageArchiveHelpers(runtime: ImageArchiveRuntime) {
  const { service, demoUnscannedAssetsEnabled, putQuarantineObject, persistAssetSnapshotAndEvent, compensateStoredAsset, assetForWorkspace, automaticallyScanLocalFixture, getStoredObjectWithRetry } = runtime
async function archiveGeneratedImages(workspaceId: string, jobId: string, images: readonly string[]) {
  const outputs: import('../../../packages/application/src/service.js').VisualGenerationOutput[] = []
  const createdAssetIds: string[] = []
  const storedAssets: Array<{ assetId: string; objectKey: string }> = []
  let totalBytes = 0
  try {
    for (const [index, image] of images.entries()) {
    const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu)
    const downloaded = !match && /^https:\/\//iu.test(image) ? await imageArtifactBody(image) : undefined
    if (!match && !downloaded) throw new DomainError('GENERATED_IMAGE_FORMAT_INVALID', '图片生成服务返回了不支持的图片引用', 502)
    const mimeType = downloaded?.mimeType ?? match![1]!.toLowerCase()
    const extension = GENERATED_IMAGE_MIME.get(mimeType)
    if (!extension || (match && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(match[2]!))) throw new DomainError('GENERATED_IMAGE_FORMAT_INVALID', '图片生成服务返回了不支持的图片格式', 502)
    const body = downloaded?.body ?? new Uint8Array(Buffer.from(match![2]!, 'base64'))
    if (!generatedImageSignatureMatches(mimeType, body)) throw new DomainError('GENERATED_IMAGE_SIGNATURE_INVALID', '图片生成服务返回的 MIME 类型与文件内容不匹配', 502)
    totalBytes += body.byteLength
    if (!body.byteLength || body.byteLength > 15 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) throw new DomainError('GENERATED_IMAGE_TOO_LARGE', '生成图片超过归档大小限制', 413)
    const asset = service.registerAsset({ workspaceId, name: `candidate-${index + 1}.${extension}`, mimeType, sizeBytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), storageKey: `quarantine/${workspaceId}/generated_pending_${randomBytes(12).toString('hex')}/candidate-${index + 1}.${extension}`, ...(demoUnscannedAssetsEnabled() ? { scanMode: 'unscanned' as const } : {}) })
    createdAssetIds.push(asset.id)
    const stored = await putQuarantineObject({ workspaceId, assetId: asset.id, fileName: `candidate-${index + 1}.${extension}`, contentType: mimeType, body, expectedSizeBytes: body.byteLength })
      storedAssets.push({ assetId: asset.id, objectKey: stored.key })
      asset.storageKey = stored.key
      asset.sha256 = stored.sha256
      asset.sizeBytes = stored.sizeBytes
      const archiveReceiptId = `image_archive_${randomUUID()}`
      const archiveReceiptDigest = imageArchiveReceiptDigest({ archiveReceiptId, workspaceId, jobId, assetId: asset.id, objectSha256: stored.sha256, sizeBytes: stored.sizeBytes, mimeType, createdAt: stored.createdAt })
      await persistAssetSnapshotAndEvent(workspaceId, asset, demoUnscannedAssetsEnabled() ? 'asset.generated_unscanned' : 'asset.generated_quarantined', { asset_id: asset.id, job_id: jobId, archive_receipt_id: archiveReceiptId, archive_receipt_digest: archiveReceiptDigest, storage_key: stored.key, sha256: stored.sha256, size_bytes: stored.sizeBytes, scan_status: asset.scanStatus, ...(demoUnscannedAssetsEnabled() ? {} : { next_action: 'asset.scan' }) }, asset as unknown as Record<string, unknown>)
      outputs.push({ visualRef: `dvis_${randomBytes(18).toString('base64url')}`, assetId: asset.id, archiveReceiptId, archiveReceiptDigest, ordinal: index + 1, storageKey: stored.key, mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, createdAt: stored.createdAt, reviewStatus: 'unreviewed' })
    }
    const archiveState = outputs.length === images.length ? (process.env.NODE_ENV === 'test' || demoUnscannedAssetsEnabled() ? 'archived' : 'pending') : outputs.length ? 'partial' : 'external_unarchived'
    if (!outputs.length) throw new DomainError('GENERATED_IMAGE_ARCHIVE_EMPTY', '图片模型已返回但没有可安全归档的候选，已停止自动重试并等待对账', 502)
    const archived = service.archiveImageGenerationOutputs(workspaceId, jobId, outputs, archiveState)
    for (const output of outputs) {
      if (!output.assetId) continue
      const asset = assetForWorkspace(workspaceId, output.assetId)
      await automaticallyScanLocalFixture(workspaceId, asset)
    }
    const current = service.imageGenerationJobs.get(jobId)
    if (current && (current.outputs ?? []).length === outputs.length && (current.outputs ?? []).every(output => {
      const asset = output.assetId ? service.assets.get(output.assetId) : undefined
      return Boolean(asset && output.archiveReceiptId && output.archiveReceiptDigest && isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled()))
    })) {
      return service.archiveImageGenerationOutputs(workspaceId, jobId, current.outputs ?? outputs, 'archived')
    }
    return service.imageGenerationJobs.get(jobId) ?? archived
  } catch (error) {
    await Promise.all(storedAssets.map(item => compensateStoredAsset(workspaceId, item.assetId, item.objectKey, 'generated image archive failed after object upload')))
    for (const assetId of createdAssetIds) service.assets.delete(assetId)
    throw error
  }
}

async function readArchivedGeneratedImages(workspaceId: string, job: import('../../../packages/application/src/service.js').ImageGenerationJob, visualRef?: string) {
  const images: string[] = []
  if (job.archiveState !== 'archived') throw new DomainError('GENERATED_IMAGE_ARCHIVE_REQUIRED', '生成候选尚未完成可信归档，暂不可读取', 409, { job_id: job.id, user_action_required: false })
  const outputs = [...(job.outputs ?? [])].filter(output => !visualRef || output.visualRef === visualRef).sort((left, right) => left.ordinal - right.ordinal)
  for (const output of outputs) {
    const asset = output.assetId ? assetForWorkspace(workspaceId, output.assetId) : undefined
    const usability = imageGenerationCandidateUsability({ workspaceId, job, output, asset, allowUnscannedAssets: demoUnscannedAssetsEnabled() })
    if (!usability.currentlyUsable) {
      if (usability.reason === 'asset_scan_required' || usability.reason === 'asset_missing_or_scope_mismatch') throw new DomainError('GENERATED_IMAGE_SCAN_REQUIRED', '生成候选仍在平台自动安全扫描中，完成前不会向 ChatGPT 返回图片内容', 409, { job_id: job.id, visual_ref: output.visualRef, user_action_required: false })
      throw new DomainError('GENERATED_IMAGE_INTEGRITY_FAILED', '历史生成图片归档完整性校验失败', 500, { job_id: job.id, visual_ref: output.visualRef, reason: usability.reason })
    }
    if (!asset) throw new DomainError('GENERATED_IMAGE_INTEGRITY_FAILED', '历史生成图片缺少可验证的素材归档引用', 500, { job_id: job.id, visual_ref: output.visualRef })
    const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey, { includeQuarantine: asset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() })
    const digest = createHash('sha256').update(stored.body).digest('hex')
    if (stored.metadata.sha256 !== output.sha256 || stored.metadata.sizeBytes !== output.sizeBytes || stored.metadata.contentType !== output.mimeType || digest !== output.sha256 || asset.sha256 !== output.sha256) throw new DomainError('GENERATED_IMAGE_INTEGRITY_FAILED', '历史生成图片完整性校验失败', 500)
    images.push(`data:${output.mimeType};base64,${Buffer.from(stored.body).toString('base64')}`)
  }
  return images
}

function imageJobOutputsAreClean(job: import('../../../packages/application/src/service.js').ImageGenerationJob, visualRef?: string) {
  const outputs = job.outputs?.filter(output => !visualRef || output.visualRef === visualRef) ?? []
  return job.archiveState === 'archived' && Boolean(outputs.length) && outputs.every(output => {
    const asset = output.assetId ? service.assets.get(output.assetId) : undefined
    return imageGenerationCandidateUsability({ workspaceId: job.workspaceId, job, output, asset, allowUnscannedAssets: demoUnscannedAssetsEnabled() }).currentlyUsable
  })
}

async function sourceImagesForImageJob(workspaceId: string, job: import('../../../packages/application/src/service.js').ImageGenerationJob) {
  if (!job.sourceAssetIds?.length) return []
  return Promise.all(job.sourceAssetIds.map(async assetId => {
    const asset = assetForWorkspace(workspaceId, assetId)
    const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey, { includeQuarantine: asset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() })
    return `data:${asset.mimeType};base64,${Buffer.from(stored.body).toString('base64')}`
  }))
}

/** Replays the durable completion projection safely after an API response was
 * committed but the Worker lost the follow-up acknowledgement. The outbox
 * unique key (workspace, aggregate, event type, sequence) makes this repair
 * idempotent, while the snapshot and event still commit in one transaction. */
  return { archiveGeneratedImages, readArchivedGeneratedImages, imageJobOutputsAreClean, sourceImagesForImageJob }
}
