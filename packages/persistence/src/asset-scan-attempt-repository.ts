import { createHash } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'
import type { PersistableAssetScanReceipt } from './asset-scan-repository.js'

export type AssetScanCallbackStatus = 'pending' | 'accepted'

export interface AssetScanAttemptRecord {
  workspaceId: string
  outboxEventId: string
  assetSourceRevision: number
  receipt: PersistableAssetScanReceipt
  canonicalReceipt: string
  signature: string
  receiptDigest: string
  callbackBody: string
  callbackStatus: AssetScanCallbackStatus
  callbackAttempts: number
  lastCallbackAt?: string
  lastCallbackError?: string
  callbackAcceptedAt?: string
  createdAt: string
}

export interface CreateAssetScanAttemptInput {
  workspaceId: string
  outboxEventId: string
  assetSourceRevision: number
  canonicalReceipt: string
  signature: string
  receiptDigest: string
  callbackBody: string
}

export interface AssetScanAttemptRepository {
  createOrGet(input: CreateAssetScanAttemptInput): Promise<{ created: boolean; record: AssetScanAttemptRecord }>
  getByOutboxEvent(workspaceId: string, outboxEventId: string): Promise<AssetScanAttemptRecord | undefined>
  recordCallbackAttempt(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; attemptedAt?: string }): Promise<AssetScanAttemptRecord>
  recordCallbackFailure(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; error: string }): Promise<AssetScanAttemptRecord>
  markCallbackAccepted(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; acceptedAt?: string }): Promise<AssetScanAttemptRecord>
}

export class AssetScanAttemptConflictError extends Error {
  readonly code = 'ASSET_SCAN_ATTEMPT_CONFLICT'
  constructor() {
    super('ASSET_SCAN_ATTEMPT_CONFLICT')
    this.name = 'AssetScanAttemptConflictError'
  }
}

const DIGEST = /^[a-f0-9]{64}$/u
// Must stay aligned with verifyAssetScanReceiptSignature. RSA signatures are
// larger than Ed25519 signatures but remain bounded base64url input.
const SIGNATURE = /^[A-Za-z0-9_-]{40,2048}$/u

function identifier(value: unknown, code: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error(code)
  return value
}

function validate(raw: CreateAssetScanAttemptInput): CreateAssetScanAttemptInput & { receipt: PersistableAssetScanReceipt } {
  const input = structuredClone(raw)
  input.workspaceId = requireWorkspaceScope(input.workspaceId)
  identifier(input.outboxEventId, 'ASSET_SCAN_ATTEMPT_OUTBOX_EVENT_REQUIRED', 128)
  if (!Number.isSafeInteger(input.assetSourceRevision) || input.assetSourceRevision < 1) throw new Error('ASSET_SCAN_ATTEMPT_SOURCE_REVISION_INVALID')
  if (!DIGEST.test(input.receiptDigest)) throw new Error('ASSET_SCAN_ATTEMPT_DIGEST_INVALID')
  if (!SIGNATURE.test(input.signature)) throw new Error('ASSET_SCAN_ATTEMPT_SIGNATURE_INVALID')
  let receipt: PersistableAssetScanReceipt
  try { receipt = JSON.parse(input.canonicalReceipt) as PersistableAssetScanReceipt } catch { throw new Error('ASSET_SCAN_ATTEMPT_CANONICAL_RECEIPT_INVALID') }
  if (JSON.stringify(receipt) !== input.canonicalReceipt) throw new Error('ASSET_SCAN_ATTEMPT_RECEIPT_NOT_CANONICAL')
  if (createHash('sha256').update(input.canonicalReceipt).digest('hex') !== input.receiptDigest) throw new Error('ASSET_SCAN_ATTEMPT_DIGEST_MISMATCH')
  if (receipt.scan_job_id !== input.outboxEventId || receipt.subject.workspace_id !== input.workspaceId || receipt.subject.asset_source_revision !== input.assetSourceRevision) throw new Error('ASSET_SCAN_ATTEMPT_BINDING_MISMATCH')
  if (input.callbackBody !== JSON.stringify({ receipt, signature: input.signature })) throw new Error('ASSET_SCAN_ATTEMPT_CALLBACK_BODY_MISMATCH')
  return { ...input, receipt }
}

function clone(record: AssetScanAttemptRecord): AssetScanAttemptRecord { return structuredClone(record) }
function key(workspaceId: string, outboxEventId: string, sourceRevision: number): string { return `${workspaceId}\0${outboxEventId}\0${sourceRevision}` }

export class MemoryAssetScanAttemptRepository implements AssetScanAttemptRepository {
  private readonly rows = new Map<string, AssetScanAttemptRecord>()

  async createOrGet(raw: CreateAssetScanAttemptInput) {
    const input = validate(raw)
    const rowKey = key(input.workspaceId, input.outboxEventId, input.assetSourceRevision)
    const existing = this.rows.get(rowKey)
    if (existing) {
      return { created: false, record: clone(existing) }
    }
    const record: AssetScanAttemptRecord = {
      workspaceId: input.workspaceId, outboxEventId: input.outboxEventId, assetSourceRevision: input.assetSourceRevision,
      receipt: structuredClone(input.receipt), canonicalReceipt: input.canonicalReceipt, signature: input.signature,
      receiptDigest: input.receiptDigest, callbackBody: input.callbackBody, callbackStatus: 'pending', callbackAttempts: 0,
      createdAt: new Date().toISOString(),
    }
    this.rows.set(rowKey, record)
    return { created: true, record: clone(record) }
  }

  async getByOutboxEvent(workspaceId: string, outboxEventId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    const eventId = identifier(outboxEventId, 'ASSET_SCAN_ATTEMPT_OUTBOX_EVENT_REQUIRED', 128)
    const rows = [...this.rows.values()].filter(row => row.workspaceId === scope && row.outboxEventId === eventId)
    if (rows.length > 1) throw new AssetScanAttemptConflictError()
    return rows[0] ? clone(rows[0]) : undefined
  }

  private require(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string }) {
    const row = this.rows.get(key(requireWorkspaceScope(input.workspaceId), input.outboxEventId, input.assetSourceRevision))
    if (!row || row.receiptDigest !== input.receiptDigest) throw new AssetScanAttemptConflictError()
    return row
  }

  async recordCallbackAttempt(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; attemptedAt?: string }) {
    const row = this.require(input)
    if (row.callbackStatus !== 'accepted') {
      row.callbackAttempts += 1
      row.lastCallbackAt = input.attemptedAt ?? new Date().toISOString()
      row.lastCallbackError = undefined
    }
    return clone(row)
  }

  async recordCallbackFailure(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; error: string }) {
    const row = this.require(input)
    if (row.callbackStatus !== 'accepted') row.lastCallbackError = identifier(input.error, 'ASSET_SCAN_ATTEMPT_CALLBACK_ERROR_REQUIRED', 2048)
    return clone(row)
  }

  async markCallbackAccepted(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; acceptedAt?: string }) {
    const row = this.require(input)
    if (row.callbackStatus !== 'accepted') {
      row.callbackStatus = 'accepted'
      row.callbackAcceptedAt = input.acceptedAt ?? new Date().toISOString()
      row.lastCallbackError = undefined
    }
    return clone(row)
  }
}

type Row = {
  workspace_id: string; outbox_event_id: string; asset_source_revision: number; receipt: PersistableAssetScanReceipt | string
  canonical_receipt: string; signature: string; receipt_digest: string; callback_body: string; callback_status: AssetScanCallbackStatus
  callback_attempts: number; last_callback_at: Date | string | null; last_callback_error: string | null; callback_accepted_at: Date | string | null; created_at: Date | string
}

const projection = 'workspace_id,outbox_event_id,asset_source_revision,receipt,canonical_receipt,signature,receipt_digest,callback_body,callback_status,callback_attempts,last_callback_at,last_callback_error,callback_accepted_at,created_at'
const iso = (value: Date | string | null): string | undefined => value == null ? undefined : value instanceof Date ? value.toISOString() : String(value)
const map = (row: Row): AssetScanAttemptRecord => ({
  workspaceId: row.workspace_id, outboxEventId: row.outbox_event_id, assetSourceRevision: Number(row.asset_source_revision),
  receipt: typeof row.receipt === 'string' ? JSON.parse(row.receipt) as PersistableAssetScanReceipt : structuredClone(row.receipt),
  canonicalReceipt: row.canonical_receipt, signature: row.signature, receiptDigest: row.receipt_digest, callbackBody: row.callback_body,
  callbackStatus: row.callback_status, callbackAttempts: Number(row.callback_attempts),
  ...(iso(row.last_callback_at) ? { lastCallbackAt: iso(row.last_callback_at) } : {}),
  ...(row.last_callback_error ? { lastCallbackError: row.last_callback_error } : {}),
  ...(iso(row.callback_accepted_at) ? { callbackAcceptedAt: iso(row.callback_accepted_at) } : {}),
  createdAt: iso(row.created_at)!,
})

export class PostgresAssetScanAttemptRepository implements AssetScanAttemptRepository {
  constructor(private readonly pool: SqlPool) {}

  async createOrGet(raw: CreateAssetScanAttemptInput) {
    const input = validate(raw)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const inserted = await client.query<Row>(
        `INSERT INTO asset_scan_attempts (workspace_id,outbox_event_id,asset_source_revision,receipt_id,receipt_digest,signature,canonical_receipt,receipt,callback_body)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text,$7::text::jsonb,$8)
         ON CONFLICT (outbox_event_id,asset_source_revision) DO NOTHING
         RETURNING ${projection}`,
        [input.workspaceId, input.outboxEventId, input.assetSourceRevision, input.receipt.receipt_id, input.receiptDigest, input.signature, input.canonicalReceipt, input.callbackBody],
      )
      if (inserted.rows[0]) return { created: true, record: map(inserted.rows[0]) }
      const found = await client.query<Row>(`SELECT ${projection} FROM asset_scan_attempts WHERE workspace_id=$1 AND outbox_event_id=$2 AND asset_source_revision=$3`, [input.workspaceId, input.outboxEventId, input.assetSourceRevision])
      if (found.rows.length !== 1) throw new AssetScanAttemptConflictError()
      return { created: false, record: map(found.rows[0]!) }
    })
  }

  async getByOutboxEvent(workspaceId: string, outboxEventId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    const eventId = identifier(outboxEventId, 'ASSET_SCAN_ATTEMPT_OUTBOX_EVENT_REQUIRED', 128)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM asset_scan_attempts WHERE workspace_id=$1 AND outbox_event_id=$2 ORDER BY asset_source_revision DESC LIMIT 2`, [scope, eventId])
      if (result.rows.length > 1) throw new AssetScanAttemptConflictError()
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }

  private async update(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string }, sql: string, values: readonly unknown[]) {
    const scope = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(`${sql} RETURNING ${projection}`, values)
      if (result.rows.length !== 1) throw new AssetScanAttemptConflictError()
      return map(result.rows[0]!)
    })
  }

  recordCallbackAttempt(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; attemptedAt?: string }) {
    return this.update(input, `UPDATE asset_scan_attempts SET callback_attempts=callback_attempts+1,last_callback_at=$5,last_callback_error=NULL WHERE workspace_id=$1 AND outbox_event_id=$2 AND asset_source_revision=$3 AND receipt_digest=$4 AND callback_status='pending'`, [input.workspaceId, input.outboxEventId, input.assetSourceRevision, input.receiptDigest, input.attemptedAt ?? new Date().toISOString()])
  }

  recordCallbackFailure(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; error: string }) {
    const error = identifier(input.error, 'ASSET_SCAN_ATTEMPT_CALLBACK_ERROR_REQUIRED', 2048)
    return this.update(input, `UPDATE asset_scan_attempts SET last_callback_error=$5 WHERE workspace_id=$1 AND outbox_event_id=$2 AND asset_source_revision=$3 AND receipt_digest=$4 AND callback_status='pending'`, [input.workspaceId, input.outboxEventId, input.assetSourceRevision, input.receiptDigest, error])
  }

  markCallbackAccepted(input: { workspaceId: string; outboxEventId: string; assetSourceRevision: number; receiptDigest: string; acceptedAt?: string }) {
    return this.update(input, `UPDATE asset_scan_attempts SET callback_status='accepted',callback_accepted_at=COALESCE(callback_accepted_at,$5),last_callback_error=NULL WHERE workspace_id=$1 AND outbox_event_id=$2 AND asset_source_revision=$3 AND receipt_digest=$4 AND callback_status IN ('pending','accepted')`, [input.workspaceId, input.outboxEventId, input.assetSourceRevision, input.receiptDigest, input.acceptedAt ?? new Date().toISOString()])
  }
}

export const InMemoryAssetScanAttemptRepository = MemoryAssetScanAttemptRepository
