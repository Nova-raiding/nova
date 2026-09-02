import type { CommercialAccessDecision } from '../../../../packages/contracts/src/commercial-access.js'
import type { CapabilityId } from '../../../../packages/contracts/src/authz.js'
import type {
  CommercialCatalogReadOptions,
  CommercialCatalogSkuSnapshot,
  CreativePointRateSnapshot,
} from '../../../../packages/persistence/src/commercial-catalog-repository.js'
import type {
  CreativePointBalance,
  CreativePointStatementCursor,
  CreativePointStatementEntry,
} from '../../../../packages/persistence/src/creative-point-repository.js'
import type {
  CommercialAccessDecisionFactV2,
  CommercialEntitlementSnapshotV2,
  CommercialOrderListItemV2,
} from '../../../../packages/persistence/src/commercial-contract-repository.js'
import type { ServiceAllocationRecord } from '../../../../packages/persistence/src/service-fulfillment-repository.js'

export const COMMERCIAL_PRIVATE_SKU_READ_CAPABILITY = 'commercial.private_sku.read' as const satisfies CapabilityId

const COMMERCIAL_OPS_READ_CAPABILITIES = [
  'commercial.access.read',
  'commercial.entitlement.read',
  'commercial.point.read',
  'commercial.catalog.read',
  COMMERCIAL_PRIVATE_SKU_READ_CAPABILITY,
  'commercial.order.read',
  'commercial.rate.read',
  'commercial.service_fulfillment.read',
] as const satisfies readonly CapabilityId[]

export type CommercialOpsReadCapability = typeof COMMERCIAL_OPS_READ_CAPABILITIES[number]

export interface CommercialOpsCapabilityProjection {
  readonly capabilities: readonly CommercialOpsReadCapability[]
  readonly canReadPrivateSku: boolean
}

export interface CommercialCatalogAuthorization {
  readonly privateEntriesRequested: boolean
  readonly privateEntriesIncluded: boolean
  readonly repositoryOptions: CommercialCatalogReadOptions
}

type PageCursor = { kind: 'catalog' | 'rate'; afterId: string }
type CommercialOpsReadModelErrorCode = 'COMMERCIAL_OPS_CURSOR_INVALID' | 'COMMERCIAL_OPS_PAGE_LIMIT_INVALID'
type CommercialOpsReadDecisionOutcome = 'DECISION' | 'DENY_DISABLED' | 'DENY_UNCLASSIFIED' | 'DENY_NON_COMMERCIAL'

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decode(cursor: string, code: CommercialOpsReadModelErrorCode): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code)
    return parsed as Record<string, unknown>
  } catch {
    throw new CommercialOpsReadModelError(code, '游标无效或已损坏')
  }
}

export class CommercialOpsReadModelError extends Error {
  constructor(readonly code: CommercialOpsReadModelErrorCode, message: string) {
    super(message)
    this.name = 'CommercialOpsReadModelError'
  }
}

export function commercialOpsPageLimit(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new CommercialOpsReadModelError('COMMERCIAL_OPS_PAGE_LIMIT_INVALID', 'limit 必须是 1 到 100 的整数')
  }
  return parsed
}

/**
 * Projects only the commercial read capabilities already resolved by the
 * central authorization engine. Role names, raw grants and explicit-deny
 * handling deliberately stay outside this module so it cannot widen access.
 */
export function projectCommercialOpsCapabilities(effectiveCapabilities: readonly CapabilityId[]): CommercialOpsCapabilityProjection {
  const effective = new Set(effectiveCapabilities)
  const capabilities = COMMERCIAL_OPS_READ_CAPABILITIES.filter(capability => effective.has(capability))
  return Object.freeze({ capabilities, canReadPrivateSku: capabilities.includes(COMMERCIAL_PRIVATE_SKU_READ_CAPABILITY) })
}

/**
 * A caller without private-SKU capability never asks the repository to include
 * private rows. Passing only the minimum capability also avoids leaking the
 * principal's unrelated permission set into the data layer.
 */
export function authorizeCommercialCatalogRead(includePrivate: unknown, projection: CommercialOpsCapabilityProjection): CommercialCatalogAuthorization {
  const privateEntriesRequested = includePrivate === true || includePrivate === 'true'
  const privateEntriesIncluded = privateEntriesRequested && projection.canReadPrivateSku
  return Object.freeze({
    privateEntriesRequested,
    privateEntriesIncluded,
    repositoryOptions: privateEntriesIncluded
      ? { includePrivate: true, capabilities: [COMMERCIAL_PRIVATE_SKU_READ_CAPABILITY] }
      : { includePrivate: false, capabilities: [] },
  })
}

export function decodeCreativePointStatementCursor(value: unknown): CreativePointStatementCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!text(value)) throw new CommercialOpsReadModelError('COMMERCIAL_OPS_CURSOR_INVALID', '创意点流水游标无效')
  const parsed = decode(value, 'COMMERCIAL_OPS_CURSOR_INVALID')
  if (!text(parsed.createdAt) || !Number.isFinite(Date.parse(parsed.createdAt)) || !text(parsed.id)) {
    throw new CommercialOpsReadModelError('COMMERCIAL_OPS_CURSOR_INVALID', '创意点流水游标无效')
  }
  return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id.trim() }
}

function decodePageCursor(value: unknown, kind: PageCursor['kind']): PageCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!text(value)) throw new CommercialOpsReadModelError('COMMERCIAL_OPS_CURSOR_INVALID', '分页游标无效')
  const parsed = decode(value, 'COMMERCIAL_OPS_CURSOR_INVALID')
  if (parsed.kind !== kind || !text(parsed.afterId)) throw new CommercialOpsReadModelError('COMMERCIAL_OPS_CURSOR_INVALID', '分页游标与数据集不匹配')
  return { kind, afterId: parsed.afterId.trim() }
}

export function paginateCommercialRows<T extends { id: string }>(rows: readonly T[], input: { kind: PageCursor['kind']; cursor?: unknown; limit?: unknown }) {
  const limit = commercialOpsPageLimit(input.limit)
  const cursor = decodePageCursor(input.cursor, input.kind)
  const sorted = [...rows].sort((left, right) => left.id.localeCompare(right.id))
  const start = cursor ? sorted.findIndex(item => item.id === cursor.afterId) : -1
  if (cursor && start < 0) throw new CommercialOpsReadModelError('COMMERCIAL_OPS_CURSOR_INVALID', '分页游标引用的记录不存在')
  const items = sorted.slice(start + 1, start + 1 + limit)
  const hasMore = start + 1 + items.length < sorted.length
  return {
    items,
    total: sorted.length,
    nextCursor: hasMore && items.length ? encode({ kind: input.kind, afterId: items.at(-1)!.id } satisfies PageCursor) : null,
  }
}

export function projectCommercialAccessSummary(input: {
  workspaceId: string
  decision: CommercialAccessDecision | null
  balance: CreativePointBalance
  decisionOutcome: CommercialOpsReadDecisionOutcome
  verifiedAt: string
  unavailableDecisionId: string
}) {
  if (input.decisionOutcome === 'DECISION' && input.decision === null) {
    throw new TypeError('DECISION outcome must provide a complete commercial access decision')
  }
  const known = input.balance.availablePoints !== null
  return {
    schema_version: 'commercial.access-summary.v1',
    decision_id: input.decision?.decision_id ?? input.unavailableDecisionId,
    workspace_id: input.workspaceId,
    balance_state: known ? 'known' : 'unknown',
    available_points: input.balance.availablePoints,
    reserved_points: known ? input.balance.reservedPoints : null,
    settled_points: known ? input.balance.settledPoints : null,
    access_revision: known ? String(input.balance.revision) : null,
    quoted_points: input.decision?.quoted_points ?? null,
    rate_card_version: input.decision?.rate_card_version ?? null,
    error_code: input.decision?.error_code ?? null,
    allowed: input.decision?.allowed ?? false,
    verified_at: input.decision?.decided_at ?? input.verifiedAt,
    next_actions: input.decision?.next_actions ?? ['commercial.access.get', 'creative-points.balance.get'],
    decision_outcome: input.decisionOutcome,
  }
}

export function projectCommercialCatalogItem(item: CommercialCatalogSkuSnapshot) {
  const name = typeof item.payload.name === 'string' && item.payload.name.trim() ? item.payload.name.trim() : item.code
  const priceLabel = item.priceFen === null ? item.priceMode === 'custom' ? '按合同定价' : '价格未决' : `${item.priceMode === 'starts_at' ? '起价 ' : ''}¥${(item.priceFen / 100).toFixed(2)}`
  const benefitsSummary = item.benefits.map(benefit => `${benefit.code}:${benefit.quantity ?? benefit.rawValue ?? '未决'}${benefit.rawUnit ? ` ${benefit.rawUnit}` : ''}`).join('；') || '无已持久化权益项'
  return { id: item.versionId, sku_code: item.code, name, type: item.kind, visibility: item.visibility, version: `v${item.version}`, price_label: priceLabel, cycle_label: item.durationDays === null ? null : `${item.durationDays} 天`, benefits_summary: benefitsSummary, approval_state: item.lifecycle, valid_from: item.effectiveAt, valid_to: null, unresolved: Array.isArray(item.payload.blockers) ? item.payload.blockers.filter((value): value is string => typeof value === 'string') : [], checksum: item.checksum, executable: item.executable }
}

export function projectCreativePointLedgerEntry(entry: CreativePointStatementEntry) {
  return { id: entry.id, workspace_id: entry.workspaceId, event_type: entry.eventType, points_delta: entry.pointsDelta, balance_after: entry.availableAfter, source: entry.grantSourceType ?? entry.eventType, operation_id: entry.operationId, status: entry.eventType, occurred_at: entry.createdAt, evidence: { reserved_after: entry.reservedAfter, settled_after: entry.settledAfter, access_revision: entry.accessRevision, grant_source_id: entry.grantSourceId, intent: entry.intent } }
}

export function projectCreativePointRate(rate: CreativePointRateSnapshot) {
  return {
    id: rate.id,
    action_code: rate.actionCode,
    action_label: rate.actionCode,
    unit_label: rate.unit,
    points_rule: rate.pricingMode === 'fixed' && rate.integerPoints !== null ? `${rate.integerPoints} 点/${rate.unit}` : rate.pricingMode,
    version: `${rate.rateCardId}:v${rate.version}:${rate.checksum}`,
    approval_state: rate.approvalStatus,
    valid_from: rate.effectiveAt,
    valid_to: null,
    blocking_reason: rate.blockers.length ? rate.blockers.join('；') : rate.executable && rate.ruleExecutable ? null : 'RATE_NOT_EXECUTABLE',
    lifecycle: rate.lifecycle,
    executable: rate.executable && rate.ruleExecutable,
  }
}

type ResolvedBenefit = { code: string; quantity: number | null; rawValue: string | null; rawUnit: string | null }

function resolvedBenefits(value: readonly unknown[]): ResolvedBenefit[] {
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const candidate = item as Record<string, unknown>
    if (!text(candidate.code)) return []
    const quantity = candidate.quantity === null || Number.isSafeInteger(candidate.quantity) ? candidate.quantity as number | null : null
    return [{ code: candidate.code, quantity, rawValue: text(candidate.rawValue) ? candidate.rawValue : null, rawUnit: text(candidate.rawUnit) ? candidate.rawUnit : null }]
  })
}

function benefitQuantity(benefits: readonly ResolvedBenefit[], code: string): number | null {
  const matches = benefits.filter(benefit => benefit.code === code && benefit.quantity !== null)
  return matches.length === 1 ? matches[0]!.quantity : null
}

export function projectCommercialEntitlement(item: CommercialEntitlementSnapshotV2) {
  const benefits = resolvedBenefits(item.resolvedBenefits)
  const storage = benefits.find(benefit => benefit.code === 'cloud_storage')
  const services = benefits.filter(benefit => ['monthly_one_to_one_hours', 'one_to_one_service_hours', 'outcome_review_count', 'first_response_business_hours'].includes(benefit.code))
  const serviceSummary = services.map(benefit => `${benefit.code}:${benefit.quantity ?? benefit.rawValue ?? '未决'}${benefit.rawUnit ? ` ${benefit.rawUnit}` : ''}`).join('；') || null
  return {
    id: item.id,
    workspace_id: item.workspaceId,
    sku_code: item.skuCode,
    snapshot_version: item.checksum,
    status: item.executable ? item.periodStatus : 'blocked',
    brand_limit: benefitQuantity(benefits, 'max_brands'),
    store_limit: benefitQuantity(benefits, 'max_stores'),
    storage_label: storage?.rawValue ?? (storage?.quantity !== null && storage?.quantity !== undefined ? `${storage.quantity}${storage.rawUnit ? ` ${storage.rawUnit}` : ''}` : null),
    service_summary: serviceSummary,
    period_label: `${item.periodStart} / ${item.periodEnd}`,
    // The persisted entitlement snapshot currently references its subscription
    // period, not the originating order. Do not relabel that fact as an order.
    source_order_id: null,
    updated_at: item.createdAt,
    unresolved: [...item.unresolvedBlockers],
    executable: item.executable,
  }
}

export function projectCommercialOrder(item: CommercialOrderListItemV2) {
  // Payment and grant are separate facts. This read model has only the order
  // snapshot, so a paid order must remain unknown until a persisted grant is
  // joined by the repository instead of being presented as recovered.
  const grantState = item.status === 'refunded' ? 'refunded' : item.status === 'paid' || item.status === 'reconciliation_required' ? 'unknown' : 'not_granted'
  return {
    id: item.id,
    workspace_id: item.workspaceId,
    sku_code: item.skuCode,
    sku_version: item.skuVersionId,
    purchased_points: null,
    amount_label: `¥${(item.amountFen / 100).toFixed(2)} ${item.currency}`,
    channel: item.paymentProvider,
    payment_state: item.status,
    grant_state: grantState,
    access_revision: null,
    created_at: item.createdAt,
    paid_at: item.paidAt,
    request_id: item.idempotencyKey,
  }
}

export function projectCommercialAccessBlocks(items: readonly CommercialAccessDecisionFactV2[], status: 'open' | 'resolved' | 'all') {
  return items.filter(item => !item.allowed).flatMap(item => {
    const recovered = items.some(candidate => candidate.allowed
      && candidate.decidedAt > item.decidedAt
      && candidate.balanceState === 'known'
      && candidate.availablePoints !== null
      && candidate.availablePoints > 0
      && candidate.accessRevision > item.accessRevision)
    const state = recovered ? 'resolved' as const : 'open' as const
    if (status !== 'all' && status !== state) return []
    return [{
      id: item.id,
      workspace_id: item.workspaceId,
      state,
      error_code: item.code,
      available_points: item.availablePoints,
      quoted_points: item.quotedPoints,
      access_revision: item.balanceState === 'known' ? String(item.accessRevision) : null,
      occurred_at: item.decidedAt,
      verified_at: item.decidedAt,
      payment_state: null,
      grant_state: null,
      request_id: item.requestId,
      next_actions: [...item.nextActions],
      operation_key: item.operationKey,
      access_class: item.accessClass,
      rate_card_version: item.rateCardVersion,
    }]
  })
}

export function projectServiceFulfillment(item: ServiceAllocationRecord) {
  const allocationLabel = item.unit === 'contract_label' ? item.contractLabel! : `${item.allocatedQuantity ?? 0} ${item.unit}`
  const usedLabel = item.unit === 'contract_label' ? '按合同记录' : `${item.usedQuantity} / ${item.allocatedQuantity ?? 0} ${item.unit}`
  return {
    id: item.id,
    workspace_id: item.workspaceId,
    service_type: item.serviceType,
    allocation_label: allocationLabel,
    used_label: usedLabel,
    schedule_at: null,
    status: item.status,
    owner_label: item.createdByActorId,
    evidence_label: `entitlement:${item.entitlementSnapshotId};checksum:${item.sourceChecksum}`,
    updated_at: item.updatedAt,
    revision: item.revision,
    period_start: item.periodStart,
    period_end: item.periodEnd,
  }
}
