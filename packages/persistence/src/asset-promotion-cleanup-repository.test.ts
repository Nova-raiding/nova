import { describe, expect, it } from 'vitest'
import { MemoryAssetPromotionCleanupRepository, PostgresAssetPromotionCleanupRepository } from './asset-promotion-cleanup-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const binding = { workspaceId: 'ws_cleanup', receiptId: 'receipt_cleanup', assetId: 'asset_cleanup', assetSourceRevision: 1, quarantineKey: 'quarantine/ws_cleanup/asset_cleanup/source.png', cleanKey: 'clean/ws_cleanup/asset_cleanup/source.png', scanEvidenceRef: `scan-receipt://receipt_cleanup/${'a'.repeat(64)}`, objectSha256: 'b'.repeat(64), sizeBytes: 7, readyOutboxEventId: 'evt_ready' }

describe('MemoryAssetPromotionCleanupRepository', () => {
  it('keeps immutable binding and converges repeated completion', async () => {
    const repository = new MemoryAssetPromotionCleanupRepository()
    const first = repository.create(binding)
    const replay = repository.create(binding)
    expect(first.created).toBe(true); expect(replay.created).toBe(false); expect(replay.task.cleanupId).toBe(first.task.cleanupId)
    await expect(() => repository.create({ ...binding, objectSha256: 'c'.repeat(64) })).toThrow()
    const [claimed] = await repository.claimPending(binding.workspaceId, { now: first.task.nextAttemptAt })
    expect(claimed?.leaseToken).toBeTruthy()
    const failed = await repository.recordFailure({ workspaceId: binding.workspaceId, cleanupId: first.task.cleanupId, leaseToken: claimed!.leaseToken, error: { code: 'provider_down' }, nextAttemptAt: '2026-08-30T02:00:00.000Z' })
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'provider_down' } })
    const completed = await repository.markCompleted({ workspaceId: binding.workspaceId, cleanupId: first.task.cleanupId })
    expect(completed.status).toBe('completed')
    expect((await repository.markCompleted({ workspaceId: binding.workspaceId, cleanupId: first.task.cleanupId })).completedAt).toBe(completed.completedAt)
  })
})

class Client implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async query<T>(text: string, values?: readonly unknown[]) { this.calls.push({ text, values }); if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.startsWith('SELECT set_config')) return { rows: [] as T[] }; return { rows: this.rows.splice(0) as T[] } }
  release() {}
}
class TestPool implements SqlPool { constructor(private readonly client: Client) {} async connect() { return this.client } }

describe('PostgresAssetPromotionCleanupRepository', () => {
  it('creates the durable task in a caller-owned transaction', async () => {
    const row = { cleanup_id: 'cleanup_1', workspace_id: binding.workspaceId, receipt_id: binding.receiptId, asset_id: binding.assetId, asset_source_revision: 1, quarantine_key: binding.quarantineKey, clean_key: binding.cleanKey, scan_evidence_ref: binding.scanEvidenceRef, object_sha256: binding.objectSha256, size_bytes: 7, ready_outbox_event_id: binding.readyOutboxEventId, status: 'pending', attempts: 0, next_attempt_at: '2026-08-30T01:00:00.000Z', lease_token: null, lease_until: null, last_error: null, completed_at: null, created_at: '2026-08-30T01:00:00.000Z', updated_at: '2026-08-30T01:00:00.000Z' }
    const client = new Client([row])
    const repository = new PostgresAssetPromotionCleanupRepository(new TestPool(client))
    expect(await repository.createInTransaction(client, binding)).toMatchObject({ created: true, task: { cleanupId: 'cleanup_1', quarantineKey: binding.quarantineKey } })
    expect(client.calls.some(call => call.text.includes('INSERT INTO asset_promotion_cleanup_tasks'))).toBe(true)
    expect(client.calls.some(call => call.text === 'BEGIN')).toBe(false)
  })
})
