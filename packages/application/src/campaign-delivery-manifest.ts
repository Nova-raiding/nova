import { createHash } from 'node:crypto'

export const CAMPAIGN_DELIVERY_PLATFORMS = ['taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export type CampaignDeliveryPlatform = typeof CAMPAIGN_DELIVERY_PLATFORMS[number]

export interface CampaignVersionVector {
  campaignId: string
  brandId: string
  productId: string
  listingId: string
  skuIds: string[]
  platform: CampaignDeliveryPlatform
  accountId: string
  contentVersionId: string
  visualVersionIds: string[]
  specificationId: string
  activityPolicyId?: string
  ruleSnapshotId: string
}

export interface CampaignReviewApproval {
  id: string
  platform: CampaignDeliveryPlatform
  accountId: string
  productId: string
  listingId: string
  contentVersionId: string
  visualVersionIds: string[]
  ruleSnapshotId: string
  approvedBy: string
  approvedAt: string
}

export interface CampaignPublishConfirmation {
  id: string
  platform: CampaignDeliveryPlatform
  accountId: string
  productId: string
  listingId: string
  versionVectorHash: string
  remoteSnapshotHash: string
  confirmedBy: string
  confirmedAt: string
}

export interface CampaignPublishReceipt {
  id: string
  platform: CampaignDeliveryPlatform
  accountId: string
  productId: string
  listingId: string
  remoteId: string
  receiptRef: string
  publishedAt: string
}

export type CampaignReviewStatus = 'pending' | 'approved' | 'blocked'
export type CampaignPublishStatus = 'not_ready' | 'awaiting_confirmation' | 'confirmed' | 'publishing' | 'published' | 'failed'

export interface CampaignDeliveryItemInput {
  id: string
  productId: string
  listingId: string
  skuIds: string[]
  platform: CampaignDeliveryPlatform
  accountId: string
  contentVersion: { id: string; hash: string }
  visualVersions: Array<{ id: string; hash: string }>
  specification: { id: string; hash: string; evidenceState: 'production_canary' | 'official_document' | 'unverified'; evidenceRef?: string }
  activityPolicy?: { id: string; hash: string; validUntil?: string }
  ruleSnapshot: { id: string; hash: string; checkedAt: string; evidenceRef: string }
  versionVector: CampaignVersionVector
  review: { status: CampaignReviewStatus; approval?: CampaignReviewApproval; reason?: string }
  publish: {
    status: CampaignPublishStatus
    remoteSnapshotHash?: string
    confirmation?: CampaignPublishConfirmation
    receipt?: CampaignPublishReceipt
    attempts?: number
    error?: { code: string; message: string }
  }
}

export interface CampaignDeliveryManifestInput {
  id: string
  workspaceId: string
  campaignId: string
  brandId: string
  items: CampaignDeliveryItemInput[]
  paused?: boolean
  pauseReason?: string
  revision?: number
}

export type CampaignDeliveryOverallState = 'pending' | 'in_progress' | 'partial' | 'paused' | 'completed' | 'blocked'
export type CampaignDeliveryNextAction = 'review_item' | 'resolve_review' | 'capture_remote_snapshot' | 'confirm_publish' | 'publish_item' | 'await_publish_result' | 'retry_failed' | 'resume_campaign' | 'none'

export interface CampaignDeliveryItemSnapshot extends CampaignDeliveryItemInput {
  versionVectorHash: string
  nextAction: CampaignDeliveryNextAction
}

export interface CampaignDeliveryProgress {
  total: number
  reviewed: number
  confirmed: number
  publishing: number
  published: number
  failed: number
  blocked: number
  percent: number
}

export interface CampaignDeliveryManifestSnapshot {
  id: string
  workspaceId: string
  campaignId: string
  brandId: string
  state: CampaignDeliveryOverallState
  paused: boolean
  pauseReason?: string
  revision: number
  progress: CampaignDeliveryProgress
  items: CampaignDeliveryItemSnapshot[]
}

export type CampaignManifestErrorCode =
  | 'CAMPAIGN_MANIFEST_INVALID'
  | 'CAMPAIGN_ITEM_LIMIT_EXCEEDED'
  | 'CAMPAIGN_ITEM_DUPLICATE'
  | 'CAMPAIGN_ITEM_SCOPE_INVALID'
  | 'CAMPAIGN_ITEM_EVIDENCE_REQUIRED'
  | 'CAMPAIGN_VERSION_SCOPE_LEAK'
  | 'CAMPAIGN_APPROVAL_SCOPE_MISMATCH'
  | 'CAMPAIGN_APPROVAL_REUSED'
  | 'CAMPAIGN_CONFIRMATION_SCOPE_MISMATCH'
  | 'CAMPAIGN_CONFIRMATION_REUSED'
  | 'CAMPAIGN_RECEIPT_SCOPE_MISMATCH'
  | 'CAMPAIGN_ITEM_NOT_FOUND'
  | 'CAMPAIGN_INVALID_TRANSITION'
  | 'CAMPAIGN_IDEMPOTENCY_INVALID'
  | 'CAMPAIGN_IDEMPOTENCY_CONFLICT'

export class CampaignManifestError extends Error {
  constructor(readonly code: CampaignManifestErrorCode, message: string, readonly path?: string) {
    super(message)
    this.name = 'CampaignManifestError'
  }
}

const clone = <T>(value: T): T => structuredClone(value)
const hashPattern = /^[a-f0-9]{64}$/u
const text = (value: string | undefined) => value?.normalize('NFKC').trim() ?? ''
const unique = (values: readonly string[]) => [...new Set(values.map(text).filter(Boolean))]
const sameSet = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
const canonicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function requireText(value: string | undefined, path: string) {
  if (!text(value)) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', `${path} 不能为空`, path)
}

function requireHash(value: string | undefined, path: string) {
  if (!value || !hashPattern.test(value)) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} 必须是 SHA-256`, path)
}

function vectorHash(vector: CampaignVersionVector) {
  return canonicalHash({ ...vector, skuIds: [...vector.skuIds].sort(), visualVersionIds: [...vector.visualVersionIds].sort() })
}

function validateApproval(item: CampaignDeliveryItemInput, approval: CampaignReviewApproval) {
  const scoped = approval.platform === item.platform && approval.accountId === item.accountId && approval.productId === item.productId && approval.listingId === item.listingId && approval.contentVersionId === item.contentVersion.id && approval.ruleSnapshotId === item.ruleSnapshot.id && sameSet(approval.visualVersionIds, item.visualVersions.map(version => version.id))
  if (!scoped || !text(approval.id) || !text(approval.approvedBy) || Number.isNaN(Date.parse(approval.approvedAt))) throw new CampaignManifestError('CAMPAIGN_APPROVAL_SCOPE_MISMATCH', `审批 ${approval.id || '(empty)'} 与 item ${item.id} scope 不一致`, `items.${item.id}.review.approval`)
}

function validateConfirmation(item: CampaignDeliveryItemInput, confirmation: CampaignPublishConfirmation) {
  const scoped = confirmation.platform === item.platform && confirmation.accountId === item.accountId && confirmation.productId === item.productId && confirmation.listingId === item.listingId && confirmation.versionVectorHash === vectorHash(item.versionVector) && confirmation.remoteSnapshotHash === item.publish.remoteSnapshotHash
  if (!scoped || !text(confirmation.id) || !text(confirmation.confirmedBy) || !hashPattern.test(confirmation.remoteSnapshotHash) || Number.isNaN(Date.parse(confirmation.confirmedAt))) throw new CampaignManifestError('CAMPAIGN_CONFIRMATION_SCOPE_MISMATCH', `发布确认 ${confirmation.id || '(empty)'} 与 item ${item.id} scope 或版本不一致`, `items.${item.id}.publish.confirmation`)
}

function validateReceipt(item: CampaignDeliveryItemInput, receipt: CampaignPublishReceipt) {
  const scoped = receipt.platform === item.platform && receipt.accountId === item.accountId && receipt.productId === item.productId && receipt.listingId === item.listingId
  if (!scoped || !text(receipt.id) || !text(receipt.remoteId) || !text(receipt.receiptRef) || Number.isNaN(Date.parse(receipt.publishedAt))) throw new CampaignManifestError('CAMPAIGN_RECEIPT_SCOPE_MISMATCH', `发布回执 ${receipt.id || '(empty)'} 与 item ${item.id} scope 不一致`, `items.${item.id}.publish.receipt`)
}

function validateItem(input: CampaignDeliveryManifestInput, item: CampaignDeliveryItemInput, index: number) {
  const path = `items[${index}]`
  for (const [key, value] of Object.entries({ id: item.id, productId: item.productId, listingId: item.listingId, accountId: item.accountId })) requireText(value, `${path}.${key}`)
  if (!(CAMPAIGN_DELIVERY_PLATFORMS as readonly string[]).includes(item.platform) || !item.skuIds.length || unique(item.skuIds).length !== item.skuIds.length) throw new CampaignManifestError('CAMPAIGN_ITEM_SCOPE_INVALID', `${path} 平台或 SKU scope 无效`, path)
  requireText(item.contentVersion.id, `${path}.contentVersion.id`); requireHash(item.contentVersion.hash, `${path}.contentVersion.hash`)
  if (!item.visualVersions.length) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} 缺少视觉版本`, `${path}.visualVersions`)
  item.visualVersions.forEach((version, visualIndex) => { requireText(version.id, `${path}.visualVersions[${visualIndex}].id`); requireHash(version.hash, `${path}.visualVersions[${visualIndex}].hash`) })
  requireText(item.specification.id, `${path}.specification.id`); requireHash(item.specification.hash, `${path}.specification.hash`)
  if (item.specification.evidenceState !== 'production_canary' || !text(item.specification.evidenceRef)) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} 规格缺少 production canary 证据`, `${path}.specification`)
  requireText(item.ruleSnapshot.id, `${path}.ruleSnapshot.id`); requireHash(item.ruleSnapshot.hash, `${path}.ruleSnapshot.hash`)
  if (!text(item.ruleSnapshot.evidenceRef) || Number.isNaN(Date.parse(item.ruleSnapshot.checkedAt))) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} 规则快照证据无效`, `${path}.ruleSnapshot`)
  if (item.activityPolicy) { requireText(item.activityPolicy.id, `${path}.activityPolicy.id`); requireHash(item.activityPolicy.hash, `${path}.activityPolicy.hash`); if (item.activityPolicy.validUntil && Number.isNaN(Date.parse(item.activityPolicy.validUntil))) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} 活动有效期无效`, `${path}.activityPolicy.validUntil`) }
  const vector = item.versionVector
  const scoped = vector.campaignId === input.campaignId && vector.brandId === input.brandId && vector.productId === item.productId && vector.listingId === item.listingId && vector.platform === item.platform && vector.accountId === item.accountId && vector.contentVersionId === item.contentVersion.id && vector.specificationId === item.specification.id && vector.ruleSnapshotId === item.ruleSnapshot.id && vector.activityPolicyId === item.activityPolicy?.id && sameSet(vector.skuIds, item.skuIds) && sameSet(vector.visualVersionIds, item.visualVersions.map(version => version.id))
  if (!scoped) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', `${path} version vector 混入其他平台、账号、商品或版本`, `${path}.versionVector`)
  if (item.review.status === 'approved') {
    if (!item.review.approval) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} approved review 缺少审批证据`, `${path}.review.approval`)
    validateApproval(item, item.review.approval)
  } else if (item.review.approval) throw new CampaignManifestError('CAMPAIGN_APPROVAL_SCOPE_MISMATCH', `${path} 非 approved 状态不能携带审批`, `${path}.review`)
  if (item.publish.remoteSnapshotHash) requireHash(item.publish.remoteSnapshotHash, `${path}.publish.remoteSnapshotHash`)
  if (item.publish.confirmation) validateConfirmation(item, item.publish.confirmation)
  if (['confirmed', 'publishing', 'published'].includes(item.publish.status) && !item.publish.confirmation) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} ${item.publish.status} 缺少独立发布确认`, `${path}.publish.confirmation`)
  if (item.publish.status === 'published') {
    if (!item.publish.receipt) throw new CampaignManifestError('CAMPAIGN_ITEM_EVIDENCE_REQUIRED', `${path} published 缺少回执`, `${path}.publish.receipt`)
    validateReceipt(item, item.publish.receipt)
  } else if (item.publish.receipt) throw new CampaignManifestError('CAMPAIGN_RECEIPT_SCOPE_MISMATCH', `${path} 未发布状态不能携带回执`, `${path}.publish.receipt`)
  if (!Number.isInteger(item.publish.attempts ?? 0) || (item.publish.attempts ?? 0) < 0) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', `${path} attempts 无效`, `${path}.publish.attempts`)
}

function validateManifest(input: CampaignDeliveryManifestInput) {
  for (const [key, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId, campaignId: input.campaignId, brandId: input.brandId })) requireText(value, key)
  if (!input.items.length) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', 'campaign 至少需要一个交付项', 'items')
  if (input.items.length > 50) throw new CampaignManifestError('CAMPAIGN_ITEM_LIMIT_EXCEEDED', '单个 campaign 最多 50 项', 'items')
  input.items.forEach((item, index) => validateItem(input, item, index))
  const itemIds = input.items.map(item => item.id)
  const scopes = input.items.map(item => `${item.platform}:${item.accountId}:${item.productId}:${item.listingId}:${[...item.skuIds].sort().join(',')}`)
  const vectors = input.items.map(item => vectorHash(item.versionVector))
  const contents = input.items.map(item => item.contentVersion.id)
  const visuals = input.items.flatMap(item => item.visualVersions.map(version => version.id))
  if (new Set(itemIds).size !== itemIds.length || new Set(scopes).size !== scopes.length) throw new CampaignManifestError('CAMPAIGN_ITEM_DUPLICATE', 'campaign item ID 或完整 scope 重复', 'items')
  if (new Set(vectors).size !== vectors.length || new Set(contents).size !== contents.length || new Set(visuals).size !== visuals.length) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', '内容、视觉或 version vector 被多个交付项复用', 'items')
  const approvals = input.items.flatMap(item => item.review.approval ? [item.review.approval.id] : [])
  const confirmations = input.items.flatMap(item => item.publish.confirmation ? [item.publish.confirmation.id] : [])
  if (new Set(approvals).size !== approvals.length) throw new CampaignManifestError('CAMPAIGN_APPROVAL_REUSED', '审批 ID 被多个平台/商品复用', 'items.review')
  if (new Set(confirmations).size !== confirmations.length) throw new CampaignManifestError('CAMPAIGN_CONFIRMATION_REUSED', '发布确认 ID 被多个平台/商品复用', 'items.publish')
}

function nextAction(item: CampaignDeliveryItemInput, paused: boolean): CampaignDeliveryNextAction {
  if (paused) return 'resume_campaign'
  if (item.review.status === 'pending') return 'review_item'
  if (item.review.status === 'blocked') return 'resolve_review'
  if (!item.publish.remoteSnapshotHash) return 'capture_remote_snapshot'
  if (item.publish.status === 'not_ready' || item.publish.status === 'awaiting_confirmation') return 'confirm_publish'
  if (item.publish.status === 'confirmed') return 'publish_item'
  if (item.publish.status === 'publishing') return 'await_publish_result'
  if (item.publish.status === 'failed') return 'retry_failed'
  return 'none'
}

export class CampaignDeliveryManifestMachine {
  private manifest: CampaignDeliveryManifestInput
  private readonly idempotency = new Map<string, string>()

  constructor(input: CampaignDeliveryManifestInput) {
    validateManifest(input)
    this.manifest = clone(input)
    this.manifest.revision = input.revision ?? 1
    this.manifest.paused = input.paused ?? false
    for (const item of this.manifest.items) {
      item.skuIds = unique(item.skuIds)
      item.versionVector.skuIds = unique(item.versionVector.skuIds)
      item.versionVector.visualVersionIds = unique(item.versionVector.visualVersionIds)
      item.publish.attempts = item.publish.attempts ?? 0
      if (item.review.status === 'approved' && item.publish.status === 'not_ready') item.publish.status = 'awaiting_confirmation'
    }
  }

  private item(itemId: string) {
    const item = this.manifest.items.find(candidate => candidate.id === itemId)
    if (!item) throw new CampaignManifestError('CAMPAIGN_ITEM_NOT_FOUND', `item ${itemId} 不存在`, 'itemId')
    return item
  }

  private mutate(operation: string, idempotencyKey: string, payload: unknown, action: () => void) {
    const key = text(idempotencyKey)
    if (!key || key.length > 200) throw new CampaignManifestError('CAMPAIGN_IDEMPOTENCY_INVALID', '幂等键必须为 1-200 个字符', 'idempotencyKey')
    const fingerprint = canonicalHash({ operation, payload })
    const existing = this.idempotency.get(key)
    if (existing) {
      if (existing !== fingerprint) throw new CampaignManifestError('CAMPAIGN_IDEMPOTENCY_CONFLICT', '幂等键已用于不同操作或参数', 'idempotencyKey')
      return this.snapshot()
    }
    action()
    this.manifest.revision = (this.manifest.revision ?? 0) + 1
    this.idempotency.set(key, fingerprint)
    return this.snapshot()
  }

  approveReview(itemId: string, approval: CampaignReviewApproval, idempotencyKey: string) {
    return this.mutate('approve_review', idempotencyKey, { itemId, approval }, () => {
      const item = this.item(itemId)
      validateApproval(item, approval)
      if (this.manifest.items.some(candidate => candidate.id !== itemId && candidate.review.approval?.id === approval.id)) throw new CampaignManifestError('CAMPAIGN_APPROVAL_REUSED', '审批不能跨平台或商品复用', `items.${itemId}.review`)
      if (item.review.status === 'blocked') throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', 'blocked review 必须先解决问题', `items.${itemId}.review`)
      item.review = { status: 'approved', approval: clone(approval) }
      item.publish.status = 'awaiting_confirmation'
      delete item.publish.confirmation
    })
  }

  blockReview(itemId: string, reason: string, idempotencyKey: string) {
    return this.mutate('block_review', idempotencyKey, { itemId, reason }, () => {
      const item = this.item(itemId)
      if (!text(reason)) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', 'review 阻断原因不能为空', `items.${itemId}.review.reason`)
      item.review = { status: 'blocked', reason: text(reason) }
      item.publish.status = 'not_ready'; delete item.publish.confirmation
    })
  }

  observeRemoteSnapshot(itemId: string, remoteSnapshotHash: string, idempotencyKey: string) {
    requireHash(remoteSnapshotHash, `items.${itemId}.publish.remoteSnapshotHash`)
    return this.mutate('observe_remote_snapshot', idempotencyKey, { itemId, remoteSnapshotHash }, () => {
      const item = this.item(itemId)
      if (item.publish.status === 'published') throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', '已发布项不能替换历史远端快照', `items.${itemId}.publish`)
      const changed = item.publish.remoteSnapshotHash !== undefined && item.publish.remoteSnapshotHash !== remoteSnapshotHash
      item.publish.remoteSnapshotHash = remoteSnapshotHash
      if (changed && item.publish.confirmation) {
        delete item.publish.confirmation
        item.publish.status = item.review.status === 'approved' ? 'awaiting_confirmation' : 'not_ready'
      }
    })
  }

  confirmPublish(itemId: string, confirmation: CampaignPublishConfirmation, idempotencyKey: string) {
    return this.mutate('confirm_publish', idempotencyKey, { itemId, confirmation }, () => {
      const item = this.item(itemId)
      if (item.review.status !== 'approved' || !item.review.approval) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', '每个 item 必须独立 review approved 后才能确认发布', `items.${itemId}.review`)
      validateConfirmation(item, confirmation)
      if (this.manifest.items.some(candidate => candidate.id !== itemId && candidate.publish.confirmation?.id === confirmation.id)) throw new CampaignManifestError('CAMPAIGN_CONFIRMATION_REUSED', '发布确认不能跨平台或商品复用', `items.${itemId}.publish`)
      item.publish.confirmation = clone(confirmation)
      item.publish.status = 'confirmed'
      delete item.publish.error
    })
  }

  startPublishing(itemId: string, idempotencyKey: string) {
    return this.mutate('start_publishing', idempotencyKey, { itemId }, () => {
      if (this.manifest.paused) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', 'campaign 已暂停', 'paused')
      const item = this.item(itemId)
      if (item.publish.status !== 'confirmed' || !item.publish.confirmation) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', 'item 缺少有效发布确认', `items.${itemId}.publish`)
      validateConfirmation(item, item.publish.confirmation)
      item.publish.status = 'publishing'; item.publish.attempts = (item.publish.attempts ?? 0) + 1
    })
  }

  recordPublishResult(itemId: string, result: { state: 'published'; receipt: CampaignPublishReceipt } | { state: 'failed'; error: { code: string; message: string } }, idempotencyKey: string) {
    return this.mutate('record_publish_result', idempotencyKey, { itemId, result }, () => {
      const item = this.item(itemId)
      if (item.publish.status !== 'publishing') throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', '只有 publishing item 可以记录结果', `items.${itemId}.publish`)
      if (result.state === 'published') {
        validateReceipt(item, result.receipt)
        item.publish.status = 'published'; item.publish.receipt = clone(result.receipt); delete item.publish.error
      } else {
        if (!text(result.error.code) || !text(result.error.message)) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', '失败结果必须包含错误代码和消息', `items.${itemId}.publish.error`)
        item.publish.status = 'failed'; item.publish.error = clone(result.error)
      }
    })
  }

  pause(reason: string, idempotencyKey: string) {
    return this.mutate('pause', idempotencyKey, { reason }, () => {
      if (!text(reason)) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', '暂停原因不能为空', 'pauseReason')
      this.manifest.paused = true; this.manifest.pauseReason = text(reason)
    })
  }

  resume(idempotencyKey: string) {
    return this.mutate('resume', idempotencyKey, {}, () => {
      this.manifest.paused = false; delete this.manifest.pauseReason
    })
  }

  retryFailed(itemIds: readonly string[] | undefined, idempotencyKey: string) {
    const requested = itemIds ? unique(itemIds) : undefined
    return this.mutate('retry_failed', idempotencyKey, { itemIds: requested ?? null }, () => {
      if (this.manifest.paused) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', 'campaign 已暂停，需先 resume', 'paused')
      const selected = requested ?? this.manifest.items.filter(item => item.publish.status === 'failed').map(item => item.id)
      if (!selected.length) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', '没有可重试的失败项', 'itemIds')
      for (const itemId of selected) {
        const item = this.item(itemId)
        if (item.publish.status !== 'failed') throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', `item ${itemId} 不是 failed`, `items.${itemId}.publish`)
        if (item.publish.confirmation) validateConfirmation(item, item.publish.confirmation)
        item.publish.status = item.publish.confirmation ? 'confirmed' : 'awaiting_confirmation'
        delete item.publish.error
      }
    })
  }

  snapshot(): CampaignDeliveryManifestSnapshot {
    const paused = Boolean(this.manifest.paused)
    const items = this.manifest.items.map(item => ({ ...clone(item), versionVectorHash: vectorHash(item.versionVector), nextAction: nextAction(item, paused) }))
    const progress: CampaignDeliveryProgress = {
      total: items.length,
      reviewed: items.filter(item => item.review.status === 'approved').length,
      confirmed: items.filter(item => ['confirmed', 'publishing', 'published'].includes(item.publish.status)).length,
      publishing: items.filter(item => item.publish.status === 'publishing').length,
      published: items.filter(item => item.publish.status === 'published').length,
      failed: items.filter(item => item.publish.status === 'failed').length,
      blocked: items.filter(item => item.review.status === 'blocked').length,
      percent: Math.round(items.filter(item => item.publish.status === 'published').length / items.length * 100),
    }
    const state: CampaignDeliveryOverallState = paused ? 'paused'
      : progress.published === progress.total ? 'completed'
        : progress.blocked === progress.total ? 'blocked'
          : progress.published > 0 && (progress.failed > 0 || progress.published < progress.total) ? 'partial'
            : progress.failed > 0 ? 'partial'
              : progress.reviewed > 0 || progress.confirmed > 0 || progress.publishing > 0 ? 'in_progress' : 'pending'
    return { id: this.manifest.id, workspaceId: this.manifest.workspaceId, campaignId: this.manifest.campaignId, brandId: this.manifest.brandId, state, paused, ...(this.manifest.pauseReason ? { pauseReason: this.manifest.pauseReason } : {}), revision: this.manifest.revision ?? 1, progress, items }
  }
}
