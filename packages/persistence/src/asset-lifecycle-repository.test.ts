import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'
import { PostgresAssetLifecycleRepository } from './asset-lifecycle-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>
class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[]; rowCount?: number }> = []
  enqueue(rows: Row[] = []) { this.responses.push({ rows }) }
  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[]; rowCount?: number }
  }
  release() {}
}
class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const dbRow = (overrides: Row = {}): Row => ({
  workspace_id: 'ws_asset', asset_id: 'asset-1', deleted_at: new Date('2026-09-01T00:00:00Z'),
  expires_at: new Date('2026-09-08T00:00:00Z'), deleted_by: 'merchant', restored_at: null,
  purge_requested_at: null, purge_requested_by: null, purge_request_reason: null,
  restored_by: null, purged_at: null, purge_attempts: 0, purge_error: null, revision: 1,
  ...overrides,
})

describe('PostgresAssetLifecycleRepository', () => {
  it('checks the tenant asset snapshot and writes seven-day trash state plus audit in one workspace transaction', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([{ entity_id: 'asset-1' }]); client.enqueue([dbRow()]); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    const trashed = await repository.trash({ workspaceId: 'ws_asset', assetId: 'asset-1', actorId: 'merchant', now: '2026-09-01T00:00:00Z' })
    expect(trashed).toMatchObject({ workspaceId: 'ws_asset', assetId: 'asset-1', revision: 1, deletedBy: 'merchant' })
    expect(client.calls.map(call => call.text)).toEqual([
      'BEGIN', "SELECT set_config('app.workspace_id', $1, true)",
      expect.stringContaining("entity_type='asset' AND entity_id=$2 FOR KEY SHARE"),
      expect.stringContaining('ON CONFLICT (workspace_id,asset_id)'),
      expect.stringContaining('merchant_asset_lifecycle_events'), 'COMMIT',
    ])
    expect(client.calls[2]?.values).toEqual(['ws_asset', 'asset-1'])
    expect(client.calls[3]?.values?.[3]).toBe('2026-09-08T00:00:00.000Z')
    expect(client.calls[3]?.text).toContain('merchant_asset_lifecycle.revision=$6')
  })

  it('does not permit trashing an unknown or cross-workspace snapshot', async () => {
    const client = new RecordingClient(); client.enqueue(); client.enqueue(); client.enqueue([]); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    await expect(repository.trash({ workspaceId: 'ws_asset', assetId: 'asset-other', actorId: 'merchant' })).rejects.toThrow('ASSET_LIFECYCLE_ASSET_NOT_FOUND')
    expect(client.calls.some(call => call.text.startsWith('INSERT INTO merchant_asset_lifecycle '))).toBe(false)
  })

  it('uses lifecycle revision CAS and refuses restore after the retention deadline', async () => {
    const client = new RecordingClient(); client.enqueue(); client.enqueue(); client.enqueue([{ entity_id: 'asset-1' }]); client.enqueue([]); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    await expect(repository.restore({ workspaceId: 'ws_asset', assetId: 'asset-1', actorId: 'merchant', expectedRevision: 3, now: '2026-09-09T00:00:00Z' })).rejects.toThrow('ASSET_LIFECYCLE_RESTORE_UNAVAILABLE')
    expect(client.calls[3]?.text).toContain('expires_at>GREATEST($3::timestamptz, clock_timestamp())')
    expect(client.calls[3]?.text).toContain('purge_lease_token IS NULL')
    expect(client.calls[3]?.text).toContain('revision=$5')
  })

  it('requests audited early purge with revision CAS and retains the row for worker retry', async () => {
    const client = new RecordingClient(); client.enqueue(); client.enqueue(); client.enqueue([dbRow({ purge_requested_at: new Date('2026-09-01T01:00:00Z'), purge_requested_by: 'merchant', purge_request_reason: '素材内容已确认需要删除', revision: 2 })]); client.enqueue(); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    const requested = await repository.requestEarlyPurge({ workspaceId: 'ws_asset', assetId: 'asset-1', actorId: 'merchant', reason: '素材内容已确认需要删除', expectedRevision: 1, now: '2026-09-01T01:00:00Z' })
    expect(requested).toMatchObject({ purgeRequestedBy: 'merchant', purgeRequestReason: '素材内容已确认需要删除', revision: 2 })
    expect(client.calls[2]?.text).toContain('revision=$3')
    expect(client.calls[2]?.text).toContain('purge_lease_token IS NULL')
    expect(client.calls[3]?.values?.[3]).toBe('early_purge_requested')
    expect(client.calls[3]?.values?.[6]).toContain('素材内容已确认需要删除')
  })

  it('permits cancellation only before a worker lease and records cancellation', async () => {
    const client = new RecordingClient(); client.enqueue(); client.enqueue(); client.enqueue([dbRow({ revision: 3 })]); client.enqueue(); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    const cancelled = await repository.cancelEarlyPurge({ workspaceId: 'ws_asset', assetId: 'asset-1', actorId: 'merchant', expectedRevision: 2, now: '2026-09-01T02:00:00Z' })
    expect(cancelled).toMatchObject({ revision: 3 })
    expect(client.calls[2]?.text).toContain('purge_lease_token IS NULL')
    expect(client.calls[2]?.text).toContain('expires_at>GREATEST($4::timestamptz,clock_timestamp())')
    expect(client.calls[3]?.values?.[3]).toBe('purge_request_cancelled')
  })

  it('applies accessible asset IDs to both recycle-bin rows and the total count', async () => {
    const client = new RecordingClient(); client.enqueue(); client.enqueue(); client.enqueue([{ total: 1 }]); client.enqueue([dbRow()]); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    const page = await repository.listTrash('ws_asset', { assetIds: ['asset-1'], limit: 10 })
    expect(page.total).toBe(1)
    expect(client.calls[2]?.text).toContain('asset_id=ANY($3::text[])')
    expect(client.calls[2]?.values).toEqual(['ws_asset', expect.any(String), ['asset-1']])
    expect(client.calls[3]?.text).toContain('asset_id=ANY($3::text[])')
    expect(client.calls[3]?.values).toEqual(['ws_asset', expect.any(String), ['asset-1'], 10, 0])
  })

  it('claims expired records with skip-locked leases and fences purge completion by lease token', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([dbRow({ deleted_at: new Date('2026-09-01T00:00:00Z'), expires_at: new Date('2026-09-08T00:00:00Z'), purge_lease_token: 'lease-1', purge_lease_until: new Date('2026-09-08T00:01:00Z') })]); client.enqueue(); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    const claim = await repository.claimExpired({ workspaceId: 'ws_asset', workerId: 'worker', now: '2026-09-08T00:00:00Z' })
    expect(claim[0]).toMatchObject({ assetId: 'asset-1', leaseToken: 'lease-1' })
    expect(client.calls[2]?.text).toContain('FOR UPDATE SKIP LOCKED')
    expect(client.calls[3]?.values?.[3]).toBe('purge_claimed')
  })

  it('prevents restore from racing a claimed purge or a stale pre-expiry request', async () => {
    const client = new RecordingClient(); client.enqueue(); client.enqueue(); client.enqueue([{ entity_id: 'asset-1' }]); client.enqueue([]); client.enqueue()
    const repository = new PostgresAssetLifecycleRepository(new RecordingPool(client))
    await expect(repository.restore({ workspaceId: 'ws_asset', assetId: 'asset-1', actorId: 'merchant', now: '2026-09-01T23:59:59Z' })).rejects.toThrow('ASSET_LIFECYCLE_RESTORE_UNAVAILABLE')
    const update = client.calls[3]?.text ?? ''
    expect(update).toContain('purge_lease_token IS NULL')
    expect(update).toContain('GREATEST($3::timestamptz, clock_timestamp())')
  })

  it('records purge success only with a valid lease and records retryable failures', async () => {
    const completedClient = new RecordingClient(); completedClient.enqueue(); completedClient.enqueue(); completedClient.enqueue([dbRow({ deleted_at: new Date('2026-09-01T00:00:00Z'), expires_at: new Date('2026-09-08T00:00:00Z'), purged_at: new Date('2026-09-08T00:00:00Z'), revision: 2 })]); completedClient.enqueue(); completedClient.enqueue()
    const completed = await new PostgresAssetLifecycleRepository(new RecordingPool(completedClient)).completePurge({ workspaceId: 'ws_asset', assetId: 'asset-1', workerId: 'worker', leaseToken: 'lease-1', now: '2026-09-08T00:00:00Z' })
    expect(completed).toMatchObject({ purgedAt: '2026-09-08T00:00:00.000Z', revision: 2 })
    expect(completedClient.calls[2]?.text).toContain('purge_lease_token=$3')
    expect(completedClient.calls[2]?.text).toContain('purge_lease_until>GREATEST($4::timestamptz,clock_timestamp())')
    expect(completedClient.calls[3]?.values?.[3]).toBe('purged')

    const failedClient = new RecordingClient(); failedClient.enqueue(); failedClient.enqueue(); failedClient.enqueue([dbRow({ purge_attempts: 1, purge_error: { code: 'OBJECT_STORE_TIMEOUT' } })]); failedClient.enqueue(); failedClient.enqueue()
    const failed = await new PostgresAssetLifecycleRepository(new RecordingPool(failedClient)).failPurge({ workspaceId: 'ws_asset', assetId: 'asset-1', workerId: 'worker', leaseToken: 'lease-1', error: { code: 'OBJECT_STORE_TIMEOUT' } })
    expect(failed).toMatchObject({ purgeAttempts: 1, purgeError: { code: 'OBJECT_STORE_TIMEOUT' } })
    expect(failedClient.calls[3]?.values?.[3]).toBe('purge_failed')
    expect(failedClient.calls[2]?.text).toContain('purge_lease_until>GREATEST($5::timestamptz,clock_timestamp())')
    expect(failedClient.calls[2]?.values).toEqual(['ws_asset', 'asset-1', 'lease-1', JSON.stringify({ code: 'OBJECT_STORE_TIMEOUT' }), expect.any(String)])
  })

  it('keeps migration 256 tenant scoped and lifecycle event history append-only', async () => {
    const migrations = await loadMigrations()
    const migration = migrations.find(item => item.version === 256)
    expect(migration?.name).toBe('asset_lifecycle')
    expect(migration?.sql).toContain("entity_type = 'asset' AND entity_id = NEW.asset_id")
    for (const table of ['merchant_asset_lifecycle', 'merchant_asset_lifecycle_events']) {
      expect(migration?.sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration?.sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      expect(migration?.sql).toContain(`CREATE POLICY ${table}_workspace_isolation`)
    }
    expect(migration?.sql).toContain('merchant_asset_lifecycle_events_append_only')
    expect(migration?.sql).toContain('early_purge_requested')
    expect(migration?.sql).toContain('purge_request_reason')
    expect(migration?.sql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER')
  })
})
