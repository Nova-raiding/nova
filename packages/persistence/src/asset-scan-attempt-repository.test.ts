import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AssetScanAttemptConflictError, MemoryAssetScanAttemptRepository, PostgresAssetScanAttemptRepository } from './asset-scan-attempt-repository.js'
import type { PersistableAssetScanReceipt } from './asset-scan-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const receipt = (attempt = 'attempt_a'): PersistableAssetScanReceipt => ({
  schema_version: 'asset-scan-receipt/1.0', receipt_id: `receipt_${attempt}`, scan_job_id: 'evt_scan', scan_attempt_id: attempt,
  issuer: { scanner_service_id: 'scanner', scanner_instance_id: 'scanner-1', key_id: 'key-1' },
  subject: { workspace_id: 'ws_scan', asset_id: 'asset_1', asset_source_revision: 3, object_key: 'quarantine/ws_scan/asset_1/source', sha256: 'a'.repeat(64), size_bytes: 4, mime_type: 'image/png' },
  scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.4.6', definitions_version: '28108', policy_version: 'v1', started_at: '2026-08-30T01:00:00.000Z', completed_at: '2026-08-30T01:00:01.000Z', findings: [] },
  issued_at: '2026-08-30T01:00:01.000Z', expires_at: '2026-08-30T01:05:01.000Z',
})

const input = (value = receipt()) => {
  const canonicalReceipt = JSON.stringify(value)
  const signature = 'A'.repeat(86)
  return { workspaceId: 'ws_scan', outboxEventId: 'evt_scan', assetSourceRevision: 3, canonicalReceipt, signature, receiptDigest: createHash('sha256').update(canonicalReceipt).digest('hex'), callbackBody: JSON.stringify({ receipt: value, signature }) }
}

describe('MemoryAssetScanAttemptRepository', () => {
  it('persists bounded RSA-sized base64url signatures', async () => {
    const repository = new MemoryAssetScanAttemptRepository()
    const candidate = input()
    const signature = 'A'.repeat(342)
    const saved = await repository.createOrGet({ ...candidate, signature, callbackBody: JSON.stringify({ receipt: JSON.parse(candidate.canonicalReceipt), signature }) })

    expect(saved.record.signature).toHaveLength(342)
  })

  it('rejects oversized signatures', async () => {
    const repository = new MemoryAssetScanAttemptRepository()
    const candidate = input()
    const signature = 'A'.repeat(2049)

    await expect(repository.createOrGet({ ...candidate, signature, callbackBody: JSON.stringify({ receipt: JSON.parse(candidate.canonicalReceipt), signature }) })).rejects.toThrow('ASSET_SCAN_ATTEMPT_SIGNATURE_INVALID')
  })

  it('keeps the first canonical callback bytes across competing scanner replicas', async () => {
    const repository = new MemoryAssetScanAttemptRepository()
    const first = await repository.createOrGet(input(receipt('winner')))
    const loser = await repository.createOrGet(input(receipt('loser')))
    expect(first.created).toBe(true)
    expect(loser.created).toBe(false)
    expect(loser.record.callbackBody).toBe(first.record.callbackBody)
    expect(loser.record.receiptDigest).toBe(first.record.receiptDigest)
  })

  it('tracks callback delivery without allowing a different digest to update the attempt', async () => {
    const repository = new MemoryAssetScanAttemptRepository()
    const saved = (await repository.createOrGet(input())).record
    await expect(repository.recordCallbackAttempt({ workspaceId: 'ws_scan', outboxEventId: 'evt_scan', assetSourceRevision: 3, receiptDigest: 'f'.repeat(64) })).rejects.toBeInstanceOf(AssetScanAttemptConflictError)
    expect(await repository.recordCallbackAttempt({ workspaceId: 'ws_scan', outboxEventId: 'evt_scan', assetSourceRevision: 3, receiptDigest: saved.receiptDigest, attemptedAt: '2026-08-30T01:00:02.000Z' })).toMatchObject({ callbackStatus: 'pending', callbackAttempts: 1 })
    expect(await repository.recordCallbackFailure({ workspaceId: 'ws_scan', outboxEventId: 'evt_scan', assetSourceRevision: 3, receiptDigest: saved.receiptDigest, error: 'response lost' })).toMatchObject({ callbackStatus: 'pending', lastCallbackError: 'response lost' })
    expect(await repository.markCallbackAccepted({ workspaceId: 'ws_scan', outboxEventId: 'evt_scan', assetSourceRevision: 3, receiptDigest: saved.receiptDigest, acceptedAt: '2026-08-30T01:00:03.000Z' })).toMatchObject({ callbackStatus: 'accepted', callbackAttempts: 1 })
  })
})

type Row = Record<string, unknown>
class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly responses: Array<{ rows: Row[] }>) {}
  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text === 'BEGIN' || text.startsWith('SELECT set_config') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as T[] }
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}
class RecordingPool implements SqlPool { constructor(private readonly client: RecordingClient) {} async connect() { return this.client } }

describe('PostgresAssetScanAttemptRepository', () => {
  it('uses the composite conflict target and returns the stored winner', async () => {
    const candidate = input()
    const winner = {
      workspace_id: candidate.workspaceId, outbox_event_id: candidate.outboxEventId, asset_source_revision: candidate.assetSourceRevision,
      receipt: JSON.parse(candidate.canonicalReceipt), canonical_receipt: candidate.canonicalReceipt, signature: candidate.signature,
      receipt_digest: candidate.receiptDigest, callback_body: candidate.callbackBody, callback_status: 'pending', callback_attempts: 0,
      last_callback_at: null, last_callback_error: null, callback_accepted_at: null, created_at: '2026-08-30T01:00:01.000Z',
    }
    const client = new RecordingClient([{ rows: [] }, { rows: [winner] }])
    const result = await new PostgresAssetScanAttemptRepository(new RecordingPool(client)).createOrGet(candidate)
    expect(result).toMatchObject({ created: false, record: { callbackBody: candidate.callbackBody, receiptDigest: candidate.receiptDigest } })
    expect(client.calls.find(call => call.text.includes('INSERT INTO asset_scan_attempts'))?.text).toContain('ON CONFLICT (outbox_event_id,asset_source_revision) DO NOTHING')
  })
})
