import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ModelUsageModality = 'text' | 'image' | 'image_edit' | 'ocr' | 'video'
export type ModelSettlementStatus = 'pending_cost' | 'pending_wallet' | 'settled' | 'manual_attention' | 'waived'
export type ModelUsageSettlementDecision = 'retry' | 'waive' | 'manual_attention'
export type ModelCostBudgetReservationStatus = 'active' | 'settled' | 'released' | 'over_budget'
export interface ModelCostBudgetReservation {
  workspaceId: string
  budgetDate: string
  reservationKey: string
  modality: ModelUsageModality
  model: string
  estimateCny: number
  estimateVersion: string
  dailyLimitCny: number
  status: ModelCostBudgetReservationStatus
  actualCostCny?: number
  providerRequestId?: string
  revision: number
  createdAt: string
  updatedAt: string
}
export interface ModelCostBudgetSnapshot { usedCny: number; reservedCny: number; requestCny: number; limitCny: number }

export class ModelCostBudgetExceededError extends Error {
  readonly code = 'MODEL_DAILY_COST_BUDGET_EXCEEDED'
  constructor(readonly details: ModelCostBudgetSnapshot) { super('daily model cost budget would be exceeded'); this.name = 'ModelCostBudgetExceededError' }
}

export class ModelCostBudgetActualExceededError extends Error {
  readonly code = 'MODEL_DAILY_COST_ACTUAL_EXCEEDED'
  readonly providerSucceeded = true
  constructor(readonly details: ModelCostBudgetSnapshot) { super('actual model cost exceeded the reserved daily budget'); this.name = 'ModelCostBudgetActualExceededError' }
}
export interface ModelUsageRecord {
  id: string
  workspaceId: string
  receiptKey: string
  receiptHash: string
  actionId?: string
  contextLinkId?: string
  contextHash?: string
  modality: ModelUsageModality
  model: string
  providerRequestId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costCny?: number
  markupMultiplier?: number
  customerChargeCny?: number
  pricingPolicyRevision?: number
  settlementStatus: ModelSettlementStatus
  attemptCount: number
  lastError?: Record<string, unknown>
  nextAttemptAt?: string
  claimOwner?: string
  claimExpiresAt?: string
  revision: number
  resolvedBy?: string
  resolutionReason?: string
  resolutionEvidenceRef?: string
  resolvedAt?: string
  observedAt: string
  metadata?: Record<string, unknown>
}

export type ModelUsageRecordInput = Omit<ModelUsageRecord, 'id' | 'receiptKey' | 'receiptHash' | 'settlementStatus' | 'attemptCount' | 'revision' | 'observedAt'> & {
  receiptKey?: string
  receiptHash?: string
  settlementStatus?: ModelSettlementStatus
  attemptCount?: number
  revision?: number
  observedAt?: string
}

export interface ModelUsageRepository {
  record(input: ModelUsageRecordInput): Promise<ModelUsageRecord>
  list(workspaceId: string, limit?: number): Promise<ModelUsageRecord[]>
  /** Returns the complete usage population for a statement period. */
  listForStatement(workspaceId: string, period?: { fromAt?: string; toAt?: string; actorId?: string }): Promise<ModelUsageRecord[]>
  /** Returns every receipt for one action in the workspace, without list pagination. */
  listByAction(workspaceId: string, actionId: string): Promise<ModelUsageRecord[]>
  claimPending(input: { workspaceId: string; owner: string; limit?: number; leaseSeconds?: number; now?: string }): Promise<ModelUsageRecord[]>
  resolve(input: { workspaceId: string; id: string; expectedRevision: number; status: ModelSettlementStatus; actorId: string; reason: string; evidenceRef?: string; costCny?: number; markupMultiplier?: number; customerChargeCny?: number; pricingPolicyRevision?: number; lastError?: Record<string, unknown>; nextAttemptAt?: string }): Promise<ModelUsageRecord>
  reserveDailyBudget(input: { workspaceId: string; reservationKey: string; modality: ModelUsageModality; model: string; estimateCny: number; estimateVersion: string; dailyLimitCny: number; at?: string }): Promise<{ reservation: ModelCostBudgetReservation; snapshot: ModelCostBudgetSnapshot; reused: boolean }>
  settleDailyBudget(input: { workspaceId: string; reservationKey: string; actualCostCny: number; providerRequestId?: string; at?: string }): Promise<{ reservation: ModelCostBudgetReservation; snapshot: ModelCostBudgetSnapshot }>
  releaseDailyBudget(input: { workspaceId: string; reservationKey: string; at?: string }): Promise<ModelCostBudgetReservation | undefined>
}

export function allowedModelUsageSettlementDecisions(record: Pick<ModelUsageRecord, 'settlementStatus' | 'costCny' | 'customerChargeCny'>): ModelUsageSettlementDecision[] {
  const retryable = record.costCny !== undefined && record.customerChargeCny !== undefined
  if (record.settlementStatus === 'pending_cost') return [...(retryable ? ['retry' as const] : []), ...(record.costCny === undefined ? ['waive' as const] : []), 'manual_attention']
  if (record.settlementStatus === 'pending_wallet') return [...(retryable ? ['retry' as const] : []), 'manual_attention']
  if (record.settlementStatus === 'manual_attention') return retryable ? ['retry'] : record.costCny === undefined ? ['waive'] : []
  return []
}

const now = () => new Date().toISOString()
const stableReceiptKey = (input: Pick<ModelUsageRecordInput, 'workspaceId' | 'actionId' | 'modality' | 'model' | 'providerRequestId' | 'receiptKey'>) => input.receiptKey?.trim() || input.providerRequestId?.trim() || `relay_usage_${createHash('sha256').update(JSON.stringify([input.workspaceId, input.actionId ?? '', input.modality, input.model])).digest('hex')}`
const stableReceiptHash = (input: Pick<ModelUsageRecordInput, 'workspaceId' | 'actionId' | 'modality' | 'model' | 'providerRequestId' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'receiptHash'>, key: string) => input.receiptHash?.trim() || createHash('sha256').update(JSON.stringify([input.workspaceId, key, input.actionId ?? '', input.modality, input.model, input.providerRequestId ?? '', input.inputTokens ?? null, input.outputTokens ?? null, input.totalTokens ?? null])).digest('hex')
const validateStatus = (status: ModelSettlementStatus) => { if (!['pending_cost', 'pending_wallet', 'settled', 'manual_attention', 'waived'].includes(status)) throw new Error('MODEL_USAGE_SETTLEMENT_STATUS_INVALID') }
const assertSettledCost = (status: ModelSettlementStatus, costCny: number | undefined) => {
  if (status === 'settled' && costCny === undefined) throw new Error('MODEL_USAGE_SETTLED_COST_REQUIRED')
}
const budgetDate = (value = now()) => {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('MODEL_COST_BUDGET_DATE_INVALID')
  return parsed.toISOString().slice(0, 10)
}
const finiteCny = (value: number, allowZero = false) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
const roundedCny = (value: number) => Number(value.toFixed(12))
const validateContextPair = (input: Pick<ModelUsageRecord, 'contextLinkId' | 'contextHash'>) => {
  if ((input.contextLinkId === undefined) !== (input.contextHash === undefined)) throw new Error('MODEL_USAGE_CONTEXT_PAIR_REQUIRED')
  if (input.contextHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.contextHash)) throw new Error('MODEL_USAGE_CONTEXT_HASH_INVALID')
}
const validateTokenFields = (input: Pick<ModelUsageRecord, 'inputTokens' | 'outputTokens' | 'totalTokens'>) => {
  for (const value of [input.inputTokens, input.outputTokens, input.totalTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('MODEL_USAGE_TOKEN_COUNT_INVALID')
  }
  if (input.inputTokens !== undefined && input.outputTokens !== undefined && input.totalTokens !== undefined && input.totalTokens !== input.inputTokens + input.outputTokens) throw new Error('MODEL_USAGE_TOKEN_TOTAL_MISMATCH')
}
const mergeContext = (existing: ModelUsageRecord, input: Pick<ModelUsageRecord, 'contextLinkId' | 'contextHash'>) => {
  validateContextPair(input)
  if (existing.contextLinkId !== undefined && input.contextLinkId !== undefined && existing.contextLinkId !== input.contextLinkId) throw new Error('MODEL_USAGE_CONTEXT_CONFLICT')
  if (existing.contextHash !== undefined && input.contextHash !== undefined && existing.contextHash !== input.contextHash) throw new Error('MODEL_USAGE_CONTEXT_CONFLICT')
  if (existing.contextLinkId === undefined && input.contextLinkId !== undefined) { existing.contextLinkId = input.contextLinkId; existing.contextHash = input.contextHash; existing.revision += 1 }
}
const sameBudgetIntent = (row: ModelCostBudgetReservation, input: { budgetDate: string; modality: ModelUsageModality; model: string; estimateCny: number; estimateVersion: string; dailyLimitCny: number }) => row.budgetDate === input.budgetDate && row.modality === input.modality && row.model === input.model && row.estimateCny === input.estimateCny && row.estimateVersion === input.estimateVersion && row.dailyLimitCny === input.dailyLimitCny

export class MemoryModelUsageRepository implements ModelUsageRepository {
  private readonly rows: ModelUsageRecord[] = []
  private readonly budgetReservations = new Map<string, ModelCostBudgetReservation>()
  async record(input: ModelUsageRecordInput) {
    if (!input.workspaceId.trim()) throw new Error('MODEL_USAGE_WORKSPACE_REQUIRED')
    validateContextPair(input)
    validateTokenFields(input)
    const receiptKey = stableReceiptKey(input); const receiptHash = stableReceiptHash(input, receiptKey)
    const existing = this.rows.find(row => row.workspaceId === input.workspaceId && (row.receiptKey === receiptKey || Boolean(input.providerRequestId && row.providerRequestId === input.providerRequestId)))
    if (existing) {
      if (existing.receiptHash !== receiptHash) throw new Error('MODEL_USAGE_IDEMPOTENCY_CONFLICT')
      mergeContext(existing, input)
      if (existing.costCny === undefined && input.costCny !== undefined) {
        Object.assign(existing, { costCny: input.costCny, markupMultiplier: input.markupMultiplier, customerChargeCny: input.customerChargeCny, pricingPolicyRevision: input.pricingPolicyRevision, settlementStatus: input.settlementStatus ?? 'pending_wallet', lastError: input.lastError, nextAttemptAt: input.nextAttemptAt ?? now(), revision: existing.revision + 1 })
      }
      return existing
    }
    const settlementStatus = input.settlementStatus ?? (input.costCny === undefined ? 'pending_cost' : 'settled'); validateStatus(settlementStatus)
    const row: ModelUsageRecord = { ...input, id: `model_usage_${randomUUID()}`, receiptKey, receiptHash, settlementStatus, attemptCount: input.attemptCount ?? 0, revision: 1, observedAt: input.observedAt ?? now() }
    this.rows.push(row); return row
  }
  async list(workspaceId: string, limit = 100) { return this.rows.filter(row => row.workspaceId === workspaceId).slice(-Math.min(1000, Math.max(1, limit))).reverse() }
  async listForStatement(workspaceId: string, period: { fromAt?: string; toAt?: string; actorId?: string } = {}) {
    requireWorkspaceScope(workspaceId)
    const from = period.fromAt ? Date.parse(period.fromAt) : Number.NEGATIVE_INFINITY
    const to = period.toAt ? Date.parse(period.toAt) : Number.POSITIVE_INFINITY
    if ((period.fromAt && !Number.isFinite(from)) || (period.toAt && !Number.isFinite(to)) || from >= to) throw new Error('MODEL_USAGE_STATEMENT_PERIOD_INVALID')
    return this.rows.filter(row => row.workspaceId === workspaceId).filter(row => { const observed = Date.parse(row.observedAt); return observed >= from && observed < to }).sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id))
  }
  async listByAction(workspaceId: string, actionId: string) {
    requireWorkspaceScope(workspaceId)
    if (!actionId.trim()) throw new Error('MODEL_USAGE_ACTION_REQUIRED')
    return this.rows.filter(row => row.workspaceId === workspaceId && row.actionId === actionId).sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id))
  }
  async claimPending(input: { workspaceId: string; owner: string; limit?: number; leaseSeconds?: number; now?: string }) {
    const at = input.now ?? now(); const expires = new Date(Date.parse(at) + (input.leaseSeconds ?? 60) * 1000).toISOString()
    return this.rows.filter(row => row.workspaceId === input.workspaceId && ['pending_cost', 'pending_wallet'].includes(row.settlementStatus) && (!row.nextAttemptAt || row.nextAttemptAt <= at) && (!row.claimExpiresAt || row.claimExpiresAt <= at)).slice(0, input.limit ?? 50).map(row => { Object.assign(row, { claimOwner: input.owner, claimExpiresAt: expires, attemptCount: row.attemptCount + 1, revision: row.revision + 1 }); return row })
  }
  async resolve(input: { workspaceId: string; id: string; expectedRevision: number; status: ModelSettlementStatus; actorId: string; reason: string; evidenceRef?: string; costCny?: number; markupMultiplier?: number; customerChargeCny?: number; pricingPolicyRevision?: number; lastError?: Record<string, unknown>; nextAttemptAt?: string }) {
    validateStatus(input.status); const row = this.rows.find(item => item.workspaceId === input.workspaceId && item.id === input.id); if (!row) throw new Error('MODEL_USAGE_NOT_FOUND'); if (row.revision !== input.expectedRevision) throw new Error('MODEL_USAGE_REVISION_CONFLICT')
    if ((input.status === 'settled' || input.status === 'waived') && !input.reason.trim()) throw new Error('MODEL_USAGE_RESOLUTION_REASON_REQUIRED')
    assertSettledCost(input.status, input.costCny ?? row.costCny)
    Object.assign(row, { settlementStatus: input.status, costCny: input.costCny ?? row.costCny, markupMultiplier: input.markupMultiplier ?? row.markupMultiplier, customerChargeCny: input.customerChargeCny ?? row.customerChargeCny, pricingPolicyRevision: input.pricingPolicyRevision ?? row.pricingPolicyRevision, lastError: input.lastError, nextAttemptAt: input.nextAttemptAt, claimOwner: undefined, claimExpiresAt: undefined, resolvedBy: ['settled', 'manual_attention', 'waived'].includes(input.status) ? input.actorId : undefined, resolutionReason: ['settled', 'manual_attention', 'waived'].includes(input.status) ? input.reason : undefined, resolutionEvidenceRef: input.evidenceRef, resolvedAt: ['settled', 'manual_attention', 'waived'].includes(input.status) ? now() : undefined, revision: row.revision + 1 }); return row
  }
  private budgetSnapshot(workspaceId: string, date: string, requestCny: number, excludeKey?: string): ModelCostBudgetSnapshot {
    const allReservations = [...this.budgetReservations.values()].filter(row => row.workspaceId === workspaceId && row.budgetDate === date)
    const reservations = allReservations.filter(row => row.reservationKey !== excludeKey)
    const linked = new Set(allReservations.map(row => row.reservationKey))
    const usageActual = this.rows.filter(row => row.workspaceId === workspaceId && budgetDate(row.observedAt) === date && row.costCny !== undefined && (!row.actionId || !linked.has(row.actionId))).reduce((sum, row) => sum + row.costCny!, 0)
    const usedCny = usageActual + reservations.filter(row => row.status === 'settled' || row.status === 'over_budget').reduce((sum, row) => sum + (row.actualCostCny ?? 0), 0)
    const reservedCny = reservations.filter(row => row.status === 'active').reduce((sum, row) => sum + row.estimateCny, 0)
    return { usedCny: roundedCny(usedCny), reservedCny: roundedCny(reservedCny), requestCny: roundedCny(requestCny), limitCny: 0 }
  }
  async reserveDailyBudget(input: { workspaceId: string; reservationKey: string; modality: ModelUsageModality; model: string; estimateCny: number; estimateVersion: string; dailyLimitCny: number; at?: string }) {
    requireWorkspaceScope(input.workspaceId); if (!input.reservationKey.trim() || !input.model.trim() || !input.estimateVersion.trim() || !finiteCny(input.estimateCny) || !finiteCny(input.dailyLimitCny)) throw new Error('MODEL_COST_BUDGET_INPUT_INVALID')
    const date = budgetDate(input.at); const mapKey = `${input.workspaceId}:${input.reservationKey}`; const existing = this.budgetReservations.get(mapKey)
    if (existing && existing.status !== 'released') {
      if (!sameBudgetIntent(existing, { ...input, budgetDate: date })) throw new Error('MODEL_COST_BUDGET_IDEMPOTENCY_CONFLICT')
      const snapshot = { ...this.budgetSnapshot(input.workspaceId, date, existing.estimateCny, existing.reservationKey), limitCny: input.dailyLimitCny }
      return { reservation: existing, snapshot, reused: true }
    }
    if (existing && !sameBudgetIntent(existing, { ...input, budgetDate: date })) throw new Error('MODEL_COST_BUDGET_IDEMPOTENCY_CONFLICT')
    const snapshot = { ...this.budgetSnapshot(input.workspaceId, date, input.estimateCny), limitCny: input.dailyLimitCny }
    if (snapshot.usedCny + snapshot.reservedCny + input.estimateCny > input.dailyLimitCny) throw new ModelCostBudgetExceededError(snapshot)
    const timestamp = input.at ?? now(); const reservation: ModelCostBudgetReservation = existing
      ? Object.assign(existing, { status: 'active' as const, actualCostCny: undefined, providerRequestId: undefined, revision: existing.revision + 1, updatedAt: timestamp })
      : { workspaceId: input.workspaceId, budgetDate: date, reservationKey: input.reservationKey, modality: input.modality, model: input.model, estimateCny: roundedCny(input.estimateCny), estimateVersion: input.estimateVersion, dailyLimitCny: roundedCny(input.dailyLimitCny), status: 'active', revision: 1, createdAt: timestamp, updatedAt: timestamp }
    this.budgetReservations.set(mapKey, reservation); return { reservation, snapshot, reused: false }
  }
  async settleDailyBudget(input: { workspaceId: string; reservationKey: string; actualCostCny: number; providerRequestId?: string; at?: string }) {
    if (!finiteCny(input.actualCostCny, true)) throw new Error('MODEL_COST_BUDGET_ACTUAL_INVALID')
    const row = this.budgetReservations.get(`${requireWorkspaceScope(input.workspaceId)}:${input.reservationKey}`); if (!row) throw new Error('MODEL_COST_BUDGET_RESERVATION_NOT_FOUND')
    if (row.status === 'released') throw new Error('MODEL_COST_BUDGET_RESERVATION_RELEASED')
    if ((row.status === 'settled' || row.status === 'over_budget') && row.providerRequestId === input.providerRequestId && row.actualCostCny !== input.actualCostCny) throw new Error('MODEL_COST_BUDGET_SETTLEMENT_CONFLICT')
    if ((row.status === 'settled' || row.status === 'over_budget') && row.providerRequestId !== input.providerRequestId && input.actualCostCny < (row.actualCostCny ?? 0)) throw new Error('MODEL_COST_BUDGET_SETTLEMENT_CONFLICT')
    const snapshot = { ...this.budgetSnapshot(input.workspaceId, row.budgetDate, input.actualCostCny, row.reservationKey), limitCny: row.dailyLimitCny }
    const exceeded = snapshot.usedCny + snapshot.reservedCny + input.actualCostCny > row.dailyLimitCny
    if ((row.status === 'settled' || row.status === 'over_budget') && row.actualCostCny === input.actualCostCny && row.providerRequestId === input.providerRequestId) {
      if (row.status === 'over_budget') throw new ModelCostBudgetActualExceededError(snapshot)
      return { reservation: row, snapshot }
    }
    Object.assign(row, { status: exceeded ? 'over_budget' as const : 'settled' as const, actualCostCny: roundedCny(input.actualCostCny), providerRequestId: input.providerRequestId, revision: row.revision + 1, updatedAt: input.at ?? now() })
    if (exceeded) throw new ModelCostBudgetActualExceededError(snapshot)
    return { reservation: row, snapshot }
  }
  async releaseDailyBudget(input: { workspaceId: string; reservationKey: string; at?: string }) {
    const row = this.budgetReservations.get(`${requireWorkspaceScope(input.workspaceId)}:${input.reservationKey}`); if (!row || row.status !== 'active') return row
    Object.assign(row, { status: 'released' as const, revision: row.revision + 1, updatedAt: input.at ?? now() }); return row
  }
}

type UsageRow = { id: string; workspace_id: string; receipt_key: string; receipt_hash: string; action_id: string | null; context_link_id: string | null; context_hash: string | null; modality: ModelUsageModality; model: string; provider_request_id: string | null; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cost_cny: number | null; markup_multiplier: number | null; customer_charge_cny: number | null; pricing_policy_revision: number | null; settlement_status: ModelSettlementStatus; attempt_count: number; last_error: Record<string, unknown> | null; next_attempt_at: string | Date | null; claim_owner: string | null; claim_expires_at: string | Date | null; revision: number; resolved_by: string | null; resolution_reason: string | null; resolution_evidence_ref: string | null; resolved_at: string | Date | null; observed_at: string | Date; metadata: Record<string, unknown> | null }
type BudgetRow = { workspace_id: string; budget_date: string | Date; reservation_key: string; modality: ModelUsageModality; model: string; estimate_cny: number | string; estimate_version: string; daily_limit_cny: number | string; status: ModelCostBudgetReservationStatus; actual_cost_cny: number | string | null; provider_request_id: string | null; revision: number; created_at: string | Date; updated_at: string | Date }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const tokenCount = (value: number | string | null) => {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('MODEL_USAGE_TOKEN_COUNT_INVALID')
  return parsed
}
const projection = 'id, workspace_id, receipt_key, receipt_hash, action_id, context_link_id, context_hash, modality, model, provider_request_id, input_tokens, output_tokens, total_tokens, cost_cny, markup_multiplier, customer_charge_cny, pricing_policy_revision, settlement_status, attempt_count, last_error, next_attempt_at, claim_owner, claim_expires_at, revision, resolved_by, resolution_reason, resolution_evidence_ref, resolved_at, observed_at, metadata'
const map = (row: UsageRow): ModelUsageRecord => ({ id: row.id, workspaceId: row.workspace_id, receiptKey: row.receipt_key, receiptHash: row.receipt_hash, ...(row.action_id ? { actionId: row.action_id } : {}), ...(row.context_link_id ? { contextLinkId: row.context_link_id } : {}), ...(row.context_hash ? { contextHash: row.context_hash } : {}), modality: row.modality, model: row.model, ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}), ...(tokenCount(row.input_tokens) !== undefined ? { inputTokens: tokenCount(row.input_tokens) } : {}), ...(tokenCount(row.output_tokens) !== undefined ? { outputTokens: tokenCount(row.output_tokens) } : {}), ...(tokenCount(row.total_tokens) !== undefined ? { totalTokens: tokenCount(row.total_tokens) } : {}), ...(row.cost_cny !== null ? { costCny: Number(row.cost_cny) } : {}), ...(row.markup_multiplier !== null ? { markupMultiplier: Number(row.markup_multiplier) } : {}), ...(row.customer_charge_cny !== null ? { customerChargeCny: Number(row.customer_charge_cny) } : {}), ...(row.pricing_policy_revision !== null ? { pricingPolicyRevision: row.pricing_policy_revision } : {}), settlementStatus: row.settlement_status, attemptCount: row.attempt_count, ...(row.last_error ? { lastError: row.last_error } : {}), ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}), ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}), ...(row.claim_expires_at ? { claimExpiresAt: iso(row.claim_expires_at) } : {}), revision: row.revision, ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}), ...(row.resolution_reason ? { resolutionReason: row.resolution_reason } : {}), ...(row.resolution_evidence_ref ? { resolutionEvidenceRef: row.resolution_evidence_ref } : {}), ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}), observedAt: iso(row.observed_at), ...(row.metadata ? { metadata: row.metadata } : {}) })
const budgetProjection = 'workspace_id,budget_date::text AS budget_date,reservation_key,modality,model,estimate_cny,estimate_version,daily_limit_cny,status,actual_cost_cny,provider_request_id,revision,created_at,updated_at'
const mapBudget = (row: BudgetRow): ModelCostBudgetReservation => ({ workspaceId: row.workspace_id, budgetDate: iso(row.budget_date).slice(0, 10), reservationKey: row.reservation_key, modality: row.modality, model: row.model, estimateCny: Number(row.estimate_cny), estimateVersion: row.estimate_version, dailyLimitCny: Number(row.daily_limit_cny), status: row.status, ...(row.actual_cost_cny !== null ? { actualCostCny: Number(row.actual_cost_cny) } : {}), ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}), revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const budgetLockSql = "SELECT pg_advisory_xact_lock(hashtextextended('model-cost-budget:' || $1 || ':' || $2,0))"
const budgetTotalsSql = `SELECT
  COALESCE((SELECT SUM(u.cost_cny) FROM model_usage_ledger u WHERE u.workspace_id=$1 AND u.observed_at >= $2::date AND u.observed_at < $2::date + interval '1 day' AND u.cost_cny IS NOT NULL AND NOT EXISTS (SELECT 1 FROM model_cost_budget_reservations linked WHERE linked.workspace_id=u.workspace_id AND linked.budget_date=$2::date AND linked.reservation_key=u.action_id)),0)
    + COALESCE(SUM(actual_cost_cny) FILTER (WHERE status IN ('settled','over_budget') AND reservation_key<>COALESCE($3,'')),0) AS used_cny,
  COALESCE(SUM(estimate_cny) FILTER (WHERE status='active' AND reservation_key<>COALESCE($3,'')),0) AS reserved_cny
  FROM model_cost_budget_reservations WHERE workspace_id=$1 AND budget_date=$2::date`

export class PostgresModelUsageRepository implements ModelUsageRepository {
  constructor(private readonly pool: SqlPool) {}
  async record(input: ModelUsageRecordInput) {
    const workspaceId = requireWorkspaceScope(input.workspaceId); validateContextPair(input); validateTokenFields(input); const receiptKey = stableReceiptKey(input); const receiptHash = stableReceiptHash(input, receiptKey); const status = input.settlementStatus ?? (input.costCny === undefined ? 'pending_cost' : 'settled'); const observedAt = input.observedAt ?? now(); validateStatus(status)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await client.query(budgetLockSql, [workspaceId, budgetDate(observedAt)])
      const found = await client.query<UsageRow>(`SELECT ${projection} FROM model_usage_ledger WHERE workspace_id=$1 AND (receipt_key=$2 OR ($3::text IS NOT NULL AND provider_request_id=$3)) FOR UPDATE`, [workspaceId, receiptKey, input.providerRequestId ?? null])
      if (found.rows[0]) {
        const existing = map(found.rows[0]); if (existing.receiptHash !== receiptHash) throw new Error('MODEL_USAGE_IDEMPOTENCY_CONFLICT')
        mergeContext(existing, input)
        if (existing.contextLinkId !== undefined && existing.contextHash !== undefined && (!found.rows[0].context_link_id || !found.rows[0].context_hash)) { const updated = await client.query<UsageRow>(`UPDATE model_usage_ledger SET context_link_id=$3, context_hash=$4, revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING ${projection}`, [workspaceId, existing.id, existing.contextLinkId, existing.contextHash]); Object.assign(existing, map(updated.rows[0]!)) }
        if (existing.costCny === undefined && input.costCny !== undefined) { const updated = await client.query<UsageRow>(`UPDATE model_usage_ledger SET cost_cny=$3, markup_multiplier=$4, customer_charge_cny=$5, pricing_policy_revision=$6, settlement_status=$7, last_error=$8, next_attempt_at=$9, revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING ${projection}`, [workspaceId, existing.id, input.costCny, input.markupMultiplier ?? null, input.customerChargeCny ?? null, input.pricingPolicyRevision ?? null, input.settlementStatus ?? 'pending_wallet', input.lastError ?? null, input.nextAttemptAt ?? now()]); return map(updated.rows[0]!) }
        return existing
      }
      const inserted = await client.query<UsageRow>(`INSERT INTO model_usage_ledger (id,workspace_id,receipt_key,receipt_hash,action_id,context_link_id,context_hash,modality,model,provider_request_id,input_tokens,output_tokens,total_tokens,cost_cny,markup_multiplier,customer_charge_cny,pricing_policy_revision,settlement_status,attempt_count,last_error,next_attempt_at,observed_at,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING ${projection}`, [randomUUID(), workspaceId, receiptKey, receiptHash, input.actionId ?? null, input.contextLinkId ?? null, input.contextHash ?? null, input.modality, input.model, input.providerRequestId ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.totalTokens ?? null, input.costCny ?? null, input.markupMultiplier ?? null, input.customerChargeCny ?? null, input.pricingPolicyRevision ?? null, status, input.attemptCount ?? 0, input.lastError ?? null, input.nextAttemptAt ?? (status.startsWith('pending_') ? now() : null), observedAt, input.metadata ?? null]); return map(inserted.rows[0]!)
    })
  }
  async list(workspaceId: string, limit = 100) { return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => (await client.query<UsageRow>(`SELECT ${projection} FROM model_usage_ledger WHERE workspace_id=$1 ORDER BY observed_at DESC,id DESC LIMIT $2`, [workspaceId, Math.min(1000, Math.max(1, limit))])).rows.map(map)) }
  async listForStatement(workspaceId: string, period: { fromAt?: string; toAt?: string; actorId?: string } = {}) {
    const scopedWorkspaceId = requireWorkspaceScope(workspaceId)
    const from = period.fromAt ? new Date(period.fromAt) : undefined
    const to = period.toAt ? new Date(period.toAt) : undefined
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from >= to)) throw new Error('MODEL_USAGE_STATEMENT_PERIOD_INVALID')
    return withWorkspaceTransaction(this.pool, scopedWorkspaceId, async client => {
      const values: unknown[] = [scopedWorkspaceId]
      const filters = ['workspace_id=$1']
      if (from) { values.push(from.toISOString()); filters.push(`observed_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to.toISOString()); filters.push(`observed_at < $${values.length}::timestamptz`) }
      if (period.actorId) { values.push(period.actorId); filters.push(`EXISTS (SELECT 1 FROM action_ledger attributed_action WHERE attributed_action.workspace_id=model_usage_ledger.workspace_id AND attributed_action.action_key=model_usage_ledger.action_id AND attributed_action.actor_id=$${values.length})`) }
      return (await client.query<UsageRow>(`SELECT ${projection} FROM model_usage_ledger WHERE ${filters.join(' AND ')} ORDER BY observed_at DESC,id DESC`, values)).rows.map(map)
    })
  }
  async listByAction(workspaceId: string, actionId: string) {
    const scopedWorkspaceId = requireWorkspaceScope(workspaceId)
    if (!actionId.trim()) throw new Error('MODEL_USAGE_ACTION_REQUIRED')
    return withWorkspaceTransaction(this.pool, scopedWorkspaceId, async client => (await client.query<UsageRow>(`SELECT ${projection} FROM model_usage_ledger WHERE workspace_id=$1 AND action_id=$2 ORDER BY observed_at DESC,id DESC`, [scopedWorkspaceId, actionId])).rows.map(map))
  }
  async claimPending(input: { workspaceId: string; owner: string; limit?: number; leaseSeconds?: number; now?: string }) { const workspaceId = requireWorkspaceScope(input.workspaceId); const at = input.now ?? now(); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<UsageRow>(`WITH claimed AS (SELECT id FROM model_usage_ledger WHERE workspace_id=$1 AND settlement_status IN ('pending_cost','pending_wallet') AND COALESCE(next_attempt_at,observed_at)<=$2 AND (claim_expires_at IS NULL OR claim_expires_at<=$2) ORDER BY observed_at,id FOR UPDATE SKIP LOCKED LIMIT $3) UPDATE model_usage_ledger m SET claim_owner=$4, claim_expires_at=$2::timestamptz + ($5::text || ' seconds')::interval, attempt_count=m.attempt_count+1, revision=m.revision+1 FROM claimed WHERE m.id=claimed.id RETURNING ${projection.split(', ').map(value => `m.${value}`).join(', ')}`, [workspaceId, at, input.limit ?? 50, input.owner, input.leaseSeconds ?? 60])).rows.map(map)) }
  async resolve(input: { workspaceId: string; id: string; expectedRevision: number; status: ModelSettlementStatus; actorId: string; reason: string; evidenceRef?: string; costCny?: number; markupMultiplier?: number; customerChargeCny?: number; pricingPolicyRevision?: number; lastError?: Record<string, unknown>; nextAttemptAt?: string }) {
    validateStatus(input.status)
    const terminal = ['settled', 'manual_attention', 'waived'].includes(input.status)
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const result = await client.query<UsageRow>(`UPDATE model_usage_ledger SET settlement_status=$4,cost_cny=COALESCE($5,cost_cny),markup_multiplier=COALESCE($6,markup_multiplier),customer_charge_cny=COALESCE($7,customer_charge_cny),pricing_policy_revision=COALESCE($8,pricing_policy_revision),last_error=$9,next_attempt_at=$10,claim_owner=NULL,claim_expires_at=NULL,resolved_by=CASE WHEN $11 THEN $12 ELSE NULL END,resolution_reason=CASE WHEN $11 THEN $13 ELSE NULL END,resolution_evidence_ref=CASE WHEN $11 THEN $14 ELSE NULL END,resolved_at=CASE WHEN $11 THEN now() ELSE NULL END,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND ($4 <> 'settled' OR COALESCE($5,cost_cny) IS NOT NULL) RETURNING ${projection}`, [input.workspaceId, input.id, input.expectedRevision, input.status, input.costCny ?? null, input.markupMultiplier ?? null, input.customerChargeCny ?? null, input.pricingPolicyRevision ?? null, input.lastError ?? null, input.nextAttemptAt ?? null, terminal, input.actorId, input.reason, input.evidenceRef ?? null])
      if (result.rows[0]) return map(result.rows[0])
      const found = await client.query<{ revision: number; cost_cny: number | string | null }>('SELECT revision,cost_cny FROM model_usage_ledger WHERE workspace_id=$1 AND id=$2', [input.workspaceId, input.id])
      const current = found.rows[0]
      if (!current) throw new Error('MODEL_USAGE_NOT_FOUND')
      if (current.revision !== input.expectedRevision) throw new Error('MODEL_USAGE_REVISION_CONFLICT')
      assertSettledCost(input.status, input.costCny ?? (current.cost_cny === null ? undefined : Number(current.cost_cny)))
      throw new Error('MODEL_USAGE_REVISION_CONFLICT')
    })
  }
  async reserveDailyBudget(input: { workspaceId: string; reservationKey: string; modality: ModelUsageModality; model: string; estimateCny: number; estimateVersion: string; dailyLimitCny: number; at?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId); if (!input.reservationKey.trim() || !input.model.trim() || !input.estimateVersion.trim() || !finiteCny(input.estimateCny) || !finiteCny(input.dailyLimitCny)) throw new Error('MODEL_COST_BUDGET_INPUT_INVALID')
    const date = budgetDate(input.at)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await client.query(budgetLockSql, [workspaceId, date])
      const existingResult = await client.query<BudgetRow>(`SELECT ${budgetProjection} FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE`, [workspaceId, input.reservationKey])
      const existing = existingResult.rows[0] ? mapBudget(existingResult.rows[0]) : undefined
      if (existing && !sameBudgetIntent(existing, { ...input, budgetDate: date })) throw new Error('MODEL_COST_BUDGET_IDEMPOTENCY_CONFLICT')
      const totals = await client.query<{ used_cny: number | string; reserved_cny: number | string }>(budgetTotalsSql, [workspaceId, date, input.reservationKey])
      const snapshot: ModelCostBudgetSnapshot = { usedCny: Number(totals.rows[0]?.used_cny ?? 0), reservedCny: Number(totals.rows[0]?.reserved_cny ?? 0), requestCny: input.estimateCny, limitCny: input.dailyLimitCny }
      if (existing && existing.status !== 'released') return { reservation: existing, snapshot, reused: true }
      if (snapshot.usedCny + snapshot.reservedCny + input.estimateCny > input.dailyLimitCny) throw new ModelCostBudgetExceededError(snapshot)
      const row = existing
        ? await client.query<BudgetRow>(`UPDATE model_cost_budget_reservations SET status='active',actual_cost_cny=NULL,provider_request_id=NULL,revision=revision+1,updated_at=$3 WHERE workspace_id=$1 AND reservation_key=$2 RETURNING ${budgetProjection}`, [workspaceId, input.reservationKey, input.at ?? now()])
        : await client.query<BudgetRow>(`INSERT INTO model_cost_budget_reservations (workspace_id,budget_date,reservation_key,modality,model,estimate_cny,estimate_version,daily_limit_cny,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$9) RETURNING ${budgetProjection}`, [workspaceId, date, input.reservationKey, input.modality, input.model, input.estimateCny, input.estimateVersion, input.dailyLimitCny, input.at ?? now()])
      return { reservation: mapBudget(row.rows[0]!), snapshot, reused: false }
    })
  }
  async settleDailyBudget(input: { workspaceId: string; reservationKey: string; actualCostCny: number; providerRequestId?: string; at?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId); if (!finiteCny(input.actualCostCny, true)) throw new Error('MODEL_COST_BUDGET_ACTUAL_INVALID')
    const outcome = await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const dateResult = await client.query<{ budget_date: string }>('SELECT budget_date::text AS budget_date FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, input.reservationKey])
      const date = dateResult.rows[0] ? iso(dateResult.rows[0].budget_date).slice(0, 10) : undefined; if (!date) throw new Error('MODEL_COST_BUDGET_RESERVATION_NOT_FOUND')
      await client.query(budgetLockSql, [workspaceId, date])
      const found = await client.query<BudgetRow>(`SELECT ${budgetProjection} FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE`, [workspaceId, input.reservationKey])
      const current = found.rows[0] ? mapBudget(found.rows[0]) : undefined; if (!current) throw new Error('MODEL_COST_BUDGET_RESERVATION_NOT_FOUND')
      if (current.status === 'released') throw new Error('MODEL_COST_BUDGET_RESERVATION_RELEASED')
      if ((current.status === 'settled' || current.status === 'over_budget') && current.providerRequestId === input.providerRequestId && current.actualCostCny !== input.actualCostCny) throw new Error('MODEL_COST_BUDGET_SETTLEMENT_CONFLICT')
      if ((current.status === 'settled' || current.status === 'over_budget') && current.providerRequestId !== input.providerRequestId && input.actualCostCny < (current.actualCostCny ?? 0)) throw new Error('MODEL_COST_BUDGET_SETTLEMENT_CONFLICT')
      const totals = await client.query<{ used_cny: number | string; reserved_cny: number | string }>(budgetTotalsSql, [workspaceId, current.budgetDate, current.reservationKey])
      const snapshot: ModelCostBudgetSnapshot = { usedCny: Number(totals.rows[0]?.used_cny ?? 0), reservedCny: Number(totals.rows[0]?.reserved_cny ?? 0), requestCny: input.actualCostCny, limitCny: current.dailyLimitCny }
      const exceeded = snapshot.usedCny + snapshot.reservedCny + input.actualCostCny > current.dailyLimitCny
      if ((current.status === 'settled' || current.status === 'over_budget') && current.actualCostCny === input.actualCostCny && current.providerRequestId === input.providerRequestId) return { reservation: current, snapshot, exceeded: current.status === 'over_budget' }
      const updated = await client.query<BudgetRow>(`UPDATE model_cost_budget_reservations SET status=$3,actual_cost_cny=$4,provider_request_id=$5,revision=revision+1,updated_at=$6 WHERE workspace_id=$1 AND reservation_key=$2 RETURNING ${budgetProjection}`, [workspaceId, input.reservationKey, exceeded ? 'over_budget' : 'settled', input.actualCostCny, input.providerRequestId ?? null, input.at ?? now()])
      return { reservation: mapBudget(updated.rows[0]!), snapshot, exceeded }
    })
    if (outcome.exceeded) throw new ModelCostBudgetActualExceededError(outcome.snapshot)
    return { reservation: outcome.reservation, snapshot: outcome.snapshot }
  }
  async releaseDailyBudget(input: { workspaceId: string; reservationKey: string; at?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const dateResult = await client.query<{ budget_date: string }>('SELECT budget_date::text AS budget_date FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, input.reservationKey])
      const date = dateResult.rows[0] ? iso(dateResult.rows[0].budget_date).slice(0, 10) : undefined; if (!date) return undefined
      await client.query(budgetLockSql, [workspaceId, date])
      const found = await client.query<BudgetRow>(`SELECT ${budgetProjection} FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE`, [workspaceId, input.reservationKey])
      const current = found.rows[0] ? mapBudget(found.rows[0]) : undefined; if (!current || current.status !== 'active') return current
      const updated = await client.query<BudgetRow>(`UPDATE model_cost_budget_reservations SET status='released',revision=revision+1,updated_at=$3 WHERE workspace_id=$1 AND reservation_key=$2 RETURNING ${budgetProjection}`, [workspaceId, input.reservationKey, input.at ?? now()])
      return mapBudget(updated.rows[0]!)
    })
  }
}
