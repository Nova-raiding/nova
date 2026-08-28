import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ModelUsageModality = 'text' | 'image' | 'image_edit' | 'ocr' | 'video'
export type ModelSettlementStatus = 'pending_cost' | 'pending_wallet' | 'settled' | 'manual_attention' | 'waived'
export interface ModelUsageRecord {
  id: string
  workspaceId: string
  receiptKey: string
  receiptHash: string
  actionId?: string
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
  claimPending(input: { workspaceId: string; owner: string; limit?: number; leaseSeconds?: number; now?: string }): Promise<ModelUsageRecord[]>
  resolve(input: { workspaceId: string; id: string; expectedRevision: number; status: ModelSettlementStatus; actorId: string; reason: string; evidenceRef?: string; costCny?: number; markupMultiplier?: number; customerChargeCny?: number; pricingPolicyRevision?: number; lastError?: Record<string, unknown>; nextAttemptAt?: string }): Promise<ModelUsageRecord>
}

const now = () => new Date().toISOString()
const stableReceiptKey = (input: Pick<ModelUsageRecordInput, 'workspaceId' | 'actionId' | 'modality' | 'model' | 'providerRequestId' | 'receiptKey'>) => input.receiptKey?.trim() || input.providerRequestId?.trim() || `relay_usage_${createHash('sha256').update(JSON.stringify([input.workspaceId, input.actionId ?? '', input.modality, input.model])).digest('hex')}`
const stableReceiptHash = (input: Pick<ModelUsageRecordInput, 'workspaceId' | 'actionId' | 'modality' | 'model' | 'providerRequestId' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'receiptHash'>, key: string) => input.receiptHash?.trim() || createHash('sha256').update(JSON.stringify([input.workspaceId, key, input.actionId ?? '', input.modality, input.model, input.providerRequestId ?? '', input.inputTokens ?? null, input.outputTokens ?? null, input.totalTokens ?? null])).digest('hex')
const validateStatus = (status: ModelSettlementStatus) => { if (!['pending_cost', 'pending_wallet', 'settled', 'manual_attention', 'waived'].includes(status)) throw new Error('MODEL_USAGE_SETTLEMENT_STATUS_INVALID') }

export class MemoryModelUsageRepository implements ModelUsageRepository {
  private readonly rows: ModelUsageRecord[] = []
  async record(input: ModelUsageRecordInput) {
    if (!input.workspaceId.trim()) throw new Error('MODEL_USAGE_WORKSPACE_REQUIRED')
    const receiptKey = stableReceiptKey(input); const receiptHash = stableReceiptHash(input, receiptKey)
    const existing = this.rows.find(row => row.workspaceId === input.workspaceId && (row.receiptKey === receiptKey || Boolean(input.providerRequestId && row.providerRequestId === input.providerRequestId)))
    if (existing) {
      if (existing.receiptHash !== receiptHash) throw new Error('MODEL_USAGE_IDEMPOTENCY_CONFLICT')
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
  async claimPending(input: { workspaceId: string; owner: string; limit?: number; leaseSeconds?: number; now?: string }) {
    const at = input.now ?? now(); const expires = new Date(Date.parse(at) + (input.leaseSeconds ?? 60) * 1000).toISOString()
    return this.rows.filter(row => row.workspaceId === input.workspaceId && ['pending_cost', 'pending_wallet'].includes(row.settlementStatus) && (!row.nextAttemptAt || row.nextAttemptAt <= at) && (!row.claimExpiresAt || row.claimExpiresAt <= at)).slice(0, input.limit ?? 50).map(row => { Object.assign(row, { claimOwner: input.owner, claimExpiresAt: expires, attemptCount: row.attemptCount + 1, revision: row.revision + 1 }); return row })
  }
  async resolve(input: { workspaceId: string; id: string; expectedRevision: number; status: ModelSettlementStatus; actorId: string; reason: string; evidenceRef?: string; costCny?: number; markupMultiplier?: number; customerChargeCny?: number; pricingPolicyRevision?: number; lastError?: Record<string, unknown>; nextAttemptAt?: string }) {
    validateStatus(input.status); const row = this.rows.find(item => item.workspaceId === input.workspaceId && item.id === input.id); if (!row) throw new Error('MODEL_USAGE_NOT_FOUND'); if (row.revision !== input.expectedRevision) throw new Error('MODEL_USAGE_REVISION_CONFLICT')
    if ((input.status === 'settled' || input.status === 'waived') && !input.reason.trim()) throw new Error('MODEL_USAGE_RESOLUTION_REASON_REQUIRED')
    Object.assign(row, { settlementStatus: input.status, costCny: input.costCny ?? row.costCny, markupMultiplier: input.markupMultiplier ?? row.markupMultiplier, customerChargeCny: input.customerChargeCny ?? row.customerChargeCny, pricingPolicyRevision: input.pricingPolicyRevision ?? row.pricingPolicyRevision, lastError: input.lastError, nextAttemptAt: input.nextAttemptAt, claimOwner: undefined, claimExpiresAt: undefined, resolvedBy: ['settled', 'manual_attention', 'waived'].includes(input.status) ? input.actorId : undefined, resolutionReason: ['settled', 'manual_attention', 'waived'].includes(input.status) ? input.reason : undefined, resolutionEvidenceRef: input.evidenceRef, resolvedAt: ['settled', 'manual_attention', 'waived'].includes(input.status) ? now() : undefined, revision: row.revision + 1 }); return row
  }
}

type UsageRow = { id: string; workspace_id: string; receipt_key: string; receipt_hash: string; action_id: string | null; modality: ModelUsageModality; model: string; provider_request_id: string | null; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cost_cny: number | null; markup_multiplier: number | null; customer_charge_cny: number | null; pricing_policy_revision: number | null; settlement_status: ModelSettlementStatus; attempt_count: number; last_error: Record<string, unknown> | null; next_attempt_at: string | Date | null; claim_owner: string | null; claim_expires_at: string | Date | null; revision: number; resolved_by: string | null; resolution_reason: string | null; resolution_evidence_ref: string | null; resolved_at: string | Date | null; observed_at: string | Date; metadata: Record<string, unknown> | null }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const projection = 'id, workspace_id, receipt_key, receipt_hash, action_id, modality, model, provider_request_id, input_tokens, output_tokens, total_tokens, cost_cny, markup_multiplier, customer_charge_cny, pricing_policy_revision, settlement_status, attempt_count, last_error, next_attempt_at, claim_owner, claim_expires_at, revision, resolved_by, resolution_reason, resolution_evidence_ref, resolved_at, observed_at, metadata'
const map = (row: UsageRow): ModelUsageRecord => ({ id: row.id, workspaceId: row.workspace_id, receiptKey: row.receipt_key, receiptHash: row.receipt_hash, ...(row.action_id ? { actionId: row.action_id } : {}), modality: row.modality, model: row.model, ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}), ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}), ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}), ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}), ...(row.cost_cny !== null ? { costCny: Number(row.cost_cny) } : {}), ...(row.markup_multiplier !== null ? { markupMultiplier: Number(row.markup_multiplier) } : {}), ...(row.customer_charge_cny !== null ? { customerChargeCny: Number(row.customer_charge_cny) } : {}), ...(row.pricing_policy_revision !== null ? { pricingPolicyRevision: row.pricing_policy_revision } : {}), settlementStatus: row.settlement_status, attemptCount: row.attempt_count, ...(row.last_error ? { lastError: row.last_error } : {}), ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}), ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}), ...(row.claim_expires_at ? { claimExpiresAt: iso(row.claim_expires_at) } : {}), revision: row.revision, ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}), ...(row.resolution_reason ? { resolutionReason: row.resolution_reason } : {}), ...(row.resolution_evidence_ref ? { resolutionEvidenceRef: row.resolution_evidence_ref } : {}), ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}), observedAt: iso(row.observed_at), ...(row.metadata ? { metadata: row.metadata } : {}) })

export class PostgresModelUsageRepository implements ModelUsageRepository {
  constructor(private readonly pool: SqlPool) {}
  async record(input: ModelUsageRecordInput) {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const receiptKey = stableReceiptKey(input); const receiptHash = stableReceiptHash(input, receiptKey); const status = input.settlementStatus ?? (input.costCny === undefined ? 'pending_cost' : 'settled'); validateStatus(status)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const found = await client.query<UsageRow>(`SELECT ${projection} FROM model_usage_ledger WHERE workspace_id=$1 AND (receipt_key=$2 OR ($3::text IS NOT NULL AND provider_request_id=$3)) FOR UPDATE`, [workspaceId, receiptKey, input.providerRequestId ?? null])
      if (found.rows[0]) {
        const existing = map(found.rows[0]); if (existing.receiptHash !== receiptHash) throw new Error('MODEL_USAGE_IDEMPOTENCY_CONFLICT')
        if (existing.costCny === undefined && input.costCny !== undefined) { const updated = await client.query<UsageRow>(`UPDATE model_usage_ledger SET cost_cny=$3, markup_multiplier=$4, customer_charge_cny=$5, pricing_policy_revision=$6, settlement_status=$7, last_error=$8, next_attempt_at=$9, revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING ${projection}`, [workspaceId, existing.id, input.costCny, input.markupMultiplier ?? null, input.customerChargeCny ?? null, input.pricingPolicyRevision ?? null, input.settlementStatus ?? 'pending_wallet', input.lastError ?? null, input.nextAttemptAt ?? now()]); return map(updated.rows[0]!) }
        return existing
      }
      const inserted = await client.query<UsageRow>(`INSERT INTO model_usage_ledger (id,workspace_id,receipt_key,receipt_hash,action_id,modality,model,provider_request_id,input_tokens,output_tokens,total_tokens,cost_cny,markup_multiplier,customer_charge_cny,pricing_policy_revision,settlement_status,attempt_count,last_error,next_attempt_at,observed_at,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING ${projection}`, [randomUUID(), workspaceId, receiptKey, receiptHash, input.actionId ?? null, input.modality, input.model, input.providerRequestId ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.totalTokens ?? null, input.costCny ?? null, input.markupMultiplier ?? null, input.customerChargeCny ?? null, input.pricingPolicyRevision ?? null, status, input.attemptCount ?? 0, input.lastError ?? null, input.nextAttemptAt ?? (status.startsWith('pending_') ? now() : null), input.observedAt ?? now(), input.metadata ?? null]); return map(inserted.rows[0]!)
    })
  }
  async list(workspaceId: string, limit = 100) { return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => (await client.query<UsageRow>(`SELECT ${projection} FROM model_usage_ledger WHERE workspace_id=$1 ORDER BY observed_at DESC,id DESC LIMIT $2`, [workspaceId, Math.min(1000, Math.max(1, limit))])).rows.map(map)) }
  async claimPending(input: { workspaceId: string; owner: string; limit?: number; leaseSeconds?: number; now?: string }) { const workspaceId = requireWorkspaceScope(input.workspaceId); const at = input.now ?? now(); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<UsageRow>(`WITH claimed AS (SELECT id FROM model_usage_ledger WHERE workspace_id=$1 AND settlement_status IN ('pending_cost','pending_wallet') AND COALESCE(next_attempt_at,observed_at)<=$2 AND (claim_expires_at IS NULL OR claim_expires_at<=$2) ORDER BY observed_at,id FOR UPDATE SKIP LOCKED LIMIT $3) UPDATE model_usage_ledger m SET claim_owner=$4, claim_expires_at=$2::timestamptz + ($5::text || ' seconds')::interval, attempt_count=m.attempt_count+1, revision=m.revision+1 FROM claimed WHERE m.id=claimed.id RETURNING ${projection.split(', ').map(value => `m.${value}`).join(', ')}`, [workspaceId, at, input.limit ?? 50, input.owner, input.leaseSeconds ?? 60])).rows.map(map)) }
  async resolve(input: { workspaceId: string; id: string; expectedRevision: number; status: ModelSettlementStatus; actorId: string; reason: string; evidenceRef?: string; costCny?: number; markupMultiplier?: number; customerChargeCny?: number; pricingPolicyRevision?: number; lastError?: Record<string, unknown>; nextAttemptAt?: string }) { validateStatus(input.status); const terminal = ['settled', 'manual_attention', 'waived'].includes(input.status); return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => { const result = await client.query<UsageRow>(`UPDATE model_usage_ledger SET settlement_status=$4,cost_cny=COALESCE($5,cost_cny),markup_multiplier=COALESCE($6,markup_multiplier),customer_charge_cny=COALESCE($7,customer_charge_cny),pricing_policy_revision=COALESCE($8,pricing_policy_revision),last_error=$9,next_attempt_at=$10,claim_owner=NULL,claim_expires_at=NULL,resolved_by=CASE WHEN $11 THEN $12 ELSE NULL END,resolution_reason=CASE WHEN $11 THEN $13 ELSE NULL END,resolution_evidence_ref=CASE WHEN $11 THEN $14 ELSE NULL END,resolved_at=CASE WHEN $11 THEN now() ELSE NULL END,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING ${projection}`, [input.workspaceId, input.id, input.expectedRevision, input.status, input.costCny ?? null, input.markupMultiplier ?? null, input.customerChargeCny ?? null, input.pricingPolicyRevision ?? null, input.lastError ?? null, input.nextAttemptAt ?? null, terminal, input.actorId, input.reason, input.evidenceRef ?? null]); if (!result.rows[0]) { const exists = await client.query('SELECT 1 FROM model_usage_ledger WHERE workspace_id=$1 AND id=$2', [input.workspaceId, input.id]); throw new Error(exists.rows[0] ? 'MODEL_USAGE_REVISION_CONFLICT' : 'MODEL_USAGE_NOT_FOUND') } return map(result.rows[0]) }) }
}
