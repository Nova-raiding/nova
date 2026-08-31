import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { AssetScanReceiptConflictError, MemoryAssetScanReceiptRepository, PostgresAssetScanReceiptRepository, type PersistableAssetScanReceipt } from './asset-scan-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const receipt = (overrides: Partial<PersistableAssetScanReceipt> = {}): PersistableAssetScanReceipt => ({
  schema_version: 'asset-scan-receipt/1.0',
  receipt_id: 'receipt_1',
  scan_job_id: 'job_1',
  scan_attempt_id: 'attempt_1',
  issuer: { scanner_service_id: 'scanner', scanner_instance_id: 'scanner-1', key_id: 'key-1' },
  subject: { workspace_id: 'ws_scan', asset_id: 'asset_1', asset_source_revision: 1, object_key: 'quarantine/ws_scan/asset_1/source', sha256: 'a'.repeat(64), size_bytes: 4, mime_type: 'image/png' },
  scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.4.6', definitions_version: '20260830', policy_version: 'v1', started_at: '2026-08-30T01:00:00.000Z', completed_at: '2026-08-30T01:00:01.000Z', findings: [] },
  issued_at: '2026-08-30T01:00:01.000Z',
  expires_at: '2026-08-30T01:05:01.000Z',
  ...overrides,
})

const digest = (value: PersistableAssetScanReceipt) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const input = (value = receipt()) => ({ receipt: value, receiptDigest: digest(value), signature: 'A'.repeat(86) })

describe('MemoryAssetScanReceiptRepository', () => {
  it('persists bounded RSA-sized base64url signatures', async () => {
    const repository = new MemoryAssetScanReceiptRepository()
    const saved = await repository.append({ ...input(), signature: 'A'.repeat(342) })

    expect(saved.record.signature).toHaveLength(342)
  })

  it('rejects oversized signatures', async () => {
    const repository = new MemoryAssetScanReceiptRepository()

    await expect(repository.append({ ...input(), signature: 'A'.repeat(2049) })).rejects.toThrow('ASSET_SCAN_RECEIPT_SIGNATURE_INVALID')
  })

  it('appends once and returns an identical replay without mutation', async () => {
    const repository = new MemoryAssetScanReceiptRepository()
    const first = await repository.append(input())
    const replay = await repository.append(input())
    expect(first.created).toBe(true)
    expect(replay).toEqual({ created: false, record: first.record })
    expect(await repository.getByReceiptId('ws_scan', 'receipt_1')).toEqual(first.record)
    expect(await repository.getByReceiptId('another_workspace', 'receipt_1')).toBeUndefined()
    expect(await repository.getByAssetRevision({ workspaceId: 'ws_scan', assetId: 'asset_1', sourceRevision: 1 })).toEqual(first.record)
  })

  it('rejects receipt id, digest, and asset revision reuse with different content', async () => {
    const repository = new MemoryAssetScanReceiptRepository()
    const original = input()
    await repository.append(original)

    const sameIdDifferentDigest = receipt({ scan_attempt_id: 'attempt_2' })
    await expect(repository.append(input(sameIdDifferentDigest))).rejects.toBeInstanceOf(AssetScanReceiptConflictError)

    const sameDigestDifferentId = receipt({ receipt_id: 'receipt_2' })
    await expect(repository.append({ ...input(sameDigestDifferentId), receiptDigest: original.receiptDigest })).rejects.toThrow('ASSET_SCAN_RECEIPT_DIGEST_MISMATCH')

    const sameRevisionDifferentReceipt = receipt({ receipt_id: 'receipt_3', scan_attempt_id: 'attempt_3' })
    await expect(repository.append(input(sameRevisionDifferentReceipt))).rejects.toBeInstanceOf(AssetScanReceiptConflictError)
  })

  it('returns defensive copies so callers cannot update persisted evidence', async () => {
    const repository = new MemoryAssetScanReceiptRepository()
    const saved = await repository.append(input())
    saved.record.receipt.subject.asset_id = 'mutated'
    expect((await repository.getByReceiptId('ws_scan', 'receipt_1'))?.receipt.subject.asset_id).toBe('asset_1')
  })

  it('rejects a supplied digest that is not bound to the canonical receipt payload', async () => {
    const repository = new MemoryAssetScanReceiptRepository()
    await expect(repository.append({ ...input(), receiptDigest: 'f'.repeat(64) })).rejects.toThrow('ASSET_SCAN_RECEIPT_DIGEST_MISMATCH')
  })
})

type Row = Record<string, unknown>
class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly responses: Array<{ rows: Row[] }> = []) {}
  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text === 'BEGIN' || text.startsWith('SELECT set_config') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as T[] }
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}
class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const row = (value = receipt()): Row => ({
  receipt_id: value.receipt_id,
  workspace_id: value.subject.workspace_id,
  asset_id: value.subject.asset_id,
  asset_source_revision: value.subject.asset_source_revision,
  receipt_digest: digest(value),
  signature: 'A'.repeat(86),
  canonical_payload: JSON.stringify(value),
  created_at: '2026-08-30T01:00:02.000Z',
})

describe('PostgresAssetScanReceiptRepository', () => {
  it('inserts the immutable receipt and scopes the transaction to its workspace', async () => {
    const client = new RecordingClient([{ rows: [row()] }])
    const result = await new PostgresAssetScanReceiptRepository(new RecordingPool(client)).append(input())
    expect(result.created).toBe(true)
    expect(client.calls.find(call => call.text.startsWith('SELECT set_config'))?.values).toEqual(['ws_scan'])
    const insert = client.calls.find(call => call.text.includes('INSERT INTO asset_scan_receipts'))
    expect(insert?.text).toContain('ON CONFLICT DO NOTHING')
    expect(insert?.values?.slice(0, 6)).toEqual(['receipt_1', 'ws_scan', 'asset_1', 1, input().receiptDigest, 'A'.repeat(86)])
  })

  it('returns an exact replay and rejects a conflicting occupied key', async () => {
    const exact = row()
    const replayClient = new RecordingClient([{ rows: [] }, { rows: [exact] }])
    await expect(new PostgresAssetScanReceiptRepository(new RecordingPool(replayClient)).append(input())).resolves.toMatchObject({ created: false })

    const conflicting = row(receipt({ scan_attempt_id: 'different' }))
    const conflictClient = new RecordingClient([{ rows: [] }, { rows: [conflicting] }])
    await expect(new PostgresAssetScanReceiptRepository(new RecordingPool(conflictClient)).append(input())).rejects.toBeInstanceOf(AssetScanReceiptConflictError)
    expect(conflictClient.calls.some(call => call.text === 'ROLLBACK')).toBe(true)
  })
})
