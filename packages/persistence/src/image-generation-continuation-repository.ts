import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ImageContinuationLeaseState = 'available' | 'leased' | 'provider_started' | 'outcome_unknown' | 'completed' | 'failed'

export interface ImageContinuationLease {
  workspaceId: string
  jobId: string
  state: ImageContinuationLeaseState
  attempt: number
  ownerToken?: string
  leaseExpiresAt?: string
  providerStartedAt?: string
  errorCode?: string
  errorMessage?: string
  updatedAt: string
}

export type LeasedImageContinuation = ImageContinuationLease & { state: 'leased'; ownerToken: string; leaseExpiresAt: string }
export type ProviderStartedImageContinuation = ImageContinuationLease & { state: 'provider_started'; ownerToken: string; leaseExpiresAt: string; providerStartedAt: string }
export type OutcomeUnknownImageContinuation = ImageContinuationLease & { state: 'outcome_unknown'; errorCode: string; errorMessage: string }
export type CompletedImageContinuation = ImageContinuationLease & { state: 'completed' }
export type FailedImageContinuation = ImageContinuationLease & { state: 'failed'; errorCode: string; errorMessage: string }

export type ImageContinuationLeaseErrorCode =
  | 'IMAGE_CONTINUATION_EXECUTION_BUSY'
  | 'IMAGE_CONTINUATION_EXECUTION_LEASE_LOST'
  | 'IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN'
  | 'IMAGE_CONTINUATION_EXECUTION_COMPLETED'
  | 'IMAGE_CONTINUATION_EXECUTION_FAILED'

export class ImageContinuationLeaseError extends Error {
  constructor(readonly code: ImageContinuationLeaseErrorCode, readonly lease?: ImageContinuationLease) {
    super(code)
    this.name = 'ImageContinuationLeaseError'
  }
}

export interface ImageContinuationLeaseRepository {
  claim(input: { workspaceId: string; jobId: string; leaseMs: number; now?: string }): Promise<LeasedImageContinuation>
  releaseBeforeProvider(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }): Promise<ImageContinuationLease>
  markProviderStarted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }): Promise<ProviderStartedImageContinuation>
  markOutcomeUnknown(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }): Promise<OutcomeUnknownImageContinuation>
  markCompleted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }): Promise<CompletedImageContinuation>
  markFailed(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }): Promise<FailedImageContinuation>
  get(input: { workspaceId: string; jobId: string }): Promise<ImageContinuationLease | undefined>
}

const MAX_ID_LENGTH = 255
const MAX_LEASE_MS = 24 * 60 * 60 * 1000
const keyOf = (workspaceId: string, jobId: string) => `${workspaceId}\0${jobId}`

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`IMAGE_CONTINUATION_${label}_REQUIRED`)
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new Error(`IMAGE_CONTINUATION_${label}_REQUIRED`)
  return normalized
}

function workspace(value: string) { return identifier(requireWorkspaceScope(value), 'WORKSPACE_ID') }
function instant(value?: string): number {
  if (value === undefined) return Date.now()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new RangeError('image continuation timestamp must be a canonical UTC instant')
  return parsed
}
function leaseDuration(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) throw new RangeError(`leaseMs must be between 1 and ${MAX_LEASE_MS}`)
  return value
}

export class MemoryImageContinuationLeaseRepository implements ImageContinuationLeaseRepository {
  private readonly rows = new Map<string, ImageContinuationLease>()

  async claim(input: { workspaceId: string; jobId: string; leaseMs: number; now?: string }) {
    const workspaceId = workspace(input.workspaceId); const jobId = identifier(input.jobId, 'JOB_ID')
    const now = instant(input.now); const leaseMs = leaseDuration(input.leaseMs); const key = keyOf(workspaceId, jobId)
    const current = this.rows.get(key)
    if (current?.state === 'leased' && Date.parse(current.leaseExpiresAt!) > now) throw new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_BUSY', current)
    if (current?.state === 'provider_started' || current?.state === 'outcome_unknown') throw new ImageContinuationLeaseError('IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN', current)
    if (current?.state === 'completed') throw new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_COMPLETED', current)
    if (current?.state === 'failed') throw new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_FAILED', current)
    const row = Object.freeze({ workspaceId, jobId, state: 'leased' as const, attempt: (current?.attempt ?? 0) + 1, ownerToken: `image_continuation_${randomUUID()}`, leaseExpiresAt: new Date(now + leaseMs).toISOString(), updatedAt: new Date(now).toISOString() })
    this.rows.set(key, row); return row
  }

  async releaseBeforeProvider(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) {
    const current = this.owned(input, 'leased')
    const row = Object.freeze({ workspaceId: current.workspaceId, jobId: current.jobId, state: 'available' as const, attempt: current.attempt, updatedAt: new Date(instant(input.now)).toISOString() })
    this.rows.set(keyOf(current.workspaceId, current.jobId), row); return row
  }

  async markProviderStarted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) {
    const current = this.owned(input, 'leased'); const at = new Date(instant(input.now)).toISOString()
    const row = Object.freeze({ ...current, state: 'provider_started' as const, ownerToken: current.ownerToken!, leaseExpiresAt: current.leaseExpiresAt!, providerStartedAt: at, updatedAt: at })
    this.rows.set(keyOf(current.workspaceId, current.jobId), row); return row
  }

  async markOutcomeUnknown(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) {
    return this.terminal(input, 'outcome_unknown')
  }
  async markCompleted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) { return this.terminal(input, 'completed') }
  async markFailed(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.terminal(input, 'failed') }
  async get(input: { workspaceId: string; jobId: string }) { return this.rows.get(keyOf(workspace(input.workspaceId), identifier(input.jobId, 'JOB_ID'))) }

  private owned(input: { workspaceId: string; jobId: string; ownerToken: string }, state: 'leased' | 'provider_started') {
    const workspaceId = workspace(input.workspaceId); const jobId = identifier(input.jobId, 'JOB_ID'); const ownerToken = identifier(input.ownerToken, 'OWNER_TOKEN')
    const current = this.rows.get(keyOf(workspaceId, jobId))
    if (current?.state !== state || current.ownerToken !== ownerToken) throw new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_LEASE_LOST', current)
    return current
  }

  private terminal(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string; errorCode?: string; errorMessage?: string }, state: 'outcome_unknown' | 'completed' | 'failed') {
    const current = this.owned(input, 'provider_started'); const at = new Date(instant(input.now)).toISOString()
    const error = state === 'completed' ? {} : { errorCode: identifier(input.errorCode, 'ERROR_CODE'), errorMessage: identifier(input.errorMessage, 'ERROR_MESSAGE') }
    const row = Object.freeze({ workspaceId: current.workspaceId, jobId: current.jobId, state, attempt: current.attempt, ...(current.providerStartedAt ? { providerStartedAt: current.providerStartedAt } : {}), ...error, updatedAt: at }) as ImageContinuationLease
    this.rows.set(keyOf(current.workspaceId, current.jobId), row); return row as never
  }
}

type Row = { workspace_id: string; job_id: string; state: ImageContinuationLeaseState; attempt: number; owner_token: string | null; lease_expires_at: string | Date | null; provider_started_at: string | Date | null; error_code: string | null; error_message: string | null; updated_at: string | Date }
const projection = 'workspace_id,job_id,state,attempt,owner_token,lease_expires_at,provider_started_at,error_code,error_message,updated_at'
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
function map(row: Row): ImageContinuationLease {
  return { workspaceId: row.workspace_id, jobId: row.job_id, state: row.state, attempt: row.attempt, ...(row.owner_token ? { ownerToken: row.owner_token } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}), ...(row.provider_started_at ? { providerStartedAt: iso(row.provider_started_at) } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_message ? { errorMessage: row.error_message } : {}), updatedAt: iso(row.updated_at) }
}

export class PostgresImageContinuationLeaseRepository implements ImageContinuationLeaseRepository {
  constructor(private readonly pool: SqlPool) {}

  async claim(input: { workspaceId: string; jobId: string; leaseMs: number; now?: string }) {
    const workspaceId = workspace(input.workspaceId); const jobId = identifier(input.jobId, 'JOB_ID'); const leaseMs = leaseDuration(input.leaseMs)
    const now = new Date(instant(input.now)).toISOString(); const ownerToken = `image_continuation_${randomUUID()}`
    const outcome = await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`INSERT INTO image_generation_continuation_leases (workspace_id,job_id,state,attempt,owner_token,lease_expires_at,updated_at)
        VALUES ($1,$2,'leased',1,$3,$4::timestamptz + ($5 * interval '1 millisecond'),$4)
        ON CONFLICT (workspace_id,job_id) DO UPDATE SET state='leased',attempt=image_generation_continuation_leases.attempt+1,owner_token=EXCLUDED.owner_token,lease_expires_at=EXCLUDED.lease_expires_at,provider_started_at=NULL,error_code=NULL,error_message=NULL,updated_at=EXCLUDED.updated_at
        WHERE image_generation_continuation_leases.state='available' OR (image_generation_continuation_leases.state='leased' AND image_generation_continuation_leases.lease_expires_at <= $4)
        RETURNING ${projection}`, [workspaceId, jobId, ownerToken, now, leaseMs])
      if (result.rows[0]) return { claimed: true as const, lease: map(result.rows[0]) }
      const current = (await client.query<Row>(`SELECT ${projection} FROM image_generation_continuation_leases WHERE workspace_id=$1 AND job_id=$2`, [workspaceId, jobId])).rows[0]
      return { claimed: false as const, lease: current ? map(current) : undefined }
    })
    if (outcome.claimed) return outcome.lease as LeasedImageContinuation
    throw stateError(outcome.lease)
  }

  async releaseBeforeProvider(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) { return this.transition(input, 'leased', 'available') }
  async markProviderStarted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) { return this.transition(input, 'leased', 'provider_started') as Promise<ProviderStartedImageContinuation> }
  async markOutcomeUnknown(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.transition(input, 'provider_started', 'outcome_unknown') as Promise<OutcomeUnknownImageContinuation> }
  async markCompleted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) { return this.transition(input, 'provider_started', 'completed') as Promise<CompletedImageContinuation> }
  async markFailed(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.transition(input, 'provider_started', 'failed') as Promise<FailedImageContinuation> }

  async get(input: { workspaceId: string; jobId: string }) {
    const workspaceId = workspace(input.workspaceId); const jobId = identifier(input.jobId, 'JOB_ID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const row = (await client.query<Row>(`SELECT ${projection} FROM image_generation_continuation_leases WHERE workspace_id=$1 AND job_id=$2`, [workspaceId, jobId])).rows[0]
      return row ? map(row) : undefined
    })
  }

  private async transition(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string; errorCode?: string; errorMessage?: string }, from: 'leased' | 'provider_started', to: ImageContinuationLeaseState) {
    const workspaceId = workspace(input.workspaceId); const jobId = identifier(input.jobId, 'JOB_ID'); const ownerToken = identifier(input.ownerToken, 'OWNER_TOKEN'); const now = new Date(instant(input.now)).toISOString()
    const errorCode = to === 'failed' || to === 'outcome_unknown' ? identifier(input.errorCode, 'ERROR_CODE') : null
    const errorMessage = to === 'failed' || to === 'outcome_unknown' ? identifier(input.errorMessage, 'ERROR_MESSAGE') : null
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`UPDATE image_generation_continuation_leases SET state=$4,owner_token=CASE WHEN $4 IN ('leased','provider_started') THEN owner_token ELSE NULL END,lease_expires_at=CASE WHEN $4 IN ('leased','provider_started') THEN lease_expires_at ELSE NULL END,provider_started_at=CASE WHEN $4='provider_started' THEN $5::timestamptz ELSE provider_started_at END,error_code=$6,error_message=$7,updated_at=$5 WHERE workspace_id=$1 AND job_id=$2 AND state=$8 AND owner_token=$3 RETURNING ${projection}`, [workspaceId, jobId, ownerToken, to, now, errorCode, errorMessage, from])
      if (!result.rows[0]) throw new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_LEASE_LOST', await this.getWithin(client, workspaceId, jobId))
      return map(result.rows[0])
    })
  }

  private async getWithin(client: { query<Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> }, workspaceId: string, jobId: string) {
    const row = (await client.query<Row>(`SELECT ${projection} FROM image_generation_continuation_leases WHERE workspace_id=$1 AND job_id=$2`, [workspaceId, jobId])).rows[0]
    return row ? map(row) : undefined
  }
}

function stateError(lease?: ImageContinuationLease) {
  if (lease?.state === 'completed') return new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_COMPLETED', lease)
  if (lease?.state === 'failed') return new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_FAILED', lease)
  if (lease?.state === 'provider_started' || lease?.state === 'outcome_unknown') return new ImageContinuationLeaseError('IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN', lease)
  return new ImageContinuationLeaseError('IMAGE_CONTINUATION_EXECUTION_BUSY', lease)
}
