export type CanonicalChainStatus = 'verified' | 'legacy_only' | 'conflict' | 'blocked'
/**
 * Public, versioned status vocabulary for consumers of the consistency
 * contract. `CanonicalChainStatus` is intentionally kept as the compatibility
 * status used by the existing queue; new consumers should use `contractStatus`.
 */
export type CanonicalProductStatus = CanonicalChainStatus | 'backfilled' | 'unknown' | 'unavailable'

export type CanonicalReportStatus = 'clean' | 'attention_required' | 'unknown' | 'unavailable'
export type CanonicalReadMode = 'snapshot' | 'live'
/** Workspace-level rollout mode for the legacy-to-canonical read path. */
export type CanonicalProductReadMode = 'legacy_shadow' | 'dual_verify' | 'canonical_read'
export type CanonicalFreshness = 'fresh' | 'stale' | 'expired'
export type CanonicalFreshnessState = CanonicalFreshness | 'unknown'

export const CANONICAL_PRODUCT_READ_MODE_FLAG = 'canonical.product.read_mode'
export const CANONICAL_PRODUCT_READ_MODES: readonly CanonicalProductReadMode[] = ['legacy_shadow', 'dual_verify', 'canonical_read']

export interface CanonicalProductReadScopeCandidate {
  id: string
  /** Optional identity supplied by persistence for defense-in-depth validation. */
  workspaceId?: string
  brandId: string
  title: string
  facts?: Record<string, unknown>
}

export interface CanonicalProductReadListingCandidate {
  id: string
  /** Optional identity facts supplied by persistence for defense-in-depth validation. */
  workspaceId?: string
  brandId?: string
  canonicalProductId?: string
  platform?: string
  accountId?: string
}

export type CanonicalProductReadScopeResult =
  | { status: 'verified'; canonicalProductId: string; brandId: string; listingId: string; title: string; facts: Record<string, unknown> }
  | { status: 'blocked'; code: 'CANONICAL_PRODUCT_MAPPING_REQUIRED' | 'CANONICAL_PRODUCT_LISTING_REQUIRED' | 'CANONICAL_PRODUCT_FACTS_REQUIRED' | 'CANONICAL_PRODUCT_LISTING_SCOPE_INVALID'; reason: string }

/**
 * Resolves the minimum scope required before a workspace may read canonical
 * product facts for a platform operation. This is deliberately pure so the
 * API can keep the rollout decision and the persistence lookup independently
 * testable.
 */
export function resolveCanonicalProductReadScope(input: {
  mode: CanonicalProductReadMode
  workspaceId?: string
  platform?: string
  accountId?: string
  candidates: readonly CanonicalProductReadScopeCandidate[]
  listings: readonly CanonicalProductReadListingCandidate[]
}): CanonicalProductReadScopeResult | undefined {
  if (input.mode !== 'canonical_read') return undefined
  if (input.candidates.length !== 1) {
    return {
      status: 'blocked',
      code: 'CANONICAL_PRODUCT_MAPPING_REQUIRED',
      reason: input.candidates.length === 0 ? 'CANONICAL_MAPPING_MISSING' : 'CANONICAL_MAPPING_CONFLICT',
    }
  }
  if (input.listings.length !== 1) {
    return {
      status: 'blocked',
      code: 'CANONICAL_PRODUCT_LISTING_REQUIRED',
      reason: input.listings.length === 0 ? 'CANONICAL_LISTING_MISSING' : 'CANONICAL_LISTING_CONFLICT',
    }
  }
  const canonical = input.candidates[0]!
  const listing = input.listings[0]!
  // A scoped read must not treat an incomplete persistence projection as an
  // identity match.  Missing values are only compatible with the unscoped
  // pure helper form; once a caller supplies a scope, every corresponding
  // identity field is required before the candidate can become verified.
  const identityMatches = [
    input.workspaceId === undefined ? true : canonical.workspaceId === input.workspaceId,
    input.workspaceId === undefined ? true : listing.workspaceId === input.workspaceId,
    listing.brandId !== undefined && listing.brandId === canonical.brandId,
    listing.canonicalProductId !== undefined && listing.canonicalProductId === canonical.id,
    input.platform === undefined ? true : listing.platform === input.platform,
    input.accountId === undefined ? true : listing.accountId === input.accountId,
  ].every(Boolean)
  if (!identityMatches) {
    return { status: 'blocked', code: 'CANONICAL_PRODUCT_LISTING_SCOPE_INVALID', reason: 'CANONICAL_LISTING_SCOPE_MISMATCH' }
  }
  if (!canonical.facts || Object.keys(canonical.facts).length === 0) {
    return { status: 'blocked', code: 'CANONICAL_PRODUCT_FACTS_REQUIRED', reason: 'CANONICAL_FACTS_MISSING' }
  }
  return { status: 'verified', canonicalProductId: canonical.id, brandId: canonical.brandId, listingId: listing.id, title: canonical.title, facts: structuredClone(canonical.facts) }
}

export function canonicalProductReadModeFromFlag(input: { enabled: boolean; value?: unknown }): CanonicalProductReadMode {
  if (!input.enabled || typeof input.value !== 'string') return 'legacy_shadow'
  return (CANONICAL_PRODUCT_READ_MODES as readonly string[]).includes(input.value)
    ? input.value as CanonicalProductReadMode
    : 'legacy_shadow'
}

export interface CanonicalConsistencyEvaluation {
  /** Caller-owned observation time. The evaluator never invents timestamps. */
  generatedAt?: string
  revision?: string | number
  readMode?: CanonicalReadMode
  freshness?: CanonicalFreshnessState
  availability?: 'available' | 'unknown' | 'unavailable'
  unavailableCode?: string
  unavailableMessage?: string
}

export interface LegacyProductLinkInput {
  id: string
  workspaceId: string
  brandId?: string
  platform?: string
  accountId?: string
  sourceAssetIds?: readonly string[]
}

export interface ProductAssetBindingLinkInput {
  workspaceId: string
  productId: string
  assetId: string
  assetRole: 'source' | 'main' | 'secondary' | 'detail'
  status: 'active' | 'disabled'
  assetExists: boolean
  assetBrandId?: string
  scanStatus?: 'quarantined' | 'clean' | 'blocked'
  rightsStatus?: 'pending' | 'approved' | 'rejected'
}

export interface CanonicalProductLinkInput {
  id: string
  workspaceId: string
  brandId: string
  legacyProductId?: string
}

export interface ProductListingLinkInput {
  id: string
  workspaceId: string
  brandId: string
  canonicalProductId: string
  platform: string
  accountId: string
}

export interface CampaignItemLinkInput {
  id: string
  workspaceId: string
  brandId: string
  /** Legacy campaign rows may predate canonical/listing backfill. */
  canonicalProductId?: string
  listingId?: string
  taskId?: string
  platform?: string
  accountId?: string
}

export interface LegacyTaskLinkInput {
  id: string
  workspaceId: string
  productId: string
  brandId?: string
  canonicalProductId?: string
  listingId?: string
  campaignItemId?: string
  platform?: string
  accountId?: string
}

export interface PublishJobLinkInput {
  id: string
  workspaceId: string
  taskId: string
  platform?: string
  accountId?: string
  canonicalProductId?: string
  listingId?: string
}

export interface CanonicalChainConsistencyInput {
  workspaceId: string
  legacyProducts: readonly LegacyProductLinkInput[]
  canonicalProducts: readonly CanonicalProductLinkInput[]
  listings: readonly ProductListingLinkInput[]
  campaignItems: readonly CampaignItemLinkInput[]
  tasks: readonly LegacyTaskLinkInput[]
  publishJobs?: readonly PublishJobLinkInput[]
  assetBindings?: readonly ProductAssetBindingLinkInput[]
  /** Optional evidence about the read itself; absent means freshness is unknown. */
  evaluation?: CanonicalConsistencyEvaluation
}

export interface CanonicalBlockingDetail {
  code: string
  message: string
  impact: string
  objectType: 'product' | 'canonical_product' | 'listing' | 'campaign_item' | 'task' | 'publish_job' | 'workspace'
  objectId: string
  retryable: boolean
}

export interface CanonicalNextAction {
  id: string
  method: string
  label: string
  reason: string
  permission: { allowed: boolean; requiredRole: string | null }
  requiredInputs: string[]
  confirmation: 'none' | 'interactive_confirmation'
}

export interface CanonicalChainFinding {
  legacyProductId: string
  status: CanonicalChainStatus
  /** Stable contract status; retained separately so old queue consumers stay compatible. */
  contractStatus?: CanonicalProductStatus
  productId?: string
  scope?: {
    brandId: string | null
    platform: string | null
    accountId: string | null
    listingId: string | null
  }
  relation?: {
    listingIds: string[]
    campaignItemIds: string[]
    taskIds: string[]
    publishJobIds: string[]
  }
  blocking?: CanonicalBlockingDetail | null
  nextAction?: CanonicalNextAction | null
  evidence?: {
    codes: string[]
    /** Wire-compatible with the existing Ops type; absent evidence is emitted as null at runtime. */
    generatedAt: string
    revision: string | number | null
  }
  codes: string[]
  canonicalProductId?: string
  listingIds: string[]
  campaignItemIds: string[]
  taskIds: string[]
  publishJobIds: string[]
}

export interface CanonicalChainConsistencyReport {
  workspaceId: string
  /** Compatibility summary status consumed by the existing API. */
  status: 'clean' | 'attention_required'
  contractVersion?: 1
  contractStatus?: CanonicalReportStatus
  /** Wire-compatible with existing consumers; null is retained on the wire when no caller evidence exists. */
  generatedAt?: string
  readMode?: CanonicalReadMode
  freshness?: CanonicalFreshness
  revision?: string | number | null
  availability?: 'available' | 'unknown' | 'unavailable'
  blocking?: CanonicalBlockingDetail | null
  counts: Record<CanonicalChainStatus, number>
  findings: CanonicalChainFinding[]
  orphanFindings: CanonicalChainOrphanFinding[]
}

export interface CanonicalChainOrphanFinding {
  entityType: 'canonical_product' | 'listing' | 'campaign_item' | 'task' | 'publish_job'
  entityId: string
  status: 'conflict' | 'blocked'
  codes: string[]
  blocking?: CanonicalBlockingDetail
  nextAction?: CanonicalNextAction
}

export type CanonicalWorkspaceCutoverBlockCode =
  | 'CANONICAL_WORKSPACE_ID_REQUIRED'
  | 'CANONICAL_REPORT_UNAVAILABLE'
  | 'CANONICAL_REPORT_STALE'
  | 'CANONICAL_REPORT_EVIDENCE_REQUIRED'
  | 'CANONICAL_WORKSPACE_EMPTY'
  | 'CANONICAL_WORKSPACE_NOT_VERIFIED'

export interface CanonicalWorkspaceCutoverMetrics {
  workspaceId: string
  generatedAt: string | null
  revision: string | number | null
  counts: Record<CanonicalChainStatus, number>
  findingCount: number
  orphanFindingCount: number
}

export type CanonicalWorkspaceCutoverDecision =
  | { eligible: true; metrics: CanonicalWorkspaceCutoverMetrics }
  | { eligible: false; code: CanonicalWorkspaceCutoverBlockCode; reason: string; metrics: CanonicalWorkspaceCutoverMetrics }

/**
 * Evaluate the workspace-level safety gate before canonical read cutover.
 * This is deliberately stricter than the compatibility `status` field: a
 * clean-looking empty, stale, unavailable, or evidence-free report must not
 * be treated as permission to switch a workspace to canonical reads.
 */
export function evaluateCanonicalWorkspaceCutoverGate(report: CanonicalChainConsistencyReport): CanonicalWorkspaceCutoverDecision {
  const metrics: CanonicalWorkspaceCutoverMetrics = {
    workspaceId: report.workspaceId,
    generatedAt: report.generatedAt || null,
    revision: report.revision ?? null,
    counts: { ...report.counts },
    findingCount: report.findings.length,
    orphanFindingCount: report.orphanFindings.length,
  }
  if (!report.workspaceId.trim()) return { eligible: false, code: 'CANONICAL_WORKSPACE_ID_REQUIRED', reason: 'workspace_id 不能为空。', metrics }
  if (report.availability !== 'available' || report.contractStatus === 'unavailable') return { eligible: false, code: 'CANONICAL_REPORT_UNAVAILABLE', reason: '一致性报告不可用，不能切换 canonical read。', metrics }
  if (report.freshness !== 'fresh') return { eligible: false, code: 'CANONICAL_REPORT_STALE', reason: '一致性报告不是 fresh，必须重新检查。', metrics }
  if (!report.generatedAt || report.revision === null || report.revision === undefined) return { eligible: false, code: 'CANONICAL_REPORT_EVIDENCE_REQUIRED', reason: '一致性报告缺少生成时间或 revision 证据。', metrics }
  if (report.counts.verified === 0) return { eligible: false, code: 'CANONICAL_WORKSPACE_EMPTY', reason: 'workspace 没有可切读的 verified 商品链。', metrics }
  if (report.status !== 'clean' || report.contractStatus !== 'clean' || report.counts.legacy_only > 0 || report.counts.conflict > 0 || report.counts.blocked > 0 || report.findings.length !== report.counts.verified) {
    return { eligible: false, code: 'CANONICAL_WORKSPACE_NOT_VERIFIED', reason: 'workspace 仍有未验证商品链或孤儿关系。', metrics }
  }
  return { eligible: true, metrics }
}

const statusRank: Record<CanonicalChainStatus, number> = { conflict: 0, blocked: 1, legacy_only: 2, verified: 3 }
const sorted = (values: Iterable<string>) => [...new Set(values)].sort((left, right) => left.localeCompare(right))

function blockingFor(code: string, objectId: string, objectType: CanonicalBlockingDetail['objectType']): CanonicalBlockingDetail {
  const retryable = code.endsWith('_MISSING') || code.endsWith('_ORPHAN')
  return {
    code,
    message: `Consistency check requires attention: ${code}`,
    impact: '该关系链不能作为后续运营或发布动作的已验证依据。',
    objectType,
    objectId,
    retryable,
  }
}

function nextActionFor(code: string, objectId: string): CanonicalNextAction {
  if (code === 'CANONICAL_MAPPING_MISSING') {
    return {
      id: `repair:canonical-product:${objectId}`,
      method: 'brand-unit.product.create',
      label: '创建规范商品映射',
      reason: `需要为对象 ${objectId} 建立规范商品映射。`,
      permission: { allowed: false, requiredRole: 'platform_ops' },
      requiredInputs: ['workspace_id', 'brand_id', 'source_product_id', 'title'],
      confirmation: 'interactive_confirmation',
    }
  }
  if (code === 'LISTING_MAPPING_MISSING') {
    return {
      id: `repair:listing:${objectId}`,
      method: 'brand-unit.listing.create',
      label: '补齐平台店铺 listing',
      reason: `需要为对象 ${objectId} 补齐平台店铺 listing。`,
      permission: { allowed: false, requiredRole: 'platform_ops' },
      requiredInputs: ['workspace_id', 'brand_id', 'canonical_product_id', 'platform', 'account_id'],
      confirmation: 'interactive_confirmation',
    }
  }
  return {
    id: `inspect:${code}`,
    method: 'canonical.product.consistency',
    label: '查看关系链证据',
    reason: `需要处理 ${code}（对象 ${objectId}）。`,
    permission: { allowed: false, requiredRole: 'platform_ops' },
    requiredInputs: ['workspace_id', 'product_id'],
    confirmation: 'none',
  }
}

function objectForCode(code: string, legacyProductId: string, canonicalProductId?: string, listingId?: string, taskId?: string): { type: CanonicalBlockingDetail['objectType']; id: string } {
  if (code.startsWith('LISTING_')) return { type: 'listing', id: listingId ?? canonicalProductId ?? legacyProductId }
  if (code.startsWith('CAMPAIGN_')) return { type: 'campaign_item', id: legacyProductId }
  if (code.startsWith('TASK_')) return { type: 'task', id: taskId ?? legacyProductId }
  if (code.startsWith('PUBLISH_')) return { type: 'publish_job', id: legacyProductId }
  if (code.startsWith('CANONICAL_')) return { type: 'canonical_product', id: canonicalProductId ?? legacyProductId }
  return { type: 'product', id: legacyProductId }
}

function reportUnavailable(workspaceId: string, evaluation: CanonicalConsistencyEvaluation | undefined, code: string, message: string): CanonicalChainConsistencyReport {
  const blocking = blockingFor(code, workspaceId || 'unknown', 'workspace')
  return {
    workspaceId,
    status: 'attention_required',
    contractVersion: 1,
    contractStatus: 'unavailable',
    generatedAt: (evaluation?.generatedAt ?? null) as unknown as string,
    readMode: evaluation?.readMode ?? 'snapshot',
    freshness: (evaluation?.freshness ?? 'unknown') as unknown as CanonicalFreshness,
    revision: evaluation?.revision ?? null,
    availability: 'unavailable',
    blocking: { ...blocking, message },
    counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 },
    findings: [],
    orphanFindings: [],
  }
}

/**
 * Compare the standard product chain without mutating or inferring identities.
 * A caller must provide rows from the same workspace; IDs are only followed
 * through explicit legacy_product_id/canonical_product_id/listing_id/task_id links.
 */
export function buildCanonicalChainConsistencyReport(input: CanonicalChainConsistencyInput): CanonicalChainConsistencyReport {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId) return reportUnavailable(workspaceId, input.evaluation, 'WORKSPACE_ID_REQUIRED', 'workspace_id 不能为空，无法安全确定数据边界。')
  if (input.evaluation?.availability === 'unavailable') return reportUnavailable(workspaceId, input.evaluation, input.evaluation.unavailableCode ?? 'CONSISTENCY_READ_UNAVAILABLE', input.evaluation.unavailableMessage ?? '一致性数据读取不可用。')
  const generatedAt = (input.evaluation?.generatedAt ?? null) as unknown as string
  const readMode = input.evaluation?.readMode ?? 'snapshot'
  const freshness = input.evaluation?.freshness ?? 'unknown'
  const availability = input.evaluation?.availability ?? 'available'
  const products = [...input.legacyProducts].filter(item => item.workspaceId === workspaceId).sort((left, right) => left.id.localeCompare(right.id))
  const scopedCanonical = (input.canonicalProducts ?? []).filter(item => item.workspaceId === workspaceId)
  const scopedListings = (input.listings ?? []).filter(item => item.workspaceId === workspaceId)
  const scopedCampaignItems = (input.campaignItems ?? []).filter(item => item.workspaceId === workspaceId)
  const scopedTasks = (input.tasks ?? []).filter(item => item.workspaceId === workspaceId)
  const scopedPublishJobs = (input.publishJobs ?? []).filter(item => item.workspaceId === workspaceId)
  const canonicalIds = new Set(scopedCanonical.map(item => item.id))
  const listingIds = new Set(scopedListings.map(item => item.id))
  const campaignItemIds = new Set(scopedCampaignItems.map(item => item.id))
  const productIds = new Set(products.map(item => item.id))
  const orphanFindings: CanonicalChainOrphanFinding[] = []
  // A canonical root without an explicit legacy mapping is not automatically
  // wrong, but it is not safe to call the legacy-to-canonical report clean.
  // Keep it visible until the workspace explicitly records a canonical-native
  // policy; this prevents a cutover gate from silently missing new roots.
  for (const canonical of scopedCanonical) {
    if (!canonical.legacyProductId?.trim()) {
      orphanFindings.push({ entityType: 'canonical_product', entityId: canonical.id, status: 'blocked', codes: ['CANONICAL_LEGACY_MAPPING_MISSING'] })
    } else if (!productIds.has(canonical.legacyProductId)) {
      orphanFindings.push({ entityType: 'canonical_product', entityId: canonical.id, status: 'blocked', codes: ['CANONICAL_LEGACY_PRODUCT_ORPHAN'] })
    }
  }
  for (const listing of scopedListings) if (!canonicalIds.has(listing.canonicalProductId)) orphanFindings.push({ entityType: 'listing', entityId: listing.id, status: 'blocked', codes: ['LISTING_CANONICAL_ORPHAN'] })
  const listingTargetGroups = new Map<string, ProductListingLinkInput[]>()
  for (const listing of scopedListings) {
    if (!listing.platform || !listing.accountId) continue
    const key = [listing.brandId, listing.canonicalProductId, listing.platform, listing.accountId].join('\u001f')
    listingTargetGroups.set(key, [...(listingTargetGroups.get(key) ?? []), listing])
  }
  for (const listings of listingTargetGroups.values()) {
    if (listings.length < 2) continue
    for (const listing of listings) {
      orphanFindings.push({ entityType: 'listing', entityId: listing.id, status: 'conflict', codes: ['LISTING_TARGET_DUPLICATE'] })
    }
  }
  for (const item of scopedCampaignItems) {
    const codes = [...(!item.canonicalProductId || !canonicalIds.has(item.canonicalProductId) ? ['CAMPAIGN_CANONICAL_ORPHAN'] : []), ...(!item.listingId || !listingIds.has(item.listingId) ? ['CAMPAIGN_LISTING_ORPHAN'] : [])]
    if (codes.length) orphanFindings.push({ entityType: 'campaign_item', entityId: item.id, status: 'blocked', codes: sorted(codes) })
  }
  for (const task of scopedTasks) {
    const codes = [...(!productIds.has(task.productId) ? ['TASK_PRODUCT_ORPHAN'] : []), ...(task.campaignItemId && !campaignItemIds.has(task.campaignItemId) ? ['TASK_CAMPAIGN_ITEM_ORPHAN'] : [])]
    if (codes.length) orphanFindings.push({ entityType: 'task', entityId: task.id, status: 'blocked', codes: sorted(codes) })
  }
  const publishJobCodesByTask = new Map<string, string[]>()
  for (const job of scopedPublishJobs) {
    const task = scopedTasks.find(candidate => candidate.id === job.taskId)
    const codes = [
      ...(!task ? ['PUBLISH_TASK_ORPHAN'] : []),
      ...(task && !task.canonicalProductId ? ['PUBLISH_CANONICAL_SCOPE_MISSING'] : []),
      ...(task && !task.listingId ? ['PUBLISH_LISTING_SCOPE_MISSING'] : []),
      ...(task && job.platform && task.platform && job.platform !== task.platform ? ['PUBLISH_PLATFORM_SCOPE_MISMATCH'] : []),
      ...(task && job.accountId && task.accountId && job.accountId !== task.accountId ? ['PUBLISH_ACCOUNT_SCOPE_MISMATCH'] : []),
      ...(task && job.canonicalProductId && task.canonicalProductId !== job.canonicalProductId ? ['PUBLISH_CANONICAL_SCOPE_MISMATCH'] : []),
      ...(task && job.listingId && task.listingId !== job.listingId ? ['PUBLISH_LISTING_SCOPE_MISMATCH'] : []),
    ]
    if (codes.length) orphanFindings.push({ entityType: 'publish_job', entityId: job.id, status: 'conflict', codes: sorted(codes) })
    if (task) publishJobCodesByTask.set(task.id, [...(publishJobCodesByTask.get(task.id) ?? []), ...codes])
  }
  orphanFindings.sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId))
  const stableOrphanFindings = orphanFindings.map(orphan => {
    const blocking = blockingFor(orphan.codes[0] ?? 'CONSISTENCY_ORPHAN', orphan.entityId, orphan.entityType)
    return { ...orphan, blocking, nextAction: nextActionFor(blocking.code, orphan.entityId) }
  })
  const canonicalByLegacy = new Map<string, CanonicalProductLinkInput[]>()
  for (const canonical of input.canonicalProducts ?? []) {
    if (canonical.workspaceId !== workspaceId || !canonical.legacyProductId?.trim()) continue
    const rows = canonicalByLegacy.get(canonical.legacyProductId) ?? []
    rows.push(canonical)
    canonicalByLegacy.set(canonical.legacyProductId, rows)
  }
  const findings = products.map((legacy): CanonicalChainFinding => {
    const codes: string[] = []
    const canonicalCandidates = canonicalByLegacy.get(legacy.id) ?? []
    const canonical = canonicalCandidates.length === 1 ? canonicalCandidates[0] : undefined
    if (canonicalCandidates.length === 0) codes.push('CANONICAL_MAPPING_MISSING')
    if (canonicalCandidates.length > 1) codes.push('CANONICAL_MAPPING_AMBIGUOUS')
    // A canonical binding never proves the legacy row's brand.  A missing
    // legacy brand is a migration-106-equivalent integrity failure and must
    // remain visible to consistency consumers instead of being inferred from
    // the canonical side.
    if (canonical && !legacy.brandId) codes.push('MISSING_BRAND')
    else if (canonical && canonical.brandId !== legacy.brandId) codes.push('BRAND_SCOPE_MISMATCH')

    const listings = canonical ? (input.listings ?? []).filter(item => item.workspaceId === workspaceId && item.canonicalProductId === canonical.id) : []
    const listingIds = sorted(listings.map(item => item.id))
    const targetListings = legacy.platform && legacy.accountId
      ? listings.filter(item => item.platform === legacy.platform && item.accountId === legacy.accountId)
      : []
    for (const listing of listings) {
      if (listing.brandId !== canonical?.brandId) codes.push('LISTING_BRAND_SCOPE_MISMATCH')
      if (!listing.platform || !listing.accountId) codes.push('LISTING_STORE_SCOPE_MISSING')
      if (legacy.platform && listing.platform !== legacy.platform) codes.push('LISTING_PLATFORM_MISMATCH')
      if (legacy.accountId && listing.accountId !== legacy.accountId) codes.push('LISTING_ACCOUNT_MISMATCH')
    }
    if (canonical && (legacy.platform || legacy.accountId) && targetListings.length === 0) codes.push('LISTING_MAPPING_MISSING')
    if (targetListings.length > 1) codes.push('LISTING_TARGET_AMBIGUOUS')

    const campaignItems = canonical ? input.campaignItems.filter(item => item.workspaceId === workspaceId && item.canonicalProductId === canonical.id) : []
    const campaignItemIds = sorted(campaignItems.map(item => item.id))
    for (const item of campaignItems) {
      const listing = (input.listings ?? []).find(candidate => candidate.workspaceId === workspaceId && candidate.id === item.listingId)
      if (!listing) codes.push('CAMPAIGN_LISTING_MISSING')
      else if (listing.canonicalProductId !== item.canonicalProductId || listing.brandId !== item.brandId || (item.platform && listing.platform !== item.platform) || (item.accountId && listing.accountId !== item.accountId)) codes.push('CAMPAIGN_SCOPE_MISMATCH')
    }

    const tasks = (input.tasks ?? []).filter(task => task.workspaceId === workspaceId && task.productId === legacy.id)
    const taskIds = sorted(tasks.map(task => task.id))
    const publishJobIds = sorted(scopedPublishJobs.filter(job => tasks.some(task => task.id === job.taskId)).map(job => job.id))
    for (const task of tasks) {
      if (canonical && !task.canonicalProductId) codes.push('TASK_CANONICAL_SCOPE_MISSING')
      if (canonical && !task.listingId) codes.push('TASK_LISTING_SCOPE_MISSING')
      if (task.brandId && legacy.brandId && task.brandId !== legacy.brandId) codes.push('TASK_BRAND_SCOPE_MISMATCH')
      if (task.canonicalProductId && task.canonicalProductId !== canonical?.id) codes.push('TASK_CANONICAL_SCOPE_MISMATCH')
      if (task.listingId && !listingIds.includes(task.listingId)) codes.push('TASK_LISTING_SCOPE_MISMATCH')
      if (task.campaignItemId && !campaignItemIds.includes(task.campaignItemId)) codes.push('TASK_CAMPAIGN_ITEM_SCOPE_MISMATCH')
      if (task.platform && legacy.platform && task.platform !== legacy.platform) codes.push('TASK_PLATFORM_MISMATCH')
      if (task.accountId && legacy.accountId && task.accountId !== legacy.accountId) codes.push('TASK_ACCOUNT_MISMATCH')
      codes.push(...(publishJobCodesByTask.get(task.id) ?? []))
    }

    const bindings = (input.assetBindings ?? []).filter(binding => binding.workspaceId === workspaceId && binding.productId === legacy.id)
    const activeSourceBindings = new Set(bindings.filter(binding => binding.assetRole === 'source' && binding.status === 'active').map(binding => binding.assetId))
    for (const assetId of legacy.sourceAssetIds ?? []) if (!activeSourceBindings.has(assetId)) codes.push('ASSET_BINDING_MISSING')
    for (const binding of bindings) {
      if (binding.status !== 'active') codes.push('ASSET_BINDING_DISABLED')
      if (!binding.assetExists) codes.push('ASSET_NOT_FOUND')
      if (binding.assetBrandId && legacy.brandId && binding.assetBrandId !== legacy.brandId) codes.push('ASSET_BRAND_SCOPE_MISMATCH')
      if (binding.assetExists && binding.scanStatus !== 'clean') codes.push('ASSET_SCAN_NOT_CLEAN')
      if (binding.assetExists && binding.rightsStatus !== 'approved') codes.push('ASSET_RIGHTS_NOT_APPROVED')
    }
    const uniqueCodes = sorted(codes)
    const assetBlocked = uniqueCodes.some(code => ['ASSET_BINDING_MISSING', 'ASSET_BINDING_DISABLED', 'ASSET_NOT_FOUND', 'ASSET_SCAN_NOT_CLEAN', 'ASSET_RIGHTS_NOT_APPROVED'].includes(code))
    const status: CanonicalChainStatus = uniqueCodes.includes('CANONICAL_MAPPING_MISSING') ? 'legacy_only' : uniqueCodes.some(code => code.includes('MISMATCH') || code.includes('AMBIGUOUS')) ? 'conflict' : assetBlocked || uniqueCodes.some(code => code.includes('MISSING')) ? 'blocked' : 'verified'
    const firstCode = uniqueCodes[0]
    const object = firstCode ? objectForCode(firstCode, legacy.id, canonical?.id, listingIds[0], taskIds[0]) : undefined
    const blocking = firstCode && status !== 'verified' && object ? blockingFor(firstCode, object.id, object.type) : null
    return {
      legacyProductId: legacy.id,
      status,
      contractStatus: status,
      productId: legacy.id,
      scope: { brandId: canonical?.brandId ?? legacy.brandId ?? null, platform: legacy.platform ?? listings[0]?.platform ?? null, accountId: legacy.accountId ?? listings[0]?.accountId ?? null, listingId: listingIds.length === 1 ? listingIds[0]! : null },
      relation: { listingIds, campaignItemIds, taskIds, publishJobIds },
      blocking,
      nextAction: blocking ? nextActionFor(blocking.code, blocking.objectId) : null,
      evidence: { codes: uniqueCodes, generatedAt, revision: input.evaluation?.revision ?? null },
      codes: uniqueCodes,
      ...(canonical ? { canonicalProductId: canonical.id } : {}),
      listingIds,
      campaignItemIds,
      taskIds,
      publishJobIds,
    }
  }).sort((left, right) => statusRank[left.status] - statusRank[right.status] || left.legacyProductId.localeCompare(right.legacyProductId))
  const counts: Record<CanonicalChainStatus, number> = { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 }
  for (const finding of findings) counts[finding.status] += 1
  for (const finding of stableOrphanFindings) counts[finding.status] += 1
  const hasIssues = findings.some(finding => finding.status !== 'verified') || stableOrphanFindings.length > 0
  const reportStatus: CanonicalReportStatus = availability === 'unknown' ? 'unknown' : freshness === 'expired' ? 'unavailable' : hasIssues ? 'attention_required' : 'clean'
  return {
    workspaceId,
    // Compatibility `status` must also fail closed for an uncertain read or
    // expired snapshot; otherwise old consumers could render a green state
    // while the versioned contract correctly says it is not usable.
    status: hasIssues || availability !== 'available' || freshness === 'expired' ? 'attention_required' : 'clean',
    contractVersion: 1,
    contractStatus: reportStatus,
    generatedAt,
    readMode,
    freshness: freshness as unknown as CanonicalFreshness,
    revision: input.evaluation?.revision ?? null,
    availability,
    blocking: stableOrphanFindings[0]?.blocking ?? findings.find(finding => finding.blocking)?.blocking ?? null,
    counts,
    findings,
    orphanFindings: stableOrphanFindings,
  }
}
