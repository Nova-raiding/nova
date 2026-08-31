import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

/** The provider observation is deliberately narrower than a provider's API. */
export type ReconciliationEvidenceState = 'processing' | 'succeeded' | 'failed' | 'unknown'

export interface ReconciliationEvidence {
  id: string
  workspaceId: string
  jobId: string
  executionAttempt: number
  providerRequestId: string
  queryAttempt: number
  idempotencyKey: string
  providerState: ReconciliationEvidenceState
  providerStatus?: string
  responseDigest?: string
  artifactDigest?: string
  usageLedgerId?: string
  actionLedgerId?: string
  usage?: Record<string, unknown>
  cost?: Record<string, unknown>
  observedAt: string
  nextAttemptAt?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
}

export interface ReconciliationEvidenceRepository {
  append(input: Omit<ReconciliationEvidence, 'id' | 'createdAt'>): Promise<ReconciliationEvidence>
  getByIdempotencyKey(input: { workspaceId: string; idempotencyKey: string }): Promise<ReconciliationEvidence | undefined>
  getLatest(input: { workspaceId: string; jobId: string }): Promise<ReconciliationEvidence | undefined>
  list(input: { workspaceId: string; jobId?: string; providerRequestId?: string; limit?: number }): Promise<ReconciliationEvidence[]>
}

const text = (value: string, code: string, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code)
  return value.trim()
}
const workspace = (value: string) => text(requireWorkspaceScope(value), 'RECONCILIATION_EVIDENCE_WORKSPACE_ID_REQUIRED', 255)
const instant = (value: string, code: string) => {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code)
  return value
}
const digest = (value: string | undefined, code: string) => value === undefined ? undefined : text(value, code, 128)
const limitValue = (value: number | undefined) => {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('RECONCILIATION_EVIDENCE_LIMIT_INVALID')
  return limit
}
const validate = (input: Omit<ReconciliationEvidence, 'id' | 'createdAt'>) => {
  if (!Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 1) throw new RangeError('RECONCILIATION_EVIDENCE_EXECUTION_ATTEMPT_INVALID')
  if (!Number.isSafeInteger(input.queryAttempt) || input.queryAttempt < 1) throw new RangeError('RECONCILIATION_EVIDENCE_QUERY_ATTEMPT_INVALID')
  if (!['processing', 'succeeded', 'failed', 'unknown'].includes(input.providerState)) throw new Error('RECONCILIATION_EVIDENCE_STATE_INVALID')
  const value = {
    workspaceId: workspace(input.workspaceId), jobId: text(input.jobId, 'RECONCILIATION_EVIDENCE_JOB_ID_REQUIRED', 255),
    executionAttempt: input.executionAttempt, providerRequestId: text(input.providerRequestId, 'RECONCILIATION_EVIDENCE_PROVIDER_REQUEST_ID_REQUIRED'),
    queryAttempt: input.queryAttempt, idempotencyKey: text(input.idempotencyKey, 'RECONCILIATION_EVIDENCE_IDEMPOTENCY_KEY_REQUIRED'),
    providerState: input.providerState, providerStatus: input.providerStatus === undefined ? undefined : text(input.providerStatus, 'RECONCILIATION_EVIDENCE_PROVIDER_STATUS_INVALID'),
    responseDigest: digest(input.responseDigest, 'RECONCILIATION_EVIDENCE_RESPONSE_DIGEST_INVALID'), artifactDigest: digest(input.artifactDigest, 'RECONCILIATION_EVIDENCE_ARTIFACT_DIGEST_INVALID'),
    usageLedgerId: input.usageLedgerId === undefined ? undefined : text(input.usageLedgerId, 'RECONCILIATION_EVIDENCE_USAGE_LEDGER_ID_INVALID'),
    actionLedgerId: input.actionLedgerId === undefined ? undefined : text(input.actionLedgerId, 'RECONCILIATION_EVIDENCE_ACTION_LEDGER_ID_INVALID'),
    usage: input.usage === undefined ? undefined : structuredClone(input.usage), cost: input.cost === undefined ? undefined : structuredClone(input.cost),
    observedAt: instant(input.observedAt, 'RECONCILIATION_EVIDENCE_OBSERVED_AT_INVALID'), nextAttemptAt: input.nextAttemptAt === undefined ? undefined : instant(input.nextAttemptAt, 'RECONCILIATION_EVIDENCE_NEXT_ATTEMPT_AT_INVALID'),
    errorCode: input.errorCode === undefined ? undefined : text(input.errorCode, 'RECONCILIATION_EVIDENCE_ERROR_CODE_INVALID'), errorMessage: input.errorMessage === undefined ? undefined : text(input.errorMessage, 'RECONCILIATION_EVIDENCE_ERROR_MESSAGE_INVALID'),
  }
  if (['failed', 'unknown'].includes(value.providerState) && (!value.errorCode || !value.errorMessage)) throw new Error('RECONCILIATION_EVIDENCE_FAILURE_DETAILS_REQUIRED')
  if (['processing', 'succeeded'].includes(value.providerState) && (value.errorCode || value.errorMessage)) throw new Error('RECONCILIATION_EVIDENCE_ERROR_DETAILS_UNEXPECTED')
  return value
}
const keyOf = (workspaceId: string, idempotencyKey: string) => `${workspaceId}\0${idempotencyKey}`
const comparable = (row: ReconciliationEvidence) => JSON.stringify({ ...row, id: undefined, createdAt: undefined })

export class ReconciliationEvidenceIdempotencyConflictError extends Error {
  constructor() { super('RECONCILIATION_EVIDENCE_IDEMPOTENCY_CONFLICT'); this.name = 'ReconciliationEvidenceIdempotencyConflictError' }
}

export class MemoryReconciliationEvidenceRepository implements ReconciliationEvidenceRepository {
  private readonly rows = new Map<string, ReconciliationEvidence>()
  async append(input: Omit<ReconciliationEvidence, 'id' | 'createdAt'>) {
    const workspaceId = workspace(input.workspaceId); const idempotencyKey = text(input.idempotencyKey, 'RECONCILIATION_EVIDENCE_IDEMPOTENCY_KEY_REQUIRED'); const current = this.rows.get(keyOf(workspaceId, idempotencyKey))
    // Resolve an existing idempotency key before validating the new payload so
    // any changed replay is reported as a conflict, never as a new state.
    if (current) { if (comparable(current) !== JSON.stringify(input)) throw new ReconciliationEvidenceIdempotencyConflictError(); return structuredClone(current) }
    const value = validate(input); const key = keyOf(value.workspaceId, value.idempotencyKey)
    const row: ReconciliationEvidence = { ...value, id: `recon_evidence_${randomUUID()}`, createdAt: new Date().toISOString() }
    this.rows.set(key, row); return structuredClone(row)
  }
  async getByIdempotencyKey(input: { workspaceId: string; idempotencyKey: string }) { return structuredClone(this.rows.get(keyOf(workspace(input.workspaceId), text(input.idempotencyKey, 'RECONCILIATION_EVIDENCE_IDEMPOTENCY_KEY_REQUIRED'))) ) }
  async getLatest(input: { workspaceId: string; jobId: string }) {
    const workspaceId = workspace(input.workspaceId); const jobId = text(input.jobId, 'RECONCILIATION_EVIDENCE_JOB_ID_REQUIRED', 255)
    return structuredClone([...this.rows.values()].filter(row => row.workspaceId === workspaceId && row.jobId === jobId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0])
  }
  async list(input: { workspaceId: string; jobId?: string; providerRequestId?: string; limit?: number }) {
    const workspaceId = workspace(input.workspaceId); const limit = limitValue(input.limit)
    return [...this.rows.values()].filter(row => row.workspaceId === workspaceId && (!input.jobId || row.jobId === input.jobId) && (!input.providerRequestId || row.providerRequestId === input.providerRequestId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit).map(row => structuredClone(row))
  }
}

type EvidenceRow = { id: string; workspace_id: string; job_id: string; execution_attempt: number; provider_request_id: string; query_attempt: number; idempotency_key: string; provider_state: ReconciliationEvidenceState; provider_status: string | null; response_digest: string | null; artifact_digest: string | null; usage_ledger_id: string | null; action_ledger_id: string | null; usage: Record<string, unknown> | null; cost: Record<string, unknown> | null; observed_at: string | Date; next_attempt_at: string | Date | null; error_code: string | null; error_message: string | null; created_at: string | Date }
const projection = 'id,workspace_id,job_id,execution_attempt,provider_request_id,query_attempt,idempotency_key,provider_state,provider_status,response_digest,artifact_digest,usage_ledger_id,action_ledger_id,usage,cost,observed_at,next_attempt_at,error_code,error_message,created_at'
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const map = (row: EvidenceRow): ReconciliationEvidence => ({ id: row.id, workspaceId: row.workspace_id, jobId: row.job_id, executionAttempt: row.execution_attempt, providerRequestId: row.provider_request_id, queryAttempt: row.query_attempt, idempotencyKey: row.idempotency_key, providerState: row.provider_state, ...(row.provider_status ? { providerStatus: row.provider_status } : {}), ...(row.response_digest ? { responseDigest: row.response_digest } : {}), ...(row.artifact_digest ? { artifactDigest: row.artifact_digest } : {}), ...(row.usage_ledger_id ? { usageLedgerId: row.usage_ledger_id } : {}), ...(row.action_ledger_id ? { actionLedgerId: row.action_ledger_id } : {}), ...(row.usage ? { usage: row.usage } : {}), ...(row.cost ? { cost: row.cost } : {}), observedAt: iso(row.observed_at), ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_message ? { errorMessage: row.error_message } : {}), createdAt: iso(row.created_at) })

export class PostgresReconciliationEvidenceRepository implements ReconciliationEvidenceRepository {
  constructor(private readonly pool: SqlPool) {}
  async append(input: Omit<ReconciliationEvidence, 'id' | 'createdAt'>) {
    const workspaceId = workspace(input.workspaceId); const idempotencyKey = text(input.idempotencyKey, 'RECONCILIATION_EVIDENCE_IDEMPOTENCY_KEY_REQUIRED')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const existing = await client.query<EvidenceRow>(`SELECT ${projection} FROM reconciliation_evidence WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, idempotencyKey])
      if (existing.rows[0]) { const row = map(existing.rows[0]); if (comparable(row) !== JSON.stringify(input)) throw new ReconciliationEvidenceIdempotencyConflictError(); return row }
      const value = validate(input)
      const result = await client.query<EvidenceRow>(`INSERT INTO reconciliation_evidence (id,workspace_id,job_id,execution_attempt,provider_request_id,query_attempt,idempotency_key,provider_state,provider_status,response_digest,artifact_digest,usage_ledger_id,action_ledger_id,usage,cost,observed_at,next_attempt_at,error_code,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::timestamptz,$17::timestamptz,$18,$19) RETURNING ${projection}`, [randomUUID(), value.workspaceId, value.jobId, value.executionAttempt, value.providerRequestId, value.queryAttempt, value.idempotencyKey, value.providerState, value.providerStatus ?? null, value.responseDigest ?? null, value.artifactDigest ?? null, value.usageLedgerId ?? null, value.actionLedgerId ?? null, value.usage ? JSON.stringify(value.usage) : null, value.cost ? JSON.stringify(value.cost) : null, value.observedAt, value.nextAttemptAt ?? null, value.errorCode ?? null, value.errorMessage ?? null])
      return map(result.rows[0]!)
    })
  }
  async getByIdempotencyKey(input: { workspaceId: string; idempotencyKey: string }) { const workspaceId = workspace(input.workspaceId); const key = text(input.idempotencyKey, 'RECONCILIATION_EVIDENCE_IDEMPOTENCY_KEY_REQUIRED'); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<EvidenceRow>(`SELECT ${projection} FROM reconciliation_evidence WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, key]); return result.rows[0] ? map(result.rows[0]) : undefined }) }
  async getLatest(input: { workspaceId: string; jobId: string }) { const workspaceId = workspace(input.workspaceId); const jobId = text(input.jobId, 'RECONCILIATION_EVIDENCE_JOB_ID_REQUIRED', 255); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<EvidenceRow>(`SELECT ${projection} FROM reconciliation_evidence WHERE workspace_id=$1 AND job_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [workspaceId, jobId]); return result.rows[0] ? map(result.rows[0]) : undefined }) }
  async list(input: { workspaceId: string; jobId?: string; providerRequestId?: string; limit?: number }) { const workspaceId = workspace(input.workspaceId); const limit = limitValue(input.limit); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<EvidenceRow>(`SELECT ${projection} FROM reconciliation_evidence WHERE workspace_id=$1 AND ($2::text IS NULL OR job_id=$2) AND ($3::text IS NULL OR provider_request_id=$3) ORDER BY created_at DESC,id DESC LIMIT $4`, [workspaceId, input.jobId ?? null, input.providerRequestId ?? null, limit]); return result.rows.map(map) }) }
}

export const InMemoryReconciliationEvidenceRepository = MemoryReconciliationEvidenceRepository
