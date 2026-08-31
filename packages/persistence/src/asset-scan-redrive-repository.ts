import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, withWorkspaceTransaction, type OutboxEvent, type SqlPool } from './repository.js'

const SCAN_EVENT_TYPES = new Set(['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined', 'asset.scan_redrive_requested'])
const RECOVERABLE_SCAN_FAILURE_CODES = new Set([
  'ASSET_SCAN_RECEIPT_INVALID',
  'ASSET_SCAN_RECEIPT_EXPIRED',
  'ASSET_SCAN_RECEIPT_DEFINITIONS_STALE',
  'ASSET_SCAN_RECEIPT_POLICY_MISMATCH',
  'ASSET_SCAN_CONTENT_UNAVAILABLE',
  'ASSET_SCANNER_CONFIG_MISSING',
  'SCANNER_DEPENDENCY_UNAVAILABLE',
  'CLAMAV_CONNECTION_ERROR',
  'CLAMAV_DEFINITIONS_STALE',
  'CLAMAV_EICAR_SELF_TEST_FAILED',
  'CLAMAV_PROTOCOL_ERROR',
  'CLAMAV_RESPONSE_TOO_LARGE',
  'CLAMAV_SCAN_ERROR',
  'CLAMAV_TIMEOUT',
  'CLAMAV_UNREACHABLE',
  'CLAMAV_VERSION_INVALID',
])
const SHA256 = /^[a-f0-9]{64}$/u

export type AssetScanRedriveErrorCode =
  | 'ASSET_SCAN_REDRIVE_INPUT_INVALID'
  | 'ASSET_SCAN_REDRIVE_ASSET_NOT_FOUND'
  | 'ASSET_SCAN_REDRIVE_REVISION_CONFLICT'
  | 'ASSET_SCAN_REDRIVE_EVENT_NOT_FOUND'
  | 'ASSET_SCAN_REDRIVE_EVENT_INVALID'
  | 'ASSET_SCAN_REDRIVE_NOT_DEAD_LETTER'
  | 'ASSET_SCAN_REDRIVE_BINDING_MISMATCH'
  | 'ASSET_SCAN_REDRIVE_IDEMPOTENCY_CONFLICT'

export class AssetScanRedriveError extends Error {
  constructor(readonly code: AssetScanRedriveErrorCode) { super(code); this.name = 'AssetScanRedriveError' }
}

export interface AssetScanRedriveInput {
  workspaceId: string
  assetId: string
  deadLetterOutboxEventId: string
  expectedAssetRevision: number
  recoveryKey: string
  actorId: string
  reason: string
  scanMaxAttempts: number
  authorizationSnapshot: SerializedAssetScanAuthorizationSnapshot
}

export interface SerializedAssetScanAuthorizationSnapshot {
  schema_version: 1
  decision_id: string
  actor_id: string
  workspace_id: string
  context_id: string
  context_version: string
  policy_version: string
  grant_revision: string
  scope_hash: string
  capability: 'asset.scan.execute'
  resource_id: string
  authorized: true
  decided_at: string
}

export interface AssetScanRetryableFailure {
  assetId: string
  assetRevision: number
  sourceRevision: number
  event: OutboxEvent
  failure: { code: string; message: string; retryable: boolean }
}

export interface ListAssetScanRetryableFailuresOptions {
  assetIds?: readonly string[]
  limit?: number
  scanMaxAttempts: number
}

export interface AssetScanRedriveResult {
  redriveId: string
  auditId: string
  replayed: boolean
  asset: Record<string, unknown>
  event: OutboxEvent
}

export interface AssetScanRedriveRepository {
  listRetryableFailures(workspaceId: string, options: ListAssetScanRetryableFailuresOptions): Promise<AssetScanRetryableFailure[]>
  redrive(input: AssetScanRedriveInput): Promise<AssetScanRedriveResult>
}

type SnapshotRow = { entity_version: number; payload: Record<string, unknown> | string }
type EventRow = {
  id: string; workspace_id: string; aggregate_id: string; event_type: string; sequence: number
  payload: Record<string, unknown> | string; published_at: string | Date | null; created_at: string | Date
  attempts: number; next_attempt_at: string | Date; lease_token: string | null; lease_until: string | Date | null
  last_error: Record<string, unknown> | string | null; unknown_at: string | Date | null
}
type RedriveRow = {
  id: string; workspace_id: string; recovery_key: string; asset_id: string; old_outbox_event_id: string
  new_outbox_event_id: string; expected_asset_revision: number; source_revision_before: number
  source_revision_after: number; actor_id: string; reason: string; scan_max_attempts: number; audit_id: string
}
type FailureRow = EventRow & { asset_revision: number; asset_payload: Record<string, unknown> | string }
type AttemptEvidenceRow = { receipt: Record<string, unknown> | string; callback_status: string; callback_accepted_at: string | Date | null }

const object = (value: Record<string, unknown> | string): Record<string, unknown> => typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : structuredClone(value)
const iso = (value: string | Date): string => value instanceof Date ? value.toISOString() : String(value)
const eventFromRow = (row: EventRow): OutboxEvent => ({
  id: row.id, workspaceId: row.workspace_id, aggregateId: row.aggregate_id, eventType: row.event_type,
  sequence: Number(row.sequence), payload: object(row.payload), ...(row.published_at ? { publishedAt: iso(row.published_at) } : {}),
  createdAt: iso(row.created_at), attempts: Number(row.attempts), nextAttemptAt: iso(row.next_attempt_at),
  ...(row.lease_token ? { leaseToken: row.lease_token } : {}), ...(row.lease_until ? { leaseUntil: iso(row.lease_until) } : {}),
  ...(row.last_error ? { lastError: object(row.last_error) } : {}), ...(row.unknown_at ? { unknownAt: iso(row.unknown_at) } : {}),
})

function text(value: string, min: number, max: number): string {
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
  return normalized
}

function validate(raw: AssetScanRedriveInput): AssetScanRedriveInput {
  const input = { ...raw, workspaceId: requireWorkspaceScope(raw.workspaceId), assetId: text(raw.assetId, 1, 255), deadLetterOutboxEventId: text(raw.deadLetterOutboxEventId, 1, 255), recoveryKey: text(raw.recoveryKey, 8, 255), actorId: text(raw.actorId, 1, 255), reason: text(raw.reason, 3, 1000) }
  if (![input.expectedAssetRevision, input.scanMaxAttempts].every(value => Number.isSafeInteger(value) && value > 0)) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
  input.authorizationSnapshot = validateAuthorizationSnapshot(raw.authorizationSnapshot, input)
  return input
}

function validateAuthorizationSnapshot(raw: SerializedAssetScanAuthorizationSnapshot, input: Pick<AssetScanRedriveInput, 'workspaceId' | 'assetId' | 'actorId'>): SerializedAssetScanAuthorizationSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
  const requiredStrings = [raw.decision_id, raw.actor_id, raw.workspace_id, raw.context_id, raw.context_version, raw.policy_version, raw.grant_revision, raw.scope_hash, raw.resource_id, raw.decided_at]
  if (raw.schema_version !== 1 || raw.authorized !== true || raw.capability !== 'asset.scan.execute' || requiredStrings.some(value => typeof value !== 'string' || !value.trim())) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
  if (raw.workspace_id !== input.workspaceId || raw.context_id !== `workspace:${input.workspaceId}` || raw.resource_id !== input.assetId || raw.actor_id !== input.actorId || !SHA256.test(raw.scope_hash) || !Number.isFinite(Date.parse(raw.decided_at))) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
  return structuredClone(raw)
}

const eventProjection = `id,workspace_id,aggregate_id,event_type,sequence,payload,published_at,created_at,attempts,next_attempt_at,lease_token,lease_until,last_error,unknown_at`

function isExpiredBoundLegacyReceipt(input: {
  attempt: AttemptEvidenceRow | undefined
  workspaceId: string
  eventId: string
  assetId: string
  storageKey: string
  sha256: string
  sizeBytes: number
  mimeType: string
  sourceRevision: number
  now?: number
}): boolean {
  if (!input.attempt || input.attempt.callback_status !== 'pending' || input.attempt.callback_accepted_at !== null) return false
  const receipt = object(input.attempt.receipt)
  const subject = receipt.subject && typeof receipt.subject === 'object' && !Array.isArray(receipt.subject) ? receipt.subject as Record<string, unknown> : undefined
  const expiresAt = typeof receipt.expires_at === 'string' ? Date.parse(receipt.expires_at) : Number.NaN
  return receipt.scan_job_id === input.eventId
    && Number.isFinite(expiresAt) && expiresAt <= (input.now ?? Date.now())
    && subject?.workspace_id === input.workspaceId
    && subject.asset_id === input.assetId
    && subject.object_key === input.storageKey
    && subject.sha256 === input.sha256
    && Number(subject.size_bytes) === input.sizeBytes
    && String(subject.mime_type ?? '').toLowerCase() === input.mimeType
    && Number(subject.asset_source_revision) === input.sourceRevision
}

function isRecoverableLegacyWorkerAuthWiring(eventType: string, failure: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  const snapshot = payload.authorization_snapshot
  return eventType === 'asset.scan_redrive_requested'
    && failure?.code === 'FORBIDDEN'
    && failure.message === 'worker internal authorization required'
    && Boolean(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot))
}

export class PostgresAssetScanRedriveRepository implements AssetScanRedriveRepository {
  constructor(private readonly pool: SqlPool) {}

  async listRetryableFailures(workspaceId: string, options: ListAssetScanRetryableFailuresOptions): Promise<AssetScanRetryableFailure[]> {
    const scope = requireWorkspaceScope(workspaceId)
    const limit = options.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(options.scanMaxAttempts) || options.scanMaxAttempts < 1) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
    const assetIds = options.assetIds === undefined ? undefined : [...new Set(options.assetIds.map(id => text(id, 1, 255)))]
    if (assetIds?.length === 0 || (assetIds && assetIds.length > 100)) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_INPUT_INVALID')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = (await client.query<FailureRow>(`SELECT o.${eventProjection.split(',').join(',o.')},s.entity_version AS asset_revision,s.payload AS asset_payload FROM outbox_events o JOIN business_entity_snapshots s ON s.workspace_id=o.workspace_id AND s.entity_type='asset' AND s.entity_id=o.aggregate_id WHERE o.workspace_id=$1 AND o.event_type = ANY($2::text[]) AND o.published_at IS NOT NULL AND o.unknown_at IS NULL AND o.lease_token IS NULL AND o.lease_until IS NULL AND o.last_error IS NOT NULL AND (COALESCE(o.last_error->>'retryable','') = 'false' OR o.attempts >= $3) AND ($4::text[] IS NULL OR o.aggregate_id = ANY($4::text[])) ORDER BY o.created_at DESC,o.id DESC LIMIT $5`, [scope, [...SCAN_EVENT_TYPES], options.scanMaxAttempts, assetIds ?? null, limit])).rows
      const failures: AssetScanRetryableFailure[] = []
      for (const row of rows) {
        const asset = object(row.asset_payload)
        const payload = object(row.payload)
        const failure = row.last_error ? object(row.last_error) : {}
        const code = typeof failure.code === 'string' ? failure.code : 'UNKNOWN'
        const sourceRevision = Number(asset.sourceRevision ?? 1)
        const bound = asset.scanStatus === 'quarantined' && payload.asset_id === row.aggregate_id && payload.storage_key === asset.storageKey && payload.sha256 === asset.sha256 && Number(payload.size_bytes) === Number(asset.sizeBytes) && Number(payload.source_revision ?? 1) === sourceRevision
        if (!bound) continue
        let legacyExpired = false
        if (code === 'ASSET_SCAN_RESULT_REJECTED') {
          const attempt = (await client.query<AttemptEvidenceRow>(`SELECT receipt,callback_status,callback_accepted_at FROM asset_scan_attempts WHERE workspace_id=$1 AND outbox_event_id=$2 AND asset_source_revision=$3`, [scope, row.id, sourceRevision])).rows[0]
          legacyExpired = isExpiredBoundLegacyReceipt({ attempt, workspaceId: scope, eventId: row.id, assetId: row.aggregate_id, storageKey: String(asset.storageKey), sha256: String(asset.sha256), sizeBytes: Number(asset.sizeBytes), mimeType: String(asset.mimeType).toLowerCase(), sourceRevision })
        }
        const legacyAuthWiring = isRecoverableLegacyWorkerAuthWiring(row.event_type, failure, payload)
        failures.push({ assetId: row.aggregate_id, assetRevision: Number(row.asset_revision), sourceRevision, event: eventFromRow(row), failure: { code: legacyExpired ? 'ASSET_SCAN_RECEIPT_EXPIRED' : legacyAuthWiring ? 'ASSET_SCAN_WORKER_AUTH_WIRING_FAILED' : code, message: legacyExpired ? '历史扫描回执已过期，需要创建新的扫描事件' : legacyAuthWiring ? '历史扫描 worker 的角色凭据接线错误，需要以当前授权重新扫描' : typeof failure.message === 'string' ? failure.message : '', retryable: RECOVERABLE_SCAN_FAILURE_CODES.has(code) || legacyExpired || legacyAuthWiring } })
      }
      return failures
    })
  }

  async redrive(raw: AssetScanRedriveInput): Promise<AssetScanRedriveResult> {
    const input = validate(raw)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const snapshotResult = await client.query<SnapshotRow>(`SELECT entity_version,payload FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2 FOR UPDATE`, [input.workspaceId, input.assetId])
      const snapshot = snapshotResult.rows[0]
      if (!snapshot) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_ASSET_NOT_FOUND')

      const replayResult = await client.query<RedriveRow>(`SELECT id,workspace_id,recovery_key,asset_id,old_outbox_event_id,new_outbox_event_id,expected_asset_revision,source_revision_before,source_revision_after,actor_id,reason,scan_max_attempts,audit_id FROM asset_scan_redrives WHERE workspace_id=$1 AND recovery_key=$2`, [input.workspaceId, input.recoveryKey])
      const replay = replayResult.rows[0]
      if (replay) {
        if (replay.asset_id !== input.assetId || replay.old_outbox_event_id !== input.deadLetterOutboxEventId || Number(replay.expected_asset_revision) !== input.expectedAssetRevision || replay.actor_id !== input.actorId || replay.reason !== input.reason) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_IDEMPOTENCY_CONFLICT')
        const replayEvent = (await client.query<EventRow>(`SELECT ${eventProjection} FROM outbox_events WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, replay.new_outbox_event_id])).rows[0]
        if (!replayEvent) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_EVENT_NOT_FOUND')
        return { redriveId: replay.id, auditId: replay.audit_id, replayed: true, asset: object(snapshot.payload), event: eventFromRow(replayEvent) }
      }

      if (Number(snapshot.entity_version) !== input.expectedAssetRevision) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_REVISION_CONFLICT')
      const current = object(snapshot.payload)
      const currentRevision = Number(current.revision)
      const currentSourceRevision = Number(current.sourceRevision ?? 1)
      const storageKey = typeof current.storageKey === 'string' ? current.storageKey : ''
      const sha256 = typeof current.sha256 === 'string' ? current.sha256 : ''
      const sizeBytes = Number(current.sizeBytes)
      const mimeType = typeof current.mimeType === 'string' ? current.mimeType.trim().toLowerCase() : ''
      if (currentRevision !== input.expectedAssetRevision) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_REVISION_CONFLICT')
      if (current.scanStatus !== 'quarantined' || !storageKey.startsWith(`quarantine/${input.workspaceId}/`) || storageKey.includes('..') || !SHA256.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !mimeType) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_BINDING_MISMATCH')

      const eventResult = await client.query<EventRow>(`SELECT ${eventProjection} FROM outbox_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [input.workspaceId, input.deadLetterOutboxEventId])
      const oldEvent = eventResult.rows[0]
      if (!oldEvent) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_EVENT_NOT_FOUND')
      if (!SCAN_EVENT_TYPES.has(oldEvent.event_type) || oldEvent.aggregate_id !== input.assetId) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_EVENT_INVALID')
      const oldFailure = oldEvent.last_error ? object(oldEvent.last_error) : undefined
      const oldPayload = object(oldEvent.payload)
      const oldSourceRevision = Number(oldPayload.source_revision ?? 1)
      if (oldPayload.asset_id !== input.assetId || oldPayload.storage_key !== storageKey || oldPayload.sha256 !== sha256 || Number(oldPayload.size_bytes) !== sizeBytes || oldSourceRevision !== currentSourceRevision) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_BINDING_MISMATCH')
      let legacyExpired = false
      if (oldFailure?.code === 'ASSET_SCAN_RESULT_REJECTED') {
        const attempt = (await client.query<AttemptEvidenceRow>(`SELECT receipt,callback_status,callback_accepted_at FROM asset_scan_attempts WHERE workspace_id=$1 AND outbox_event_id=$2 AND asset_source_revision=$3 FOR SHARE`, [input.workspaceId, oldEvent.id, oldSourceRevision])).rows[0]
        legacyExpired = isExpiredBoundLegacyReceipt({ attempt, workspaceId: input.workspaceId, eventId: oldEvent.id, assetId: input.assetId, storageKey, sha256, sizeBytes, mimeType, sourceRevision: oldSourceRevision })
      }
      const legacyAuthWiring = isRecoverableLegacyWorkerAuthWiring(oldEvent.event_type, oldFailure, oldPayload)
      const recoverable = typeof oldFailure?.code === 'string' && (RECOVERABLE_SCAN_FAILURE_CODES.has(oldFailure.code) || legacyExpired || legacyAuthWiring)
      const terminal = oldEvent.published_at !== null && oldEvent.unknown_at === null && oldEvent.lease_token === null && oldEvent.lease_until === null && Boolean(oldFailure) && recoverable && (oldFailure.retryable === false || Number(oldEvent.attempts) >= input.scanMaxAttempts)
      if (!terminal) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_NOT_DEAD_LETTER')

      const competing = (await client.query<RedriveRow>(`SELECT id,workspace_id,recovery_key,asset_id,old_outbox_event_id,new_outbox_event_id,expected_asset_revision,source_revision_before,source_revision_after,actor_id,reason,scan_max_attempts,audit_id FROM asset_scan_redrives WHERE workspace_id=$1 AND old_outbox_event_id=$2`, [input.workspaceId, input.deadLetterOutboxEventId])).rows[0]
      if (competing) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_IDEMPOTENCY_CONFLICT')

      const nextRevision = input.expectedAssetRevision + 1
      const nextSourceRevision = oldSourceRevision + 1
      const next = structuredClone(current)
      next.revision = nextRevision
      next.sourceRevision = nextSourceRevision
      next.scanStatus = 'quarantined'
      for (const key of ['scanReceiptId', 'scanReceiptDigest', 'scanVerdict', 'scanCompletedAt', 'scanFindings', 'preview']) delete next[key]
      const updated = await client.query<SnapshotRow>(`UPDATE business_entity_snapshots SET entity_version=$4,payload=$5::jsonb,updated_at=now() WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2 AND entity_version=$3 RETURNING entity_version,payload`, [input.workspaceId, input.assetId, input.expectedAssetRevision, nextRevision, JSON.stringify(next)])
      if (!updated.rows[0]) throw new AssetScanRedriveError('ASSET_SCAN_REDRIVE_REVISION_CONFLICT')

      const eventId = `evt_${randomUUID()}`
      const newPayload = { asset_id: input.assetId, storage_key: storageKey, sha256, size_bytes: sizeBytes, mime_type: mimeType, source_revision: nextSourceRevision, rescan: true, recovery_from_outbox_event_id: input.deadLetterOutboxEventId, recovery_key: input.recoveryKey, authorization_snapshot: input.authorizationSnapshot }
      const newEvent = (await client.query<EventRow>(`INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES ($1,$2,$3,'asset.scan_redrive_requested',$4,$5::jsonb) RETURNING ${eventProjection}`, [eventId, input.workspaceId, input.assetId, nextRevision, JSON.stringify(newPayload)])).rows[0]!

      const auditId = randomUUID()
      await client.query(`INSERT INTO workspace_operation_audit (id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason) VALUES ($1,$2,$3,'asset.scan.recovery_requested','asset',$4,$5::jsonb,$6::jsonb,$7)`, [auditId, input.workspaceId, input.actorId, input.assetId, JSON.stringify({ outbox_event_id: input.deadLetterOutboxEventId, asset_revision: input.expectedAssetRevision, source_revision: oldSourceRevision, error_code: legacyExpired ? 'ASSET_SCAN_RECEIPT_EXPIRED' : legacyAuthWiring ? 'ASSET_SCAN_WORKER_AUTH_WIRING_FAILED' : typeof oldFailure?.code === 'string' ? oldFailure.code : 'UNKNOWN', original_error_code: typeof oldFailure?.code === 'string' ? oldFailure.code : 'UNKNOWN' }), JSON.stringify({ outbox_event_id: eventId, asset_revision: nextRevision, source_revision: nextSourceRevision, recovery_key: input.recoveryKey, authorization_decision_id: input.authorizationSnapshot.decision_id, grant_revision: input.authorizationSnapshot.grant_revision }), input.reason])
      const redriveId = `scan_redrive_${randomUUID()}`
      await client.query(`INSERT INTO asset_scan_redrives (id,workspace_id,recovery_key,asset_id,old_outbox_event_id,new_outbox_event_id,expected_asset_revision,source_revision_before,source_revision_after,actor_id,reason,scan_max_attempts,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [redriveId, input.workspaceId, input.recoveryKey, input.assetId, input.deadLetterOutboxEventId, eventId, input.expectedAssetRevision, oldSourceRevision, nextSourceRevision, input.actorId, input.reason, input.scanMaxAttempts, auditId])
      return { redriveId, auditId, replayed: false, asset: next, event: eventFromRow(newEvent) }
    })
  }
}
