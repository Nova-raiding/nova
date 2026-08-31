import { createHash } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

/** Persistence port for security's AssetScanReceipt. Kept structural so this
 * package does not acquire a reverse source/build dependency on security. */
export interface PersistableAssetScanReceipt {
  schema_version: 'asset-scan-receipt/1.0'
  receipt_id: string
  scan_job_id: string
  scan_attempt_id: string
  issuer: { scanner_service_id: string; scanner_instance_id: string; key_id: string }
  subject: { workspace_id: string; asset_id: string; asset_source_revision: number; object_key: string; sha256: string; size_bytes: number; mime_type: string }
  scan: { verdict: 'clean' | 'malicious' | 'suspicious' | 'unsupported'; engine: string; engine_version: string; definitions_version: string; policy_version: string; started_at: string; completed_at: string; findings: string[] }
  issued_at: string
  expires_at: string
}

export interface AssetScanReceiptRecord {
  receipt: PersistableAssetScanReceipt
  receiptDigest: string
  signature: string
  createdAt: string
}

export interface AppendAssetScanReceiptInput {
  receipt: PersistableAssetScanReceipt
  receiptDigest: string
  signature: string
}

export interface AppendAssetScanReceiptResult {
  created: boolean
  record: AssetScanReceiptRecord
}

export interface AssetScanReceiptRepository {
  append(input: AppendAssetScanReceiptInput): Promise<AppendAssetScanReceiptResult>
  getByReceiptId(workspaceId: string, receiptId: string): Promise<AssetScanReceiptRecord | undefined>
  getByAssetRevision(input: { workspaceId: string; assetId: string; sourceRevision: number }): Promise<AssetScanReceiptRecord | undefined>
}

export class AssetScanReceiptConflictError extends Error {
  readonly code = 'ASSET_SCAN_RECEIPT_CONFLICT'
  constructor() {
    super('ASSET_SCAN_RECEIPT_CONFLICT')
    this.name = 'AssetScanReceiptConflictError'
  }
}

const DIGEST = /^[a-f0-9]{64}$/u
// Keep the immutable receipt ledger aligned with the verifier and durable
// attempt repository. RSA-2048 signatures are 342 base64url characters.
const SIGNATURE = /^[A-Za-z0-9_-]{40,2048}$/u

function identifier(value: unknown, code: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error(code)
  return value
}

function validate(input: AppendAssetScanReceiptInput): AppendAssetScanReceiptInput {
  const workspaceId = requireWorkspaceScope(input.receipt.subject.workspace_id)
  identifier(workspaceId, 'ASSET_SCAN_RECEIPT_WORKSPACE_REQUIRED', 128)
  identifier(input.receipt.receipt_id, 'ASSET_SCAN_RECEIPT_ID_REQUIRED', 128)
  identifier(input.receipt.subject.asset_id, 'ASSET_SCAN_RECEIPT_ASSET_ID_REQUIRED', 128)
  if (!Number.isSafeInteger(input.receipt.subject.asset_source_revision) || input.receipt.subject.asset_source_revision < 1) throw new Error('ASSET_SCAN_RECEIPT_SOURCE_REVISION_INVALID')
  if (!DIGEST.test(input.receiptDigest)) throw new Error('ASSET_SCAN_RECEIPT_DIGEST_INVALID')
  if (!SIGNATURE.test(input.signature)) throw new Error('ASSET_SCAN_RECEIPT_SIGNATURE_INVALID')
  const actualDigest = createHash('sha256').update(JSON.stringify(input.receipt)).digest('hex')
  if (actualDigest !== input.receiptDigest) throw new Error('ASSET_SCAN_RECEIPT_DIGEST_MISMATCH')
  return structuredClone(input)
}

function same(left: AssetScanReceiptRecord, input: AppendAssetScanReceiptInput): boolean {
  return left.receiptDigest === input.receiptDigest
    && left.signature === input.signature
    && JSON.stringify(left.receipt) === JSON.stringify(input.receipt)
}

function clone(record: AssetScanReceiptRecord): AssetScanReceiptRecord {
  return structuredClone(record)
}

export class MemoryAssetScanReceiptRepository implements AssetScanReceiptRepository {
  private readonly byId = new Map<string, AssetScanReceiptRecord>()
  private readonly byDigest = new Map<string, AssetScanReceiptRecord>()
  private readonly byAssetRevision = new Map<string, AssetScanReceiptRecord>()

  async append(raw: AppendAssetScanReceiptInput): Promise<AppendAssetScanReceiptResult> {
    const input = validate(raw)
    const receipt = input.receipt
    const assetRevisionKey = `${receipt.subject.workspace_id}\0${receipt.subject.asset_id}\0${receipt.subject.asset_source_revision}`
    const candidates = [this.byId.get(receipt.receipt_id), this.byDigest.get(input.receiptDigest), this.byAssetRevision.get(assetRevisionKey)].filter((row): row is AssetScanReceiptRecord => Boolean(row))
    if (candidates.length) {
      const replay = candidates[0]!
      if (candidates.some(row => row !== replay) || !same(replay, input)) throw new AssetScanReceiptConflictError()
      return { created: false, record: clone(replay) }
    }
    const record: AssetScanReceiptRecord = Object.freeze({ ...input, receipt: structuredClone(receipt), createdAt: new Date().toISOString() })
    this.byId.set(receipt.receipt_id, record)
    this.byDigest.set(input.receiptDigest, record)
    this.byAssetRevision.set(assetRevisionKey, record)
    return { created: true, record: clone(record) }
  }

  async getByReceiptId(workspaceId: string, receiptId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    const row = this.byId.get(identifier(receiptId, 'ASSET_SCAN_RECEIPT_ID_REQUIRED', 128))
    return row?.receipt.subject.workspace_id === scope ? clone(row) : undefined
  }

  async getByAssetRevision(input: { workspaceId: string; assetId: string; sourceRevision: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_SCAN_RECEIPT_ASSET_ID_REQUIRED', 128)
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) throw new Error('ASSET_SCAN_RECEIPT_SOURCE_REVISION_INVALID')
    const row = this.byAssetRevision.get(`${workspaceId}\0${assetId}\0${input.sourceRevision}`)
    return row ? clone(row) : undefined
  }
}

type Row = {
  receipt_id: string
  workspace_id: string
  asset_id: string
  asset_source_revision: number
  receipt_digest: string
  signature: string
  canonical_payload: string
  created_at: string | Date
}

const projection = 'receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,canonical_payload,created_at'
const map = (row: Row): AssetScanReceiptRecord => ({ receipt: JSON.parse(row.canonical_payload) as PersistableAssetScanReceipt, receiptDigest: row.receipt_digest, signature: row.signature, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at) })

export class PostgresAssetScanReceiptRepository implements AssetScanReceiptRepository {
  constructor(private readonly pool: SqlPool) {}

  async append(raw: AppendAssetScanReceiptInput): Promise<AppendAssetScanReceiptResult> {
    const input = validate(raw)
    const subject = input.receipt.subject
    return withWorkspaceTransaction(this.pool, subject.workspace_id, client => this.appendInTransaction(client, input))
  }

  /** Append inside the caller-owned workspace transaction. The receipt must be
   * written before a clean asset snapshot so migration 086's trust trigger can
   * observe the immutable ledger row in the same commit. */
  async appendInTransaction(client: SqlClient, raw: AppendAssetScanReceiptInput): Promise<AppendAssetScanReceiptResult> {
    const input = validate(raw)
    const subject = input.receipt.subject
    const inserted = await client.query<Row>(
        `INSERT INTO asset_scan_receipts (receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,verdict,object_key,object_sha256,canonical_payload,receipt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text,$10::text::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING ${projection}`,
        [input.receipt.receipt_id, subject.workspace_id, subject.asset_id, subject.asset_source_revision, input.receiptDigest, input.signature, input.receipt.scan.verdict, subject.object_key, subject.sha256, JSON.stringify(input.receipt)],
      )
    if (inserted.rows[0]) return { created: true, record: map(inserted.rows[0]) }
    const existing = await client.query<Row>(
        `SELECT ${projection} FROM asset_scan_receipts
         WHERE receipt_id=$1 OR receipt_digest=$2 OR (workspace_id=$3 AND asset_id=$4 AND asset_source_revision=$5)
         ORDER BY receipt_id LIMIT 2`,
        [input.receipt.receipt_id, input.receiptDigest, subject.workspace_id, subject.asset_id, subject.asset_source_revision],
      )
    if (existing.rows.length !== 1) throw new AssetScanReceiptConflictError()
    const record = map(existing.rows[0]!)
    if (!same(record, input)) throw new AssetScanReceiptConflictError()
    return { created: false, record }
  }

  async getByReceiptId(workspaceId: string, receiptId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    const id = identifier(receiptId, 'ASSET_SCAN_RECEIPT_ID_REQUIRED', 128)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM asset_scan_receipts WHERE workspace_id=$1 AND receipt_id=$2`, [scope, id])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }

  async getByAssetRevision(input: { workspaceId: string; assetId: string; sourceRevision: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_SCAN_RECEIPT_ASSET_ID_REQUIRED', 128)
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) throw new Error('ASSET_SCAN_RECEIPT_SOURCE_REVISION_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM asset_scan_receipts WHERE workspace_id=$1 AND asset_id=$2 AND asset_source_revision=$3`, [workspaceId, assetId, input.sourceRevision])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }
}

export const InMemoryAssetScanReceiptRepository = MemoryAssetScanReceiptRepository
