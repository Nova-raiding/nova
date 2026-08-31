import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ImageGenerationExecutionState = 'available' | 'leased' | 'provider_started' | 'outcome_unknown' | 'completed' | 'failed'

export interface ImageGenerationExecution {
  workspaceId: string
  jobId: string
  eventId: string
  state: ImageGenerationExecutionState
  attempt: number
  ownerToken?: string
  leaseExpiresAt?: string
  providerStartedAt?: string
  providerRequestId?: string
  errorCode?: string
  errorMessage?: string
  updatedAt: string
}

export interface ImageGenerationExecutionPage {
  items: ImageGenerationExecution[]
  nextCursor?: string
  scanWatermark: string
}

export type LeasedImageGenerationExecution = ImageGenerationExecution & { state: 'leased'; ownerToken: string; leaseExpiresAt: string }
export type ProviderStartedImageGenerationExecution = ImageGenerationExecution & { state: 'provider_started'; ownerToken: string; leaseExpiresAt: string; providerStartedAt: string }

export class ImageGenerationExecutionError extends Error {
  constructor(readonly code: 'IMAGE_GENERATION_EXECUTION_BUSY' | 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' | 'IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN' | 'IMAGE_GENERATION_EXECUTION_COMPLETED' | 'IMAGE_GENERATION_EXECUTION_FAILED', readonly execution?: ImageGenerationExecution) {
    super(code)
    this.name = 'ImageGenerationExecutionError'
  }
}

export interface ImageGenerationExecutionRepository {
  claim(input: { workspaceId: string; jobId: string; eventId: string; leaseMs: number; now?: string }): Promise<LeasedImageGenerationExecution>
  markProviderStarted(input: { workspaceId: string; jobId: string; ownerToken: string; providerRequestId: string; now?: string }): Promise<ProviderStartedImageGenerationExecution>
  markOutcomeUnknown(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }): Promise<ImageGenerationExecution>
  markCompleted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }): Promise<ImageGenerationExecution>
  markFailed(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }): Promise<ImageGenerationExecution>
  reconcileCompleted(input: { workspaceId: string; jobId: string; now?: string }): Promise<ImageGenerationExecution>
  reconcileFailed(input: { workspaceId: string; jobId: string; errorCode: string; errorMessage: string; now?: string }): Promise<ImageGenerationExecution>
  get(input: { workspaceId: string; jobId: string }): Promise<ImageGenerationExecution | undefined>
  list(input: { workspaceId: string; states?: ImageGenerationExecutionState[]; limit?: number }): Promise<ImageGenerationExecution[]>
  listPage(input: { workspaceId: string; states?: ImageGenerationExecutionState[]; limit?: number; cursor?: string; olderThan?: string; scanWatermark?: string }): Promise<ImageGenerationExecutionPage>
}

const keyOf = (workspaceId: string, jobId: string) => `${workspaceId}\0${jobId}`
const normalizedId = (value: string, label: string) => {
  const result = value.trim()
  if (!result || result.length > 255 || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`IMAGE_GENERATION_${label}_REQUIRED`)
  return result
}
const workspace = (value: string) => normalizedId(requireWorkspaceScope(value), 'WORKSPACE_ID')
type ExecutionCursor = { version: 1; workspaceId: string; states: string; olderThan?: string; scanWatermark: string; updatedAt: string; jobId: string; checksum: string }
const cursorChecksum = (cursor: Omit<ExecutionCursor, 'checksum'>) => createHash('sha256').update(JSON.stringify(cursor), 'utf8').digest('hex')
const encodeCursor = (workspaceId: string, row: ImageGenerationExecution, states: string, olderThan: string | undefined, scanWatermark: string): string => {
  const payload = { version: 1 as const, workspaceId, states, ...(olderThan ? { olderThan } : {}), scanWatermark, updatedAt: row.updatedAt, jobId: row.jobId }
  return Buffer.from(JSON.stringify({ ...payload, checksum: cursorChecksum(payload) } satisfies ExecutionCursor), 'utf8').toString('base64url')
}
const decodeCursor = (workspaceId: string, value: string | undefined, states: string, olderThan: string | undefined): Omit<ExecutionCursor, 'checksum'> | undefined => {
  if (value === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown } catch { throw new RangeError('image generation cursor is invalid') }
  if (!parsed || typeof parsed !== 'object' || (parsed as ExecutionCursor).version !== 1 || (parsed as ExecutionCursor).workspaceId !== workspaceId || (parsed as ExecutionCursor).states !== states || (parsed as ExecutionCursor).olderThan !== olderThan || typeof (parsed as ExecutionCursor).scanWatermark !== 'string' || typeof (parsed as ExecutionCursor).updatedAt !== 'string' || typeof (parsed as ExecutionCursor).jobId !== 'string' || typeof (parsed as ExecutionCursor).checksum !== 'string') throw new RangeError('image generation cursor is invalid')
  const cursor = parsed as ExecutionCursor
  const { checksum: _checksum, ...payload } = cursor
  if (instant(cursor.updatedAt) < 0 || instant(cursor.scanWatermark) < 0 || cursor.checksum !== cursorChecksum(payload)) throw new RangeError('image generation cursor is invalid')
  return payload
}
const instant = (value?: string) => {
  if (value === undefined) return Date.now()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new RangeError('image generation timestamp must be a canonical UTC instant')
  return parsed
}
const leaseDuration = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) throw new RangeError('leaseMs must be between 1 and 86400000')
  return value
}

/** Deterministic local implementation used by unit tests and non-persistent
 * development. Production wiring must use the PostgreSQL implementation. */
export class MemoryImageGenerationExecutionRepository implements ImageGenerationExecutionRepository {
  private readonly rows = new Map<string, ImageGenerationExecution>()

  async claim(input: { workspaceId: string; jobId: string; eventId: string; leaseMs: number; now?: string }) {
    const workspaceId = workspace(input.workspaceId); const jobId = normalizedId(input.jobId, 'JOB_ID'); const eventId = normalizedId(input.eventId, 'EVENT_ID'); const now = instant(input.now); const leaseMs = leaseDuration(input.leaseMs); const key = keyOf(workspaceId, jobId); const current = this.rows.get(key)
    if (current && current.eventId !== eventId) throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_BUSY', current)
    if (current?.state === 'leased' && Date.parse(current.leaseExpiresAt!) > now) throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_BUSY', current)
    if (current?.state === 'provider_started' || current?.state === 'outcome_unknown') throw new ImageGenerationExecutionError('IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN', current)
    if (current?.state === 'completed') throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_COMPLETED', current)
    if (current?.state === 'failed') throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_FAILED', current)
    const row: LeasedImageGenerationExecution = { workspaceId, jobId, eventId, state: 'leased', attempt: (current?.attempt ?? 0) + 1, ownerToken: `image_generation_${randomUUID()}`, leaseExpiresAt: new Date(now + leaseMs).toISOString(), updatedAt: new Date(now).toISOString() }
    this.rows.set(key, row)
    return row
  }

  async markProviderStarted(input: { workspaceId: string; jobId: string; ownerToken: string; providerRequestId: string; now?: string }) {
    const current = this.owned(input, 'leased'); const providerRequestId = normalizedId(input.providerRequestId, 'PROVIDER_REQUEST_ID'); const at = new Date(instant(input.now)).toISOString()
    const row: ProviderStartedImageGenerationExecution = { ...current, state: 'provider_started', providerRequestId, providerStartedAt: at, updatedAt: at }
    this.rows.set(keyOf(current.workspaceId, current.jobId), row)
    return row
  }

  async markOutcomeUnknown(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.terminal(input, 'outcome_unknown') }
  async markCompleted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) { return this.terminal(input, 'completed') }
  async markFailed(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.terminal(input, 'failed') }
  async reconcileCompleted(input: { workspaceId: string; jobId: string; now?: string }) { return this.reconcile(input, 'completed') }
  async reconcileFailed(input: { workspaceId: string; jobId: string; errorCode: string; errorMessage: string; now?: string }) { return this.reconcile(input, 'failed', input.errorCode, input.errorMessage) }
  async get(input: { workspaceId: string; jobId: string }) { return this.rows.get(keyOf(workspace(input.workspaceId), normalizedId(input.jobId, 'JOB_ID'))) }
  async list(input: { workspaceId: string; states?: ImageGenerationExecutionState[]; limit?: number }) { return (await this.listPage(input)).items }
  async listPage(input: { workspaceId: string; states?: ImageGenerationExecutionState[]; limit?: number; cursor?: string; olderThan?: string; scanWatermark?: string }) {
    const workspaceId = workspace(input.workspaceId); const limit = input.limit === undefined ? 100 : Math.min(1000, Math.max(1, Math.trunc(input.limit))); const states = [...(input.states ?? [])].sort().join(','); const olderThan = input.olderThan === undefined ? undefined : new Date(instant(input.olderThan)).toISOString(); const cursor = decodeCursor(workspaceId, input.cursor, states, olderThan); const scanWatermark = cursor?.scanWatermark ?? (input.scanWatermark ? new Date(instant(input.scanWatermark)).toISOString() : new Date(Math.max(Date.now(), ...Array.from(this.rows.values(), row => Date.parse(row.updatedAt)))).toISOString())
    const rows = [...this.rows.values()].filter(row => row.workspaceId === workspaceId && (!input.states?.length || input.states.includes(row.state)) && row.updatedAt <= scanWatermark && (!olderThan || row.updatedAt < olderThan) && (!cursor || row.updatedAt < cursor.updatedAt || (row.updatedAt === cursor.updatedAt && row.jobId > cursor.jobId))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.jobId.localeCompare(b.jobId))
    const items = rows.slice(0, limit); return { items, scanWatermark, ...(rows.length > limit && items.at(-1) ? { nextCursor: encodeCursor(workspaceId, items.at(-1)!, states, olderThan, scanWatermark) } : {}) }
  }

  private owned(input: { workspaceId: string; jobId: string; ownerToken: string }, state: 'leased' | 'provider_started') {
    const workspaceId = workspace(input.workspaceId); const jobId = normalizedId(input.jobId, 'JOB_ID'); const ownerToken = normalizedId(input.ownerToken, 'OWNER_TOKEN'); const current = this.rows.get(keyOf(workspaceId, jobId))
    if (current?.state !== state || current.ownerToken !== ownerToken) throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_LEASE_LOST', current)
    return current as LeasedImageGenerationExecution
  }

  private terminal(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode?: string; errorMessage?: string; now?: string }, state: 'outcome_unknown' | 'completed' | 'failed') {
    const current = this.owned(input, 'provider_started'); const at = new Date(instant(input.now)).toISOString(); const error = state === 'completed' ? {} : { errorCode: normalizedId(input.errorCode ?? '', 'ERROR_CODE'), errorMessage: normalizedId(input.errorMessage ?? '', 'ERROR_MESSAGE') }
    const row: ImageGenerationExecution = { workspaceId: current.workspaceId, jobId: current.jobId, eventId: current.eventId, state, attempt: current.attempt, ...(current.providerStartedAt ? { providerStartedAt: current.providerStartedAt } : {}), ...(current.providerRequestId ? { providerRequestId: current.providerRequestId } : {}), ...error, updatedAt: at }
    this.rows.set(keyOf(current.workspaceId, current.jobId), row)
    return row
  }
  private reconcile(input: { workspaceId: string; jobId: string; errorCode?: string; errorMessage?: string; now?: string }, state: 'completed' | 'failed', errorCode?: string, errorMessage?: string) {
    const current = this.rows.get(keyOf(workspace(input.workspaceId), normalizedId(input.jobId, 'JOB_ID')))
    if (!current || !['provider_started', 'outcome_unknown'].includes(current.state)) throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_LEASE_LOST', current)
    const at = new Date(instant(input.now)).toISOString(); const error = state === 'failed' ? { errorCode: normalizedId(errorCode ?? '', 'ERROR_CODE'), errorMessage: normalizedId(errorMessage ?? '', 'ERROR_MESSAGE') } : {}
    const row: ImageGenerationExecution = { ...current, state, ownerToken: undefined, leaseExpiresAt: undefined, ...error, updatedAt: at }
    this.rows.set(keyOf(current.workspaceId, current.jobId), row); return row
  }
}

type ExecutionRow = { workspace_id: string; job_id: string; event_id: string; state: ImageGenerationExecutionState; attempt: number; owner_token: string | null; lease_expires_at: string | Date | null; provider_started_at: string | Date | null; provider_request_id: string | null; error_code: string | null; error_message: string | null; updated_at: string | Date }
const executionProjection = 'workspace_id,job_id,event_id,state,attempt,owner_token,lease_expires_at,provider_started_at,provider_request_id,error_code,error_message,updated_at'
const asIso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const mapExecution = (row: ExecutionRow): ImageGenerationExecution => ({ workspaceId: row.workspace_id, jobId: row.job_id, eventId: row.event_id, state: row.state, attempt: row.attempt, ...(row.owner_token ? { ownerToken: row.owner_token } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: asIso(row.lease_expires_at) } : {}), ...(row.provider_started_at ? { providerStartedAt: asIso(row.provider_started_at) } : {}), ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_message ? { errorMessage: row.error_message } : {}), updatedAt: asIso(row.updated_at) })

export class PostgresImageGenerationExecutionRepository implements ImageGenerationExecutionRepository {
  constructor(private readonly pool: SqlPool) {}

  async claim(input: { workspaceId: string; jobId: string; eventId: string; leaseMs: number; now?: string }) {
    const workspaceId = workspace(input.workspaceId); const jobId = normalizedId(input.jobId, 'JOB_ID'); const eventId = normalizedId(input.eventId, 'EVENT_ID'); const leaseMs = leaseDuration(input.leaseMs); const now = new Date(instant(input.now)).toISOString(); const ownerToken = `image_generation_${randomUUID()}`
    const outcome = await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<ExecutionRow>(`INSERT INTO image_generation_executions (workspace_id,job_id,event_id,state,attempt,owner_token,lease_expires_at,updated_at)
        VALUES ($1,$2,$3,'leased',1,$4,$5::timestamptz + ($6 * interval '1 millisecond'),$5)
        ON CONFLICT (workspace_id,job_id) DO UPDATE SET state='leased',attempt=image_generation_executions.attempt+1,event_id=EXCLUDED.event_id,owner_token=EXCLUDED.owner_token,lease_expires_at=EXCLUDED.lease_expires_at,provider_started_at=NULL,provider_request_id=NULL,error_code=NULL,error_message=NULL,updated_at=EXCLUDED.updated_at
        WHERE image_generation_executions.event_id=$3 AND (image_generation_executions.state='available' OR (image_generation_executions.state='leased' AND image_generation_executions.lease_expires_at <= $5))
        RETURNING ${executionProjection}`, [workspaceId, jobId, eventId, ownerToken, now, leaseMs])
      if (result.rows[0]) return { claimed: true as const, execution: mapExecution(result.rows[0]) }
      const current = (await client.query<ExecutionRow>(`SELECT ${executionProjection} FROM image_generation_executions WHERE workspace_id=$1 AND job_id=$2`, [workspaceId, jobId])).rows[0]
      return { claimed: false as const, execution: current ? mapExecution(current) : undefined }
    })
    if (outcome.claimed) return outcome.execution as LeasedImageGenerationExecution
    throw stateError(outcome.execution)
  }

  async markProviderStarted(input: { workspaceId: string; jobId: string; ownerToken: string; providerRequestId: string; now?: string }) { return this.transition(input, 'leased', 'provider_started', input.providerRequestId) as Promise<ProviderStartedImageGenerationExecution> }
  async markOutcomeUnknown(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.transition(input, 'provider_started', 'outcome_unknown', undefined, input.errorCode, input.errorMessage) }
  async markCompleted(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string }) { return this.transition(input, 'provider_started', 'completed') }
  async markFailed(input: { workspaceId: string; jobId: string; ownerToken: string; errorCode: string; errorMessage: string; now?: string }) { return this.transition(input, 'provider_started', 'failed', undefined, input.errorCode, input.errorMessage) }
  async reconcileCompleted(input: { workspaceId: string; jobId: string; now?: string }) { return this.reconcile(input, 'completed') }
  async reconcileFailed(input: { workspaceId: string; jobId: string; errorCode: string; errorMessage: string; now?: string }) { return this.reconcile(input, 'failed', input.errorCode, input.errorMessage) }
  async get(input: { workspaceId: string; jobId: string }) { const workspaceId = workspace(input.workspaceId); const jobId = normalizedId(input.jobId, 'JOB_ID'); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const row = (await client.query<ExecutionRow>(`SELECT ${executionProjection} FROM image_generation_executions WHERE workspace_id=$1 AND job_id=$2`, [workspaceId, jobId])).rows[0]; return row ? mapExecution(row) : undefined }) }
  async list(input: { workspaceId: string; states?: ImageGenerationExecutionState[]; limit?: number }) { return (await this.listPage(input)).items }
  async listPage(input: { workspaceId: string; states?: ImageGenerationExecutionState[]; limit?: number; cursor?: string; olderThan?: string; scanWatermark?: string }) {
    const workspaceId = workspace(input.workspaceId); const limit = input.limit === undefined ? 100 : Math.min(1000, Math.max(1, Math.trunc(input.limit))); const states = input.states?.length ? input.states : undefined; const statesKey = [...(states ?? [])].sort().join(','); const olderThan = input.olderThan === undefined ? undefined : new Date(instant(input.olderThan)).toISOString(); const cursor = decodeCursor(workspaceId, input.cursor, statesKey, olderThan); const scanWatermark = cursor?.scanWatermark ?? (input.scanWatermark ? new Date(instant(input.scanWatermark)).toISOString() : new Date().toISOString())
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<ExecutionRow>(`SELECT ${executionProjection} FROM image_generation_executions WHERE workspace_id=$1 AND ($2::text[] IS NULL OR state = ANY($2::text[])) AND updated_at <= $3::timestamptz AND ($4::timestamptz IS NULL OR updated_at < $4::timestamptz) AND ($5::timestamptz IS NULL OR updated_at < $5::timestamptz OR (updated_at = $5::timestamptz AND job_id > $6)) ORDER BY updated_at DESC, job_id ASC LIMIT $7`, [workspaceId, states ?? null, scanWatermark, olderThan ?? null, cursor?.updatedAt ?? null, cursor?.jobId ?? null, limit + 1])
      const items = result.rows.slice(0, limit).map(mapExecution); return { items, scanWatermark, ...(result.rows.length > limit && items.at(-1) ? { nextCursor: encodeCursor(workspaceId, items.at(-1)!, statesKey, olderThan, scanWatermark) } : {}) }
    })
  }

  private async transition(input: { workspaceId: string; jobId: string; ownerToken: string; now?: string; providerRequestId?: string; errorCode?: string; errorMessage?: string }, from: 'leased' | 'provider_started', to: ImageGenerationExecutionState, providerRequestId?: string, errorCode?: string, errorMessage?: string) {
    const workspaceId = workspace(input.workspaceId); const jobId = normalizedId(input.jobId, 'JOB_ID'); const ownerToken = normalizedId(input.ownerToken, 'OWNER_TOKEN'); const now = new Date(instant(input.now)).toISOString(); const code = to === 'failed' || to === 'outcome_unknown' ? normalizedId(errorCode ?? '', 'ERROR_CODE') : null; const message = to === 'failed' || to === 'outcome_unknown' ? normalizedId(errorMessage ?? '', 'ERROR_MESSAGE') : null
    return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<ExecutionRow>(`UPDATE image_generation_executions SET state=$4,owner_token=CASE WHEN $4='provider_started' THEN owner_token ELSE NULL END,lease_expires_at=CASE WHEN $4='provider_started' THEN lease_expires_at ELSE NULL END,provider_started_at=CASE WHEN $4='provider_started' THEN $5::timestamptz ELSE provider_started_at END,provider_request_id=COALESCE($6,provider_request_id),error_code=$7,error_message=$8,updated_at=$5 WHERE workspace_id=$1 AND job_id=$2 AND state=$9 AND owner_token=$3 RETURNING ${executionProjection}`, [workspaceId, jobId, ownerToken, to, now, providerRequestId ?? null, code, message, from]); if (!result.rows[0]) throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_LEASE_LOST', await this.getWithin(client, workspaceId, jobId)); return mapExecution(result.rows[0]) })
  }
  private async reconcile(input: { workspaceId: string; jobId: string; now?: string; errorCode?: string; errorMessage?: string }, to: 'completed' | 'failed', errorCode?: string, errorMessage?: string) {
    const workspaceId = workspace(input.workspaceId); const jobId = normalizedId(input.jobId, 'JOB_ID'); const now = new Date(instant(input.now)).toISOString(); const code = to === 'failed' ? normalizedId(errorCode ?? '', 'ERROR_CODE') : null; const message = to === 'failed' ? normalizedId(errorMessage ?? '', 'ERROR_MESSAGE') : null
    return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<ExecutionRow>(`UPDATE image_generation_executions SET state=$3,owner_token=NULL,lease_expires_at=NULL,error_code=$4,error_message=$5,updated_at=$6 WHERE workspace_id=$1 AND job_id=$2 AND state IN ('provider_started','outcome_unknown') RETURNING ${executionProjection}`, [workspaceId, jobId, to, code, message, now]); if (!result.rows[0]) throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_LEASE_LOST', await this.getWithin(client, workspaceId, jobId)); return mapExecution(result.rows[0]) })
  }
  private async getWithin(client: { query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> }, workspaceId: string, jobId: string) { const row = (await client.query<ExecutionRow>(`SELECT ${executionProjection} FROM image_generation_executions WHERE workspace_id=$1 AND job_id=$2`, [workspaceId, jobId])).rows[0]; return row ? mapExecution(row) : undefined }
}

function stateError(execution?: ImageGenerationExecution): never {
  if (execution?.state === 'completed') throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_COMPLETED', execution)
  if (execution?.state === 'failed') throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_FAILED', execution)
  if (execution?.state === 'provider_started' || execution?.state === 'outcome_unknown') throw new ImageGenerationExecutionError('IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN', execution)
  throw new ImageGenerationExecutionError('IMAGE_GENERATION_EXECUTION_BUSY', execution)
}
