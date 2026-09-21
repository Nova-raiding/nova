import type { AssetMetadata } from './api.js'

export type KnowledgeApprovalStatus = 'pending' | 'approved'
export type KnowledgeRightsStatus = 'unknown' | 'cleared'
export type KnowledgeIndexState = 'queued' | 'ready'

export type KnowledgeBindingStatus = {
  approvalStatus: KnowledgeApprovalStatus
  rightsStatus: KnowledgeRightsStatus
  indexState: KnowledgeIndexState
  ready: boolean
  reasons: string[]
}

export type KnowledgeBindingSummary = KnowledgeBindingStatus & {
  boundAssetCount: number
  missingAssetCount: number
}

export type KnowledgeAssetCounts = {
  total: number
  ready: number
  pending: number
}

/**
 * Project the existing merchant-facing asset lifecycle into the knowledge
 * binding vocabulary. No client-side state is treated as authoritative:
 * readiness only becomes true when the server's asset projection is ready.
 */
export function resolveKnowledgeBindingStatus(
  asset: AssetMetadata | undefined,
): KnowledgeBindingStatus {
  if (!asset) {
    return {
      approvalStatus: 'pending',
      rightsStatus: 'unknown',
      indexState: 'queued',
      ready: false,
      reasons: ['绑定的素材记录未返回'],
    }
  }

  const approvalStatus: KnowledgeApprovalStatus =
    asset.factsConfirmedBy && asset.factsConfirmedAt ? 'approved' : 'pending'
  const rightsStatus: KnowledgeRightsStatus =
    asset.rightsStatus === 'approved' ? 'cleared' : 'unknown'
  const indexState: KnowledgeIndexState =
    asset.readiness?.status === 'ready' ? 'ready' : 'queued'
  const reasons: string[] = []

  if (approvalStatus !== 'approved') reasons.push('先确认素材事实')
  if (rightsStatus !== 'cleared') reasons.push('先确认商用权益')
  if (asset.scanStatus !== 'clean') reasons.push('等待安全扫描完成')
  if (asset.parseStatus !== 'succeeded') reasons.push('等待内容读取完成')
  if (indexState !== 'ready') {
    reasons.push(...(asset.readiness?.reasons?.slice(0, 1) ?? ['等待知识索引完成']))
  }

  return {
    approvalStatus,
    rightsStatus,
    indexState,
    ready:
      approvalStatus === 'approved' &&
      rightsStatus === 'cleared' &&
      indexState === 'ready' &&
      asset.scanStatus === 'clean' &&
      asset.parseStatus === 'succeeded',
    reasons: [...new Set(reasons)],
  }
}

/** Keep every knowledge-library count on the same fail-closed readiness gate. */
export function countKnowledgeAssets(assets: AssetMetadata[]): KnowledgeAssetCounts {
  const ready = assets.filter((asset) => resolveKnowledgeBindingStatus(asset).ready).length
  return {
    total: assets.length,
    ready,
    pending: assets.length - ready,
  }
}

export function resolveKnowledgeBindingSummary(
  assets: AssetMetadata[],
  boundAssetIds: string[],
): KnowledgeBindingSummary {
  const ids = [...new Set(boundAssetIds)]
  if (!ids.length) {
    return {
      approvalStatus: 'pending',
      rightsStatus: 'unknown',
      indexState: 'queued',
      ready: false,
      reasons: ['尚未绑定知识素材'],
      boundAssetCount: 0,
      missingAssetCount: 0,
    }
  }

  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const statuses = ids.map((id) => resolveKnowledgeBindingStatus(assetById.get(id)))
  const reasons = [...new Set(statuses.flatMap((status) => status.reasons))]

  return {
    approvalStatus: statuses.every((status) => status.approvalStatus === 'approved')
      ? 'approved'
      : 'pending',
    rightsStatus: statuses.every((status) => status.rightsStatus === 'cleared')
      ? 'cleared'
      : 'unknown',
    indexState: statuses.every((status) => status.indexState === 'ready')
      ? 'ready'
      : 'queued',
    ready: statuses.every((status) => status.ready),
    reasons,
    boundAssetCount: ids.length,
    missingAssetCount: statuses.filter((status) => status.reasons.includes('绑定的素材记录未返回')).length,
  }
}

function statusLabel(status: KnowledgeBindingStatus) {
  return {
    approval: status.approvalStatus === 'approved' ? 'approved' : 'pending',
    rights: status.rightsStatus === 'cleared' ? 'cleared' : 'unknown',
    index: status.indexState === 'ready' ? 'ready' : 'queued',
  }
}

export function KnowledgeBindingStatus({
  asset,
  summary,
  onAction,
  actionLabel = '处理知识绑定',
  compact = false,
}: {
  asset?: AssetMetadata
  summary?: KnowledgeBindingStatus
  onAction?: () => void
  actionLabel?: string
  compact?: boolean
}) {
  const status = summary ?? resolveKnowledgeBindingStatus(asset)
  const labels = statusLabel(status)
  const actionNeeded = !status.ready && Boolean(onAction)

  return (
    <div
      className={`knowledge-binding-status ${compact ? 'compact' : ''} ${status.ready ? 'ready' : 'blocked'}`}
      data-testid={asset ? `knowledge-binding-status-${asset.id}` : 'knowledge-binding-status'}
      aria-label={status.ready ? '知识绑定已 ready' : `知识绑定未 ready：${status.reasons.join('、')}`}
    >
      <div className="knowledge-binding-chips">
        <span className={`knowledge-state-chip ${status.approvalStatus}`}>
          <b>approval</b> {labels.approval}
        </span>
        <span className={`knowledge-state-chip ${status.rightsStatus}`}>
          <b>rights</b> {labels.rights}
        </span>
        <span className={`knowledge-state-chip ${status.indexState}`}>
          <b>index</b> {labels.index}
        </span>
      </div>
      {!compact && !status.ready && (
        <span className="knowledge-binding-reason">
          {status.reasons.join(' · ')}
        </span>
      )}
      {actionNeeded && (
        <button
          type="button"
          className="text-button knowledge-binding-action"
          onClick={onAction}
          aria-label={`${actionLabel}${asset ? `：${asset.name}` : ''}`}
        >
          {actionLabel}
        </button>
      )}
      {status.ready && <span className="knowledge-binding-ready">可用于生成</span>}
    </div>
  )
}
