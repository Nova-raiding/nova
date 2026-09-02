import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type WorkspaceDataExportStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'expired'

export interface WorkspaceDataExportRequest {
  id: string
  workspaceId: string
  requestedBy: string
  reason: string
  status: WorkspaceDataExportStatus
  requestedAt: string
  updatedAt: string
  artifactRef?: string
  artifactSha256?: string
  artifactSizeBytes?: number
  artifactExpiresAt?: string
  deliveryEvidenceRef?: string
  failureCode?: string
}

export interface RequestWorkspaceDataExportInput {
  workspaceId: string
  requestedBy: string
  reason: string
  idempotencyKey: string
}

export interface CompleteWorkspaceDataExportInput {
  workspaceId: string
  id: string
  workerId: string
  artifactRef: string
  artifactSha256: string
  artifactSizeBytes: number
  artifactExpiresAt: string
  deliveryEvidenceRef: string
}

export interface WorkspaceDataExportRepository {
  request(input: RequestWorkspaceDataExportInput): Promise<WorkspaceDataExportRequest>
  get(workspaceId: string, id: string): Promise<WorkspaceDataExportRequest | undefined>
  markProcessing(input: { workspaceId: string; id: string; workerId: string }): Promise<WorkspaceDataExportRequest>
  complete(input: CompleteWorkspaceDataExportInput): Promise<WorkspaceDataExportRequest>
  fail(input: { workspaceId: string; id: string; workerId: string; failureCode: string }): Promise<WorkspaceDataExportRequest>
}

export class WorkspaceDataExportIdempotencyConflictError extends Error {
  readonly code = 'WORKSPACE_DATA_EXPORT_IDEMPOTENCY_CONFLICT'
  constructor() { super('workspace data export idempotency key is already bound to a different request') }
}

function required(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(code)
  return normalized
}

function requestHash(input: Pick<RequestWorkspaceDataExportInput, 'requestedBy' | 'reason'>): string {
  return createHash('sha256').update(JSON.stringify({ requestedBy: required(input.requestedBy, 'WORKSPACE_DATA_EXPORT_ACTOR_REQUIRED'), reason: required(input.reason, 'WORKSPACE_DATA_EXPORT_REASON_REQUIRED') })).digest('hex')
}

function assertCompletion(input: CompleteWorkspaceDataExportInput): void {
  required(input.workerId, 'WORKSPACE_DATA_EXPORT_WORKER_REQUIRED')
  if (!/^workspace-export:\/\/[A-Za-z0-9._~/-]+$/u.test(required(input.artifactRef, 'WORKSPACE_DATA_EXPORT_ARTIFACT_REQUIRED'))) throw new Error('WORKSPACE_DATA_EXPORT_ARTIFACT_REF_INVALID')
  required(input.deliveryEvidenceRef, 'WORKSPACE_DATA_EXPORT_DELIVERY_EVIDENCE_REQUIRED')
  if (!/^[a-f0-9]{64}$/u.test(input.artifactSha256)) throw new Error('WORKSPACE_DATA_EXPORT_CHECKSUM_INVALID')
  if (!Number.isSafeInteger(input.artifactSizeBytes) || input.artifactSizeBytes < 1) throw new Error('WORKSPACE_DATA_EXPORT_SIZE_INVALID')
  if (!Number.isFinite(Date.parse(input.artifactExpiresAt))) throw new Error('WORKSPACE_DATA_EXPORT_EXPIRY_INVALID')
}

export class MemoryWorkspaceDataExportRepository implements WorkspaceDataExportRepository {
  private readonly rows = new Map<string, WorkspaceDataExportRequest>()
  private readonly idempotency = new Map<string, { requestHash: string; id: string }>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  async request(input: RequestWorkspaceDataExportInput): Promise<WorkspaceDataExportRequest> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const idempotencyKey = required(input.idempotencyKey, 'WORKSPACE_DATA_EXPORT_IDEMPOTENCY_REQUIRED')
    const intent = requestHash(input)
    const key = `${workspaceId}\u0000${idempotencyKey}`
    const existing = this.idempotency.get(key)
    if (existing) {
      if (existing.requestHash !== intent) throw new WorkspaceDataExportIdempotencyConflictError()
      return { ...this.rows.get(existing.id)! }
    }
    const timestamp = this.now().toISOString()
    const row: WorkspaceDataExportRequest = {
      id: `workspace_export_${randomUUID()}`,
      workspaceId,
      requestedBy: required(input.requestedBy, 'WORKSPACE_DATA_EXPORT_ACTOR_REQUIRED'),
      reason: required(input.reason, 'WORKSPACE_DATA_EXPORT_REASON_REQUIRED'),
      status: 'pending',
      requestedAt: timestamp,
      updatedAt: timestamp,
    }
    this.rows.set(row.id, row)
    this.idempotency.set(key, { requestHash: intent, id: row.id })
    return { ...row }
  }

  async get(workspaceId: string, id: string): Promise<WorkspaceDataExportRequest | undefined> {
    const row = this.rows.get(required(id, 'WORKSPACE_DATA_EXPORT_ID_REQUIRED'))
    return row?.workspaceId === requireWorkspaceScope(workspaceId) ? { ...row } : undefined
  }

  async markProcessing(input: { workspaceId: string; id: string; workerId: string }): Promise<WorkspaceDataExportRequest> {
    required(input.workerId, 'WORKSPACE_DATA_EXPORT_WORKER_REQUIRED')
    return this.transition(input.workspaceId, input.id, ['pending'], { status: 'processing' })
  }

  async complete(input: CompleteWorkspaceDataExportInput): Promise<WorkspaceDataExportRequest> {
    assertCompletion(input)
    if (Date.parse(input.artifactExpiresAt) <= this.now().getTime()) throw new Error('WORKSPACE_DATA_EXPORT_EXPIRY_INVALID')
    return this.transition(input.workspaceId, input.id, ['processing'], {
      status: 'ready',
      artifactRef: input.artifactRef.trim(),
      artifactSha256: input.artifactSha256,
      artifactSizeBytes: input.artifactSizeBytes,
      artifactExpiresAt: input.artifactExpiresAt,
      deliveryEvidenceRef: input.deliveryEvidenceRef.trim(),
    })
  }

  async fail(input: { workspaceId: string; id: string; workerId: string; failureCode: string }): Promise<WorkspaceDataExportRequest> {
    required(input.workerId, 'WORKSPACE_DATA_EXPORT_WORKER_REQUIRED')
    return this.transition(input.workspaceId, input.id, ['pending', 'processing'], { status: 'failed', failureCode: required(input.failureCode, 'WORKSPACE_DATA_EXPORT_FAILURE_CODE_REQUIRED') })
  }

  private async transition(workspaceId: string, id: string, allowed: WorkspaceDataExportStatus[], patch: Partial<WorkspaceDataExportRequest>): Promise<WorkspaceDataExportRequest> {
    const row = await this.get(workspaceId, id)
    if (!row) throw new Error('WORKSPACE_DATA_EXPORT_NOT_FOUND')
    if (!allowed.includes(row.status)) throw new Error('WORKSPACE_DATA_EXPORT_STATE_CONFLICT')
    const updated = { ...row, ...patch, updatedAt: this.now().toISOString() }
    this.rows.set(row.id, updated)
    return { ...updated }
  }
}

type ExportRow = {
  id: string
  workspaceId: string
  requestedBy: string
  reason: string
  status: WorkspaceDataExportStatus
  requestedAt: string | Date
  updatedAt: string | Date
  artifactRef: string | null
  artifactSha256: string | null
  artifactSizeBytes: number | null
  artifactExpiresAt: string | Date | null
  deliveryEvidenceRef: string | null
  failureCode: string | null
}

const projection = `id, workspace_id AS "workspaceId", requested_by AS "requestedBy", reason, status,
  requested_at AS "requestedAt", updated_at AS "updatedAt", artifact_ref AS "artifactRef",
  artifact_sha256 AS "artifactSha256", artifact_size_bytes AS "artifactSizeBytes",
  artifact_expires_at AS "artifactExpiresAt", delivery_evidence_ref AS "deliveryEvidenceRef",
  failure_code AS "failureCode"`

function mapRow(row: ExportRow): WorkspaceDataExportRequest {
  const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    requestedBy: row.requestedBy,
    reason: row.reason,
    status: row.status,
    requestedAt: iso(row.requestedAt),
    updatedAt: iso(row.updatedAt),
    ...(row.artifactRef ? { artifactRef: row.artifactRef } : {}),
    ...(row.artifactSha256 ? { artifactSha256: row.artifactSha256 } : {}),
    ...(row.artifactSizeBytes == null ? {} : { artifactSizeBytes: Number(row.artifactSizeBytes) }),
    ...(row.artifactExpiresAt ? { artifactExpiresAt: iso(row.artifactExpiresAt) } : {}),
    ...(row.deliveryEvidenceRef ? { deliveryEvidenceRef: row.deliveryEvidenceRef } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  }
}

export class PostgresWorkspaceDataExportRepository implements WorkspaceDataExportRepository {
  constructor(private readonly pool: SqlPool) {}

  async request(input: RequestWorkspaceDataExportInput): Promise<WorkspaceDataExportRequest> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const requestedBy = required(input.requestedBy, 'WORKSPACE_DATA_EXPORT_ACTOR_REQUIRED')
    const reason = required(input.reason, 'WORKSPACE_DATA_EXPORT_REASON_REQUIRED')
    const idempotencyKey = required(input.idempotencyKey, 'WORKSPACE_DATA_EXPORT_IDEMPOTENCY_REQUIRED')
    const intent = requestHash({ requestedBy, reason })
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const inserted = await client.query<ExportRow>(`INSERT INTO workspace_data_export_requests (id, workspace_id, requested_by, reason, idempotency_key, request_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING ${projection}`, [randomUUID(), workspaceId, requestedBy, reason, idempotencyKey, intent])
      if (inserted.rows[0]) return mapRow(inserted.rows[0])
      const existing = await client.query<ExportRow & { requestHash: string }>(`SELECT ${projection}, request_hash AS "requestHash" FROM workspace_data_export_requests WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, idempotencyKey])
      if (!existing.rows[0] || existing.rows[0].requestHash !== intent) throw new WorkspaceDataExportIdempotencyConflictError()
      return mapRow(existing.rows[0])
    })
  }

  async get(workspaceId: string, id: string): Promise<WorkspaceDataExportRequest | undefined> {
    requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<ExportRow>(`SELECT ${projection} FROM workspace_data_export_requests WHERE workspace_id=$1 AND id=$2`, [workspaceId, required(id, 'WORKSPACE_DATA_EXPORT_ID_REQUIRED')])
      return result.rows[0] ? mapRow(result.rows[0]) : undefined
    })
  }

  async markProcessing(input: { workspaceId: string; id: string; workerId: string }): Promise<WorkspaceDataExportRequest> {
    required(input.workerId, 'WORKSPACE_DATA_EXPORT_WORKER_REQUIRED')
    return this.update(input.workspaceId, input.id, `status='processing', processing_by=$3, processing_at=now(), updated_at=now()`, [input.workerId.trim()], `status='pending'`)
  }

  async complete(input: CompleteWorkspaceDataExportInput): Promise<WorkspaceDataExportRequest> {
    assertCompletion(input)
    return this.update(input.workspaceId, input.id, `status='ready', completed_by=$3, completed_at=now(), artifact_ref=$4, artifact_sha256=$5, artifact_size_bytes=$6, artifact_expires_at=$7, delivery_evidence_ref=$8, updated_at=now()`, [input.workerId.trim(), input.artifactRef.trim(), input.artifactSha256, input.artifactSizeBytes, input.artifactExpiresAt, input.deliveryEvidenceRef.trim()], `status='processing' AND $7::timestamptz > now()`)
  }

  async fail(input: { workspaceId: string; id: string; workerId: string; failureCode: string }): Promise<WorkspaceDataExportRequest> {
    return this.update(input.workspaceId, input.id, `status='failed', completed_by=$3, completed_at=now(), failure_code=$4, updated_at=now()`, [required(input.workerId, 'WORKSPACE_DATA_EXPORT_WORKER_REQUIRED'), required(input.failureCode, 'WORKSPACE_DATA_EXPORT_FAILURE_CODE_REQUIRED')], `status IN ('pending','processing')`)
  }

  private async update(workspaceId: string, id: string, setSql: string, extra: unknown[], guard: string): Promise<WorkspaceDataExportRequest> {
    requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<ExportRow>(`UPDATE workspace_data_export_requests SET ${setSql} WHERE workspace_id=$1 AND id=$2 AND ${guard} RETURNING ${projection}`, [workspaceId, required(id, 'WORKSPACE_DATA_EXPORT_ID_REQUIRED'), ...extra])
      if (!result.rows[0]) throw new Error('WORKSPACE_DATA_EXPORT_NOT_FOUND_OR_STATE_CONFLICT')
      return mapRow(result.rows[0])
    })
  }
}
