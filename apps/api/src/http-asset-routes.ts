import type { IncomingMessage, ServerResponse } from 'node:http'
import type { URL } from 'node:url'
import type { Platform } from '../../../packages/application/src/service.js'
import type { SignedAssetScanReceipt } from '../../../packages/security/src/asset-scan-receipt.js'
import type { assetHttpRuntime } from './server.js'

type AssetHttpRuntime = ReturnType<typeof assetHttpRuntime>

export async function routeAssetHttp(req: IncomingMessage, res: ServerResponse, path: string, url: URL, runtime: AssetHttpRuntime): Promise<void> {
  const {
    createHash, randomBytes, isTrustedCleanAsset, isUsableAssetWithoutScan, DomainError,
    ObjectStorageError, ERROR_CODES, demoUnscannedAssetsEnabled, SUPPORTED_PLATFORMS,
    service, persistence, configuredAssetLimit, configuredStorageQuotaLimit,
    getStoredObjectWithRetry, compensateStoredAsset, putQuarantineObject,
    executeDurableAssetParse, confirmDurableAssetFacts, enforceHttpCommercialAccess,
    persistEvent, persistSnapshot, persistAssetSnapshotAndEvent, persistAssetReference,
    header, send, sendAssetDownload, body, binaryBody, isProduction,
    signedAssetScanCallbackRequired, requestActor, resolveWorkspace, required,
    isObject, assetForWorkspace, assetDisplayProjection, promoteAssetAndPersist,
    applySignedAssetScanResult, automaticallyScanLocalFixture, requireAssetUploadSecurity,
    rejectMerchantVideoUpload, headerRequired, assetScannerWorkspace, accessibleAssetIds,
    enforceAssetAccess, httpOperationPolicyOperation,
  } = runtime
  if (req.method === 'GET' && path === '/v1/assets') {
    const workspaceId = resolveWorkspace(req)
    const accessibleIds = await accessibleAssetIds(req, workspaceId)
    const quotaSnapshot = (await persistence.storageQuota?.getSnapshot(workspaceId)) ?? { limitBytes: configuredStorageQuotaLimit(), usedBytes: 0, reservedBytes: 0 }
    const storageQuota = quotaSnapshot
      ? (() => {
          const usedBytes = Math.max(0, quotaSnapshot.usedBytes)
          const reservedBytes = Math.max(0, quotaSnapshot.reservedBytes)
          const limitBytes = Math.max(0, quotaSnapshot.limitBytes)
          const projectedBytes = usedBytes + reservedBytes
          const utilization = limitBytes > 0 ? projectedBytes / limitBytes : 1
          return { usedBytes, reservedBytes, limitBytes, availableBytes: Math.max(0, limitBytes - projectedBytes), status: projectedBytes > limitBytes ? 'over_limit' as const : utilization >= 0.8 ? 'near_limit' as const : 'available' as const }
        })()
      : undefined
    const rawLimit = url.searchParams.get('limit')
    const rawOffset = url.searchParams.get('offset')
    if (rawLimit !== null || rawOffset !== null) {
      const limit = rawLimit === null ? undefined : Number(rawLimit)
      const offset = rawOffset === null ? undefined : Number(rawOffset)
      if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '素材分页参数无效：limit 必须为 1-100，offset 必须为非负整数', 400)
      const all = service.listAssets(workspaceId).filter(asset => accessibleIds === undefined || accessibleIds.has(asset.id))
      return send(res, 200, workspaceId, { items: all.slice(offset ?? 0, (offset ?? 0) + (limit ?? 20)).map(asset => ({ ...asset, display: assetDisplayProjection(asset) })), total: all.length, limit: limit ?? 20, offset: offset ?? 0, ...(storageQuota ? { storage_quota: storageQuota } : {}) }, null, req)
    }
    const assets = service.listAssets(workspaceId)
    const visible = accessibleIds === undefined ? assets : assets.filter(asset => accessibleIds.has(asset.id))
    return send(res, 200, workspaceId, visible.map(asset => ({ ...asset, display: assetDisplayProjection(asset) })), null, req)
  }
  const assetPreferenceMatch = path.match(/^\/v1\/assets\/([^/]+)\/preference$/)
  if (req.method === 'PUT' && assetPreferenceMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const verdict = required(input, 'verdict')
    if (!['excellent', 'disliked', 'unrated'].includes(verdict)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'verdict 必须是 excellent、disliked 或 unrated', 400)
    const reasons = input.reasons === undefined ? undefined : Array.isArray(input.reasons) && input.reasons.every(reason => typeof reason === 'string') ? input.reasons as string[] : null
    if (reasons === null) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'reasons 必须是字符串数组', 400)
    if (!reasons?.length) throw new DomainError('ASSET_PREFERENCE_REASON_REQUIRED', '素材偏好必须提供至少一个人工原因', 400)
    const assetId = decodeURIComponent(assetPreferenceMatch[1]!)
    await enforceAssetAccess(req, workspaceId, assetId, 'editor')
    if (httpOperationPolicyOperation) await enforceHttpCommercialAccess(req, workspaceId, httpOperationPolicyOperation)
    const updated = service.updateAssetPreference({ workspaceId, assetId, verdict: verdict as 'excellent' | 'disliked' | 'unrated', ...(reasons ? { reasons } : {}), ...(typeof input.note === 'string' ? { note: input.note } : {}), actorId: requestActor(req), ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) })
    await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, updated.id, 'asset.preference_updated', updated.revision, { asset_id: updated.id, verdict, reasons: updated.preference?.reasons ?? [], actor_id: updated.preference?.updatedBy ?? requestActor(req) })
    return send(res, 200, workspaceId, updated, null, req)
  }
  const assetDownloadMatch = path.match(/^\/v1\/assets\/([^/]+)\/download$/)
  if (req.method === 'GET' && assetDownloadMatch) {
    const workspaceId = resolveWorkspace(req)
    const asset = assetForWorkspace(workspaceId, assetDownloadMatch[1]!)
    await enforceAssetAccess(req, workspaceId, asset.id)
    if (!isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled())) throw new DomainError('QUARANTINE_ACCESS_DENIED', '素材尚不可用，暂不可下载', 403)
    let stored: Awaited<ReturnType<typeof getStoredObjectWithRetry>>
    try {
      stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey, { includeQuarantine: asset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() })
    } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') {
        throw new DomainError('ASSET_BINARY_UNAVAILABLE', '素材文件不可用，请重新上传', 410)
      }
      throw error
    }
    const storedDigest = createHash('sha256').update(stored.body).digest('hex')
    if (stored.metadata.sha256 !== asset.sha256 || stored.metadata.sizeBytes !== asset.sizeBytes || stored.metadata.contentType.toLowerCase() !== asset.mimeType.toLowerCase() || storedDigest !== asset.sha256) {
      throw new DomainError('ASSET_BINARY_INTEGRITY_FAILED', '素材对象与已扫描快照不一致，已阻止下载', 409, { asset_id: asset.id })
    }
    return sendAssetDownload(res, asset, stored, req)
  }
  const assetScanContentMatch = path.match(/^\/v1\/internal\/assets\/([^/]+)\/scan-content$/)
  if (req.method === 'GET' && assetScanContentMatch) {
    // Scanner routes have a separate machine identity and signed workspace
    // binding. They must not fall back through the merchant membership gate.
    const workspaceId = assetScannerWorkspace(req)
    const asset = assetForWorkspace(workspaceId, decodeURIComponent(assetScanContentMatch[1]!))
    if (asset.scanStatus !== 'quarantined' || !asset.storageKey.startsWith(`quarantine/${workspaceId}/`)) throw new DomainError('ASSET_SCAN_STATE_INVALID', 'asset is not awaiting an automatic platform scan', 409)
    const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey, { includeQuarantine: true })
    if (stored.metadata.sha256 !== asset.sha256 || stored.metadata.sizeBytes !== asset.sizeBytes || stored.metadata.contentType.toLowerCase() !== asset.mimeType.toLowerCase()) throw new DomainError('ASSET_SCAN_SOURCE_INTEGRITY_FAILED', 'quarantined scan source no longer matches asset metadata', 409)
    res.statusCode = 200
    res.setHeader('content-type', asset.mimeType)
    res.setHeader('content-length', String(stored.body.byteLength))
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-asset-sha256', asset.sha256)
    res.setHeader('x-asset-source-revision', String(asset.sourceRevision ?? 1))
    res.setHeader('x-asset-object-key', encodeURIComponent(asset.storageKey))
    res.end(Buffer.from(stored.body))
    return
  }
  const assetScanResultMatch = path.match(/^\/v1\/internal\/assets\/([^/]+)\/scan-result$/)
  if (req.method === 'POST' && assetScanResultMatch) {
    const workspaceId = assetScannerWorkspace(req)
    const input = await body(req)
    if (!input.receipt || typeof input.signature !== 'string') throw new DomainError('ASSET_SCAN_RECEIPT_INVALID', 'signed asset scan receipt is required', 400)
    const asset = assetForWorkspace(workspaceId, decodeURIComponent(assetScanResultMatch[1]!))
    const result = await applySignedAssetScanResult(workspaceId, asset, { receipt: input.receipt as SignedAssetScanReceipt['receipt'], signature: input.signature })
    return send(res, 200, workspaceId, { asset_id: result.id, scan_status: result.scanStatus, receipt_id: result.scanReceiptId, receipt_digest: result.scanReceiptDigest }, null, req)
  }
  const assetScanMatch = path.match(/^\/v1\/assets\/([^/]+)\/scan$/)
  if (req.method === 'POST' && assetScanMatch) {
    if (signedAssetScanCallbackRequired()) throw new DomainError('LEGACY_ASSET_SCAN_DISABLED', 'controlled-environment asset scans are completed only by the platform scanner', 410)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const asset = assetForWorkspace(workspaceId, assetScanMatch[1]!)
    await enforceAssetAccess(req, workspaceId, asset.id, 'editor')
    if (asset.scanStatus !== 'quarantined' || !asset.storageKey.startsWith('quarantine/')) {
      throw new DomainError('ASSET_SCAN_STATE_INVALID', '素材当前不在待扫描隔离状态', 409)
    }
    const evidence = required(input, 'scan_evidence_ref')
    return send(res, 200, workspaceId, await promoteAssetAndPersist(workspaceId, asset, evidence), null, req)
  }
  const assetParseMatch = path.match(/^\/v1\/assets\/([^/]+)\/parse$/)
  if (req.method === 'POST' && assetParseMatch) {
    const workspaceId = resolveWorkspace(req)
    await enforceAssetAccess(req, workspaceId, decodeURIComponent(assetParseMatch[1]!), 'editor')
    return send(res, 200, workspaceId, await executeDurableAssetParse(workspaceId, assetParseMatch[1]!, req), null, req)
  }
  if (req.method === 'POST' && path === '/v1/assets/upload') {
    const workspaceId = resolveWorkspace(req)
    const limit = configuredAssetLimit()
    const contentType = headerRequired(req, 'content-type').trim().toLowerCase()
    const encodedName = headerRequired(req, 'x-asset-name')
    let name = encodedName
    try { name = decodeURIComponent(encodedName) } catch { /* Preserve legacy raw header names. */ }
    rejectMerchantVideoUpload(name, contentType)
    const expectedSha256 = header(req, 'x-asset-sha256')?.trim()
    const bytes = await binaryBody(req, limit)
    await requireAssetUploadSecurity(workspaceId, name, contentType, bytes, req)
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 && !/^[a-f0-9]{64}$/iu.test(expectedSha256)) throw new DomainError('ASSET_DIGEST_INVALID', 'x-asset-sha256 必须是 SHA-256 摘要', 400)
    if (expectedSha256 && expectedSha256.toLowerCase() !== actualSha256) throw new DomainError('ASSET_DIGEST_MISMATCH', 'x-asset-sha256 与上传内容不一致', 400)
    if (demoUnscannedAssetsEnabled()) {
      const pendingKey = `quarantine/${workspaceId}/pending_${randomBytes(12).toString('hex')}/upload.bin`
      const asset = service.registerAsset({ workspaceId, name, mimeType: contentType, sizeBytes: bytes.byteLength, sha256: actualSha256, storageKey: pendingKey, scanMode: 'unscanned', uploadedByActorId: requestActor(req) })
      if (asset.deduplication.mode === 'deduplicated') {
        if (!isUsableAssetWithoutScan(asset, true)) throw new DomainError('ASSET_EXISTING_SCAN_STATE', '相同文件已存在但尚不可用，请先处理原素材', 409)
        await persistAssetReference(workspaceId, asset)
        return send(res, 200, workspaceId, asset, null, req)
      }
      let storedKey: string | undefined
      try {
        const stored = await putQuarantineObject({ workspaceId, assetId: asset.id, fileName: name, contentType, body: bytes, expectedSha256: actualSha256, expectedSizeBytes: bytes.byteLength })
        storedKey = stored.key
        asset.storageKey = stored.key
        asset.sha256 = stored.sha256
        asset.sizeBytes = stored.sizeBytes
        await persistAssetSnapshotAndEvent(workspaceId, asset, 'asset.uploaded_unscanned', { asset_id: asset.id, storage_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256, scan_status: 'unscanned' }, asset as unknown as Record<string, unknown>)
        return send(res, 201, workspaceId, asset, null, req)
      } catch (error) {
        service.assets.delete(asset.id)
        if (storedKey) await compensateStoredAsset(workspaceId, asset.id, storedKey, 'unscanned asset persistence failed')
        throw error
      }
    }
    const pendingKey = `quarantine/${workspaceId}/pending_${randomBytes(12).toString('hex')}/upload.bin`
    const provisional = service.registerAsset({ workspaceId, name, mimeType: contentType, sizeBytes: bytes.byteLength, sha256: actualSha256, storageKey: pendingKey, uploadedByActorId: requestActor(req) })
    if (provisional.deduplication.mode === 'deduplicated') {
      await persistAssetReference(workspaceId, provisional)
      if (isTrustedCleanAsset(provisional)) return send(res, 200, workspaceId, provisional, null, req)
      // Re-upload is the merchant-facing recovery action for both blocked
      // assets and quarantined assets whose earlier scan event terminated.
      // Always mint new scan work for a non-trusted duplicate.
      {
        const previousAsset = structuredClone(provisional)
        const stored = await putQuarantineObject({ workspaceId, assetId: provisional.id, fileName: name, contentType, body: bytes, ...(expectedSha256 ? { expectedSha256 } : {}), expectedSizeBytes: bytes.byteLength })
        try {
          const rescanning = service.prepareAssetRescan({ workspaceId, assetId: provisional.id, storageKey: stored.key, sizeBytes: stored.sizeBytes, sha256: stored.sha256, mimeType: contentType })
          await persistAssetSnapshotAndEvent(workspaceId, rescanning, 'asset.uploaded', { asset_id: rescanning.id, storage_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256, rescan: true, source_revision: rescanning.sourceRevision }, rescanning as unknown as Record<string, unknown>)
          const automated = await automaticallyScanLocalFixture(workspaceId, rescanning)
          return send(res, 200, workspaceId, { ...automated.asset, scanAutomation: automated.scanAutomation }, null, req)
        } catch (error) {
          service.assets.set(previousAsset.id, previousAsset)
          await compensateStoredAsset(workspaceId, provisional.id, stored.key, 'duplicate asset rescan persistence failed')
          throw error
        }
      }
    }
    let storedKey: string | undefined
    try {
      const stored = await putQuarantineObject({ workspaceId, assetId: provisional.id, fileName: name, contentType, body: bytes, ...(expectedSha256 ? { expectedSha256 } : {}), expectedSizeBytes: bytes.byteLength })
      storedKey = stored.key
      provisional.storageKey = stored.key
      provisional.sha256 = stored.sha256
      provisional.sizeBytes = stored.sizeBytes
      await persistAssetSnapshotAndEvent(workspaceId, provisional, 'asset.uploaded', { asset_id: provisional.id, storage_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256 }, provisional as unknown as Record<string, unknown>)
      const automated = await automaticallyScanLocalFixture(workspaceId, provisional)
      return send(res, 201, workspaceId, { ...automated.asset, scanAutomation: automated.scanAutomation }, null, req)
    } catch (error) {
      service.assets.delete(provisional.id)
      if (storedKey) await compensateStoredAsset(workspaceId, provisional.id, storedKey, 'asset snapshot or event persistence failed')
      throw error
    }
  }
  const assetRightsMatch = path.match(/^\/v1\/assets\/([^/]+)\/rights$/)
  if (req.method === 'PUT' && assetRightsMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const asset = assetForWorkspace(workspaceId, decodeURIComponent(assetRightsMatch[1]!))
    await enforceAssetAccess(req, workspaceId, asset.id, 'editor')
    const rightsStatus = required(input, 'rights_status')
    if (!['approved', 'rejected', 'pending'].includes(rightsStatus)) throw new DomainError('ASSET_RIGHTS_STATUS_INVALID', 'rights_status 无效', 400)
    const rightsScope = typeof input.rights_scope === 'string' ? input.rights_scope : undefined
    const applicablePlatforms = Array.isArray(input.applicable_platforms) && input.applicable_platforms.every(value => SUPPORTED_PLATFORMS.includes(String(value) as Platform)) ? input.applicable_platforms as Platform[] : input.applicable_platforms === undefined ? undefined : (() => { throw new DomainError('ASSET_PLATFORM_SCOPE_INVALID', 'applicable_platforms 必须是支持平台数组', 400) })()
    const stringArray = (key: string) => input[key] === undefined ? undefined : Array.isArray(input[key]) && input[key].every(value => typeof value === 'string') ? input[key] as string[] : (() => { throw new DomainError('ASSET_RIGHTS_INPUT_INVALID', `${key} 必须是字符串数组`, 400) })()
    const updated = service.updateAssetRights({ workspaceId, assetId: asset.id, rightsStatus: rightsStatus as 'approved' | 'rejected' | 'pending', ...(rightsScope ? { rightsScope: rightsScope as import('../../../packages/application/src/service.js').AssetMetadata['rightsScope'] } : {}), ...(applicablePlatforms ? { applicablePlatforms } : {}), ...((stringArray('applicable_regions')) ? { applicableRegions: stringArray('applicable_regions') } : {}), ...((stringArray('usage_scopes')) ? { usageScopes: stringArray('usage_scopes') } : {}), ...(typeof input.ai_modification_allowed === 'boolean' ? { aiModificationAllowed: input.ai_modification_allowed } : {}) })
    await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, updated.id, 'asset.rights_updated', updated.revision, { asset_id: updated.id, rights_status: updated.rightsStatus })
    return send(res, 200, workspaceId, updated, null, req)
  }
  const assetFactsMatch = path.match(/^\/v1\/assets\/([^/]+)\/facts$/)
  if (req.method === 'POST' && assetFactsMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const assetId = decodeURIComponent(assetFactsMatch[1]!)
    await enforceAssetAccess(req, workspaceId, assetId, 'editor')
    if (!isObject(input.facts) || Object.keys(input.facts).length === 0) throw new DomainError('ASSET_FACTS_EMPTY', 'facts 必须是非空对象', 400)
    const reason = required(input, 'reason').trim()
    if (!reason) throw new DomainError('ASSET_FACTS_REASON_REQUIRED', '人工确认原因不能为空', 400)
    const confirmed = await confirmDurableAssetFacts({ workspaceId, assetId, facts: input.facts, reason, req })
    return send(res, 200, workspaceId, confirmed, null, req)
  }
  if (req.method === 'POST' && path === '/v1/assets') {
    if (isProduction()) throw new DomainError('ASSET_BINARY_UPLOAD_REQUIRED', '生产环境必须通过二进制上传与扫描流程登记素材', 409)
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const asset = service.registerAsset({ workspaceId, name: required(input, 'name'), mimeType: required(input, 'mime_type'), sizeBytes: typeof input.size_bytes === 'number' ? input.size_bytes : -1, sha256: required(input, 'sha256'), storageKey: required(input, 'storage_key'), rightsStatus: input.rights_status === 'approved' || input.rights_status === 'rejected' ? input.rights_status : 'pending', uploadedByActorId: requestActor(req) })
    await persistAssetSnapshotAndEvent(workspaceId, asset, 'asset.registered', { asset_id: asset.id, storage_key: asset.storageKey, size_bytes: asset.sizeBytes, sha256: asset.sha256, fixture: true }, asset as unknown as Record<string, unknown>)
    return send(res, 201, workspaceId, asset, null, req)
  }
}
