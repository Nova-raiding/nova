import type { IncomingMessage } from 'node:http'
import { DomainError, isUsableAssetWithoutScan, type AssetMetadata, type ImageGenerationContinuationState, type ImageGenerationJob, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { classifyAssetUploadBatch, type AssetUploadSecurityResult } from './asset-upload-security.js'
import type { WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'

type SnapshotInput = { entityType: 'asset' | 'image_generation_job'; entityId: string; entityVersion: number; payload: Record<string, unknown> }
type JsonObject = Record<string, unknown>
type ListedAsset = ReturnType<MerchantService['listAssets']>[number]
type AssetDisplay = { nextAction: { method: string; label: string } | null }

type Dependencies = {
  service: MerchantService
  required: (params: Record<string, unknown>, key: string) => string
  requestActor: (req: IncomingMessage) => string
  requestId: (req: IncomingMessage) => string
  accessibleAssetIds: (req: IncomingMessage, workspaceId: string) => Promise<ReadonlySet<string> | undefined>
  assetDisplayProjection: (asset: ListedAsset) => AssetDisplay
  conversationalAssetScanWaitingState: () => { message: string }
  getStorageQuotaSnapshot: (workspaceId: string) => Promise<{ limitBytes: number; usedBytes: number; reservedBytes: number } | undefined> | undefined
  configuredStorageQuotaLimit: () => number
  enforceAssetAccess: (req: IncomingMessage, workspaceId: string, assetId: string, role: 'editor') => Promise<unknown>
  executeDurableAssetParse: (workspaceId: string, assetId: string, req: IncomingMessage) => Promise<unknown>
  assetForWorkspace: (workspaceId: string, assetId: string) => AssetMetadata
  confirmDurableAssetFacts: (input: { workspaceId: string; assetId: string; facts: Record<string, unknown>; reason: string; req: IncomingMessage }) => Promise<unknown>
  enforceMcpCommercialAccess: (req: IncomingMessage, workspaceId: string, method: string) => Promise<unknown>
  persistSnapshot: (workspaceId: string, entityType: 'asset', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  uploadAssetForMcp: (workspaceId: string, params: Record<string, unknown>, req?: IncomingMessage, batchIndex?: number, securityPreflighted?: boolean) => Promise<unknown>
  rejectMerchantVideoUpload: (name: string, mimeType: string) => void
  persistRejectedAssetUpload: (workspaceId: string, result: AssetUploadSecurityResult, batchIndex?: number) => Promise<string>
  signedAssetScanCallbackRequired: () => boolean
  requireWorkerAuthorization: (req: IncomingMessage) => Promise<unknown>
  promoteAssetAndPersist: (workspaceId: string, asset: AssetMetadata, scanEvidenceRef: string) => Promise<unknown>
  demoUnscannedAssetsEnabled: () => boolean
  imageContinuationGate: (asset: AssetMetadata, job: ImageGenerationJob) => ImageGenerationContinuationState
  workerAuthorizationSnapshot: (req: IncomingMessage, workspaceId: string, resourceId: string, capability: 'asset.continuation.execute', binding: Record<string, unknown>) => (WorkerAuthorizationSnapshot & { capability: 'asset.continuation.execute' }) | undefined
  requiresStrictAuth: () => boolean
  serializedWorkerAuthorizationSnapshot: (snapshot: WorkerAuthorizationSnapshot & { capability: 'asset.continuation.execute' }) => Record<string, unknown>
  persistSnapshotsAndEvent: (input: { workspaceId: string; snapshots: SnapshotInput[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => Promise<unknown>
  awaitingConfirmationState: (state: ImageGenerationContinuationState) => ImageGenerationContinuationState
  supportedPlatforms: readonly Platform[]
}

export const MCP_ASSET_METHODS = new Set([
  'asset.list', 'asset.parse', 'asset.facts.confirm', 'asset.preference.update',
  'asset.upload', 'asset.upload.batch', 'asset.scan', 'asset.generation.confirm', 'asset.rights.update',
])

export async function handleMcpAssetMethod(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, dependencies: Dependencies): Promise<unknown> {
  const { service, required, requestActor, requestId, accessibleAssetIds, assetDisplayProjection,
    conversationalAssetScanWaitingState, getStorageQuotaSnapshot, configuredStorageQuotaLimit,
    enforceAssetAccess, executeDurableAssetParse, assetForWorkspace, confirmDurableAssetFacts,
    enforceMcpCommercialAccess, persistSnapshot, persistEvent, uploadAssetForMcp,
    rejectMerchantVideoUpload, persistRejectedAssetUpload, signedAssetScanCallbackRequired,
    requireWorkerAuthorization, promoteAssetAndPersist, demoUnscannedAssetsEnabled,
    imageContinuationGate, workerAuthorizationSnapshot, requiresStrictAuth,
    serializedWorkerAuthorizationSnapshot, persistSnapshotsAndEvent, awaitingConfirmationState,
    supportedPlatforms: SUPPORTED_PLATFORMS } = dependencies
  if (method === 'asset.list') {
      const accessibleIds = await accessibleAssetIds(req, workspaceId)
      const allAssets = service.listAssets(workspaceId)
      const internalAssets = accessibleIds === undefined ? allAssets : allAssets.filter(asset => accessibleIds.has(asset.id))
      const hasAutomaticScanInProgress = internalAssets.some(asset => asset.scanStatus === 'quarantined')
      const nextAction = internalAssets
        .filter(asset => asset.scanStatus !== 'quarantined')
        .map(asset => assetDisplayProjection(asset).nextAction)
        .find(action => action !== null)
      const action_cards = hasAutomaticScanInProgress
        ? []
        : internalAssets.length === 0
        ? [
            { method: 'asset.upload', label: '上传商品图片', required_inputs: ['name', 'mime_type', 'file_path'], confirmation: 'interactive_confirmation' },
            { method: 'asset.upload', label: '上传品牌资料', required_inputs: ['name', 'mime_type', 'file_path'], confirmation: 'interactive_confirmation' },
          ]
        : nextAction
          ? [{ method: nextAction.method, label: nextAction.label, required_inputs: ['asset_id'], confirmation: 'interactive_confirmation' }]
          : []
      const readiness = internalAssets.reduce((summary, asset) => { summary[asset.readiness.status] += 1; return summary }, { draft: 0, ready: 0, blocked: 0 })
      const assets = internalAssets.map(asset => ({
        id: asset.id,
        name: asset.name,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        createdAt: asset.createdAt,
        source: asset.sourceProviderJobId ? 'generated' : 'merchant_upload',
        scanStatus: asset.scanStatus,
        parseStatus: asset.parseStatus,
        rightsStatus: asset.rightsStatus,
        rightsScope: asset.rightsScope ?? null,
        readiness: asset.readiness,
        display: assetDisplayProjection(asset),
        ...(asset.extractedFactsSource ? { extractedFactsSource: asset.extractedFactsSource } : {}),
        ...(asset.extractedFacts ? { extractedFacts: asset.extractedFacts } : {}),
        ...(asset.factsConfirmedBy ? { factsConfirmedBy: asset.factsConfirmedBy } : {}),
        ...(asset.preference ? { preference: asset.preference } : {}),
      }))
      const asset_actions = internalAssets.map(asset => {
        const base = { asset_id: asset.id, asset_name: asset.name, status: asset.readiness.status, reasons: asset.readiness.reasons }
        const display = assetDisplayProjection(asset)
        const awaitingAutomaticScan = asset.scanStatus === 'quarantined'
        const action = awaitingAutomaticScan ? null : display.nextAction ? { method: display.nextAction.method, label: display.nextAction.label, required_inputs: [ 'asset_id' ], confirmation: 'interactive_confirmation' } : null
        const scanAutomation = awaitingAutomaticScan ? conversationalAssetScanWaitingState() : undefined
        return { ...base, display, action, next_step: scanAutomation?.message ?? display.nextAction?.label ?? '素材已满足当前 readiness 条件', ...(scanAutomation ? { scan_automation: scanAutomation } : {}) }
      })
      const quotaSnapshot = (await getStorageQuotaSnapshot(workspaceId)) ?? { limitBytes: configuredStorageQuotaLimit(), usedBytes: 0, reservedBytes: 0 }
      const storageQuota = quotaSnapshot
        ? (() => {
            const usedBytes = Math.max(0, quotaSnapshot.usedBytes)
            const reservedBytes = Math.max(0, quotaSnapshot.reservedBytes)
            const limitBytes = Math.max(0, quotaSnapshot.limitBytes)
            const projectedBytes = usedBytes + reservedBytes
            const utilization = limitBytes > 0 ? projectedBytes / limitBytes : 1
            return {
              usedBytes,
              reservedBytes,
              limitBytes,
              availableBytes: Math.max(0, limitBytes - projectedBytes),
              status: projectedBytes > limitBytes ? 'over_limit' as const : utilization >= 0.8 ? 'near_limit' as const : 'available' as const,
            }
          })()
        : undefined
      return ({ assets, readiness: { ...readiness, total: assets.length }, ...(storageQuota ? { storage_quota: storageQuota } : {}), asset_actions, empty_state: assets.length ? null : { title: '还没有素材', message: '先上传商品图片或品牌资料；上传后系统会自动检查，再继续确认事实和使用权限。' }, action_cards })
    }
  if (method === 'asset.parse') {
      const assetId = required(params, 'asset_id')
      await enforceAssetAccess(req, workspaceId, assetId, 'editor')
      return (await executeDurableAssetParse(workspaceId, assetId, req))
    }
  if (method === 'asset.facts.confirm') {
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      await enforceAssetAccess(req, workspaceId, asset.id, 'editor')
      let facts: Record<string, unknown>
      try {
        const parsed = JSON.parse(required(params, 'facts_json'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error('empty')
        facts = parsed as Record<string, unknown>
      } catch {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'facts_json 必须是非空 JSON 对象', 400)
      }
      const reason = required(params, 'reason').trim()
      if (!reason) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '人工补录原因不能为空', 400)
      return (await confirmDurableAssetFacts({ workspaceId, assetId: asset.id, facts, reason, req }))
    }
  if (method === 'asset.preference.update') {
      const verdict = required(params, 'verdict')
      if (!['excellent', 'disliked', 'unrated'].includes(verdict)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'verdict 必须是 excellent、disliked 或 unrated', 400)
      let reasons: string[] | undefined
      if (typeof params.reasons_json === 'string') {
        try { const parsed = JSON.parse(params.reasons_json); if (!Array.isArray(parsed) || parsed.some(reason => typeof reason !== 'string')) throw new Error('reasons_json'); reasons = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'reasons_json 必须是字符串数组 JSON', 400) }
      }
      if (!reasons?.length) throw new DomainError('ASSET_PREFERENCE_REASON_REQUIRED', '素材偏好必须提供至少一个人工原因', 400)
      const assetId = required(params, 'asset_id')
      await enforceAssetAccess(req, workspaceId, assetId, 'editor')
      await enforceMcpCommercialAccess(req, workspaceId, method)
      const updated = service.updateAssetPreference({ workspaceId, assetId, verdict: verdict as 'excellent' | 'disliked' | 'unrated', ...(reasons ? { reasons } : {}), ...(typeof params.note === 'string' ? { note: params.note } : {}), actorId: requestActor(req), ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}) })
      await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, updated.id, 'asset.preference_updated', updated.revision, { asset_id: updated.id, verdict, reasons: updated.preference?.reasons ?? [], actor_id: updated.preference?.updatedBy ?? requestActor(req) })
      return (updated)
    }
  if (method === 'asset.upload') {
      rejectMerchantVideoUpload(required(params, 'name'), required(params, 'mime_type'))
      return (await uploadAssetForMcp(workspaceId, params, req))
    }
  if (method === 'asset.upload.batch') {
      const raw = required(params, 'assets_json')
      let entries: unknown
      try { entries = JSON.parse(raw) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'assets_json 必须是 JSON 数组', 400) }
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20 || entries.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new DomainError('ASSET_BATCH_LIMIT', '单批素材数量必须在 1 到 20 个之间', 413)
      const items = entries as JsonObject[]
      for (const item of items) rejectMerchantVideoUpload(typeof item.name === 'string' ? item.name : '', typeof item.mime_type === 'string' ? item.mime_type : '')
      const totalBytes = items.reduce((sum, item) => {
        const value = typeof item.content_base64 === 'string' ? item.content_base64 : ''
        return sum + Math.floor(value.replace(/=+$/u, '').length * 3 / 4)
      }, 0)
      if (totalBytes > 250 * 1024 * 1024) throw new DomainError('ASSET_BATCH_LIMIT', '单批素材总大小不能超过 250MB', 413)
      const securityInputs = items.map(item => {
        const encoded = typeof item.content_base64 === 'string' ? item.content_base64 : undefined
        const validBase64 = encoded !== undefined && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
        return {
          fileName: typeof item.name === 'string' ? item.name : undefined as never,
          declaredMime: typeof item.mime_type === 'string' ? item.mime_type : undefined as never,
          bytes: validBase64 && encoded.length > 0 ? new Uint8Array(Buffer.from(encoded, 'base64')) : undefined as never,
        }
      })
      const securityResults = classifyAssetUploadBatch(securityInputs, { workspaceId, actorId: requestActor(req), requestId: requestId(req) })
      const rejected = securityResults.map((securityResult, index) => ({ securityResult, index })).filter(item => item.securityResult.decision === 'reject')
      const auditEventIds = await Promise.all(rejected.map(item => persistRejectedAssetUpload(workspaceId, item.securityResult, item.index)))
      const rejectedByIndex = new Map(rejected.map((item, rejectedIndex) => [item.index, { result: item.securityResult, auditEventId: auditEventIds[rejectedIndex]! }]))
      const batchItems: Array<Record<string, unknown>> = []
      const assets = []
      for (const [index, item] of items.entries()) {
        const securityRejection = rejectedByIndex.get(index)
        if (securityRejection) {
          batchItems.push({ index, status: 'failed', error: { code: securityRejection.result.reasonCode ?? 'ASSET_UPLOAD_REJECTED', message: '素材未通过上传安全检查，已拒绝进入隔离区' }, reason_codes: securityRejection.result.reasonCodes, security_audit_event_id: securityRejection.auditEventId })
          continue
        }
        try {
          const asset = await uploadAssetForMcp(workspaceId, item, req, index, true)
          assets.push(asset)
          batchItems.push({ index, status: 'succeeded', asset })
        } catch (error) {
          const failure = error instanceof DomainError ? error : new DomainError(ERROR_CODES.INTERNAL_ERROR, '素材上传失败', 500)
          batchItems.push({ index, status: 'failed', error: { code: failure.code, message: failure.message }, reason_codes: [], security_audit_event_id: null })
        }
      }
      const failed = batchItems.length - assets.length
      return ({ assets, items: batchItems, count: batchItems.length, succeeded: assets.length, failed, counts: { total: batchItems.length, succeeded: assets.length, failed }, partial: failed > 0 && assets.length > 0, totalBytes })
    }
  if (method === 'asset.scan') {
      if (signedAssetScanCallbackRequired()) throw new DomainError('MCP_ASSET_SCAN_DISABLED', 'controlled-environment asset scans are accepted only through the signed platform scanner callback', 410)
      await requireWorkerAuthorization(req)
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      if (asset.scanStatus !== 'quarantined' || !asset.storageKey.startsWith('quarantine/')) throw new DomainError('ASSET_SCAN_STATE_INVALID', '素材当前不在待扫描隔离状态', 409)
      return (await promoteAssetAndPersist(workspaceId, asset, required(params, 'scan_evidence_ref')))
    }
  if (method === 'asset.generation.confirm') {
      const jobId = required(params, 'job_id')
      const current = service.getImageGenerationJob(workspaceId, jobId)
      if (!current.continuation) throw new DomainError('IMAGE_CONTINUATION_NOT_FOUND', '图片任务不是素材续跑任务', 404)
      if (current.continuation.state !== 'awaiting_confirmation') throw new DomainError('IMAGE_CONTINUATION_CONFIRMATION_REQUIRED', '图片续跑当前不在等待商家确认状态', 409, { continuation_state: current.continuation.state })
      const asset = assetForWorkspace(workspaceId, current.continuation.sourceAssetId)
      if (!isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled())) throw new DomainError('IMAGE_CONTINUATION_NOT_READY', '素材尚不可用', 409)
      if (imageContinuationGate(asset, current) !== 'ready') throw new DomainError('IMAGE_CONTINUATION_RIGHTS_REQUIRED', '素材权益或适用范围尚未满足图片生成条件', 409)
      const authorizationSnapshot = workerAuthorizationSnapshot(req, workspaceId, asset.id, 'asset.continuation.execute', { method: 'asset.generation.confirm', job_id: current.id, asset_id: asset.id, job_revision: current.revision })
      if (requiresStrictAuth() && !authorizationSnapshot) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '图片续跑缺少持久身份授权快照，已拒绝入队', 503)
      const confirmed = structuredClone(current)
      confirmed.continuation!.state = 'ready'
      confirmed.continuation!.updatedAt = new Date().toISOString()
      confirmed.updatedAt = confirmed.continuation!.updatedAt
      confirmed.revision += 1
      await persistSnapshotsAndEvent({
        workspaceId,
        snapshots: [{ entityType: 'image_generation_job', entityId: confirmed.id, entityVersion: confirmed.revision, payload: confirmed as unknown as Record<string, unknown> }],
        aggregateId: asset.id,
        eventType: 'asset.generation_continuations.ready',
        sequence: confirmed.revision,
        eventPayload: { job_id: confirmed.id, asset_id: asset.id, continuation_job_ids: [confirmed.id], confirmed_by: requestActor(req), ...(authorizationSnapshot ? { authorization_snapshot: serializedWorkerAuthorizationSnapshot(authorizationSnapshot) } : {}) },
      })
      service.imageGenerationJobs.set(confirmed.id, confirmed)
      return ({ job_id: confirmed.id, continuation_state: confirmed.continuation!.state, confirmed: true, user_action_required: false })
    }
  if (method === 'asset.rights.update') {
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      await enforceAssetAccess(req, workspaceId, asset.id, 'editor')
      const previousAsset = structuredClone(asset)
      const rightsStatus = required(params, 'rights_status')
      if (!['approved', 'rejected', 'pending'].includes(rightsStatus)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'rights_status 无效', 400)
      let applicablePlatforms: Platform[] | undefined
      if (typeof params.applicable_platforms_json === 'string') {
        try {
          const parsed = JSON.parse(params.applicable_platforms_json)
          if (!Array.isArray(parsed) || parsed.some(value => !SUPPORTED_PLATFORMS.includes(String(value) as Platform))) throw new Error('applicable_platforms_json')
          applicablePlatforms = parsed as Platform[]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'applicable_platforms_json 必须是首发平台字符串数组 JSON', 400) }
      }
      const parseAssetList = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error(key); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串数组 JSON`, 400) }
      }
      const applicableRegions = parseAssetList('applicable_regions_json')
      const usageScopes = parseAssetList('usage_scopes_json')
      const rightsScope = typeof params.rights_scope === 'string' ? params.rights_scope as import('../../../packages/application/src/service.js').AssetMetadata['rightsScope'] : undefined
      if (rightsScope && !['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'].includes(rightsScope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'rights_scope 无效', 400)
      const updated = service.updateAssetRights({ workspaceId, assetId: asset.id, rightsStatus: rightsStatus as 'approved' | 'rejected' | 'pending', ...(rightsScope ? { rightsScope } : {}), ...(applicablePlatforms ? { applicablePlatforms } : {}), ...(applicableRegions ? { applicableRegions } : {}), ...(usageScopes ? { usageScopes } : {}), ...(typeof params.valid_from === 'string' ? { validFrom: params.valid_from } : {}), ...(typeof params.valid_to === 'string' ? { validTo: params.valid_to } : {}), ...(params.ai_modification_allowed === 'true' || params.ai_modification_allowed === 'false' ? { aiModificationAllowed: params.ai_modification_allowed === 'true' } : {}) })
      const previousJobs = [...service.imageGenerationJobs.values()]
        .filter(job => job.workspaceId === workspaceId && job.continuation?.sourceAssetId === updated.id)
        .map(job => ({ id: job.id, value: structuredClone(job) }))
      const continuationAwaitingConfirmationIds: string[] = []
      const touchedJobs: import('../../../packages/application/src/service.js').ImageGenerationJob[] = []
      for (const { id } of previousJobs) {
        const job = service.imageGenerationJobs.get(id)!
        if (!job.continuation || ['completed', 'executing', 'ready', 'failed'].includes(job.continuation.state)) continue
        const nextState = awaitingConfirmationState(imageContinuationGate(updated, job))
        if (job.continuation.state !== nextState) {
          job.continuation.state = nextState
          job.continuation.updatedAt = new Date().toISOString()
          job.updatedAt = job.continuation.updatedAt
          job.revision += 1
          touchedJobs.push(job)
          if (nextState === 'awaiting_confirmation') continuationAwaitingConfirmationIds.push(job.id)
        }
      }
      try {
        await persistSnapshotsAndEvent({
          workspaceId,
          snapshots: [
            { entityType: 'asset', entityId: updated.id, entityVersion: updated.revision, payload: updated as unknown as Record<string, unknown> },
            ...touchedJobs.map(job => ({ entityType: 'image_generation_job' as const, entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown> })),
          ],
          aggregateId: updated.id,
          eventType: continuationAwaitingConfirmationIds.length ? 'asset.generation_continuations.awaiting_confirmation' : 'asset.rights_updated',
          sequence: updated.revision,
          eventPayload: { asset_id: updated.id, rights_status: updated.rightsStatus, continuation_job_ids: continuationAwaitingConfirmationIds },
        })
      } catch (error) {
        service.assets.set(previousAsset.id, previousAsset)
        for (const previous of previousJobs) service.imageGenerationJobs.set(previous.id, previous.value)
        throw error
      }
      return (updated)
    }
  throw new Error(`Unsupported asset MCP method: ${method}`)
}
