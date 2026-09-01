import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AssetScanRedriveError, PostgresAssetScanRedriveRepository } from './asset-scan-redrive-repository.js'
import { loadMigrations } from './migration.js'

describe('migration 109 asset scan redrive', () => {
  it('registers the next complete migration and preserves outbox evidence', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 109)).toMatchObject({ version: 109, name: 'asset_scan_redrive' })
    const latestVersion = Math.max(...migrations.map(item => item.version))
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: latestVersion }, (_, index) => index + 1))
    const sql = await readFile(new URL('./migrations/109_asset_scan_redrive.sql', import.meta.url), 'utf8')
    expect(sql).toContain('outbox event identity and payload are immutable')
    expect(sql).toContain('outbox events are durable and cannot be deleted')
    expect(sql).toContain('BEFORE TRUNCATE ON outbox_events')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE outbox_events FROM merchant_app')
    expect(sql).toContain('GRANT UPDATE (published_at,attempts,next_attempt_at,lease_token,lease_until,last_error,unknown_at)')
    expect(sql).not.toMatch(/DELETE\s+FROM\s+(outbox_events|asset_scan_attempts|asset_scan_receipts)/iu)
  })

  it('makes redrive evidence append-only and tenant scoped', async () => {
    const sql = await readFile(new URL('./migrations/109_asset_scan_redrive.sql', import.meta.url), 'utf8')
    const repository = await readFile(new URL('./asset-scan-redrive-repository.ts', import.meta.url), 'utf8')
    const localRole = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS asset_scan_redrives')
    expect(sql).toContain('UNIQUE (workspace_id,recovery_key)')
    expect(sql).toContain('UNIQUE (workspace_id,old_outbox_event_id)')
    expect(sql).toContain('ALTER TABLE asset_scan_redrives FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("workspace_id = current_setting('app.workspace_id', true)")
    expect(sql).toContain('asset scan redrive evidence is immutable and cannot be deleted')
    expect(sql).toContain('BEFORE TRUNCATE ON asset_scan_redrives')
    expect(repository.match(/FOR UPDATE/gu)).toHaveLength(2)
    expect(repository).toContain("'asset.scan.recovery_requested'")
    expect(repository).toContain("'asset.scan_redrive_requested'")
    expect(repository).toContain("const SCAN_EVENT_TYPES = new Set(['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined', 'asset.scan_redrive_requested'])")
    expect(repository).toContain('authorization_snapshot: input.authorizationSnapshot')
    expect(repository).toContain('mime_type: mimeType')
    expect(repository).toContain('listRetryableFailures')
    expect(repository).toContain('INSERT INTO workspace_operation_audit')
    expect(repository).toContain('INSERT INTO asset_scan_redrives')
    expect(repository).not.toMatch(/DELETE\s+FROM\s+(outbox_events|asset_scan_attempts|asset_scan_receipts)/iu)
    expect(localRole).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE outbox_events FROM merchant_app')
    expect(localRole).toContain('GRANT SELECT, INSERT ON TABLE asset_scan_redrives TO merchant_app')
  })

  it('fails invalid requests before opening a database transaction', async () => {
    const repository = new PostgresAssetScanRedriveRepository({ connect: async () => { throw new Error('must not connect') } })
    await expect(repository.redrive({ workspaceId: 'ws', assetId: 'asset', deadLetterOutboxEventId: 'evt', expectedAssetRevision: 1, recoveryKey: 'short', actorId: 'actor', reason: 'retry scan', scanMaxAttempts: 12, authorizationSnapshot: { schema_version: 1, decision_id: 'decision', actor_id: 'actor', workspace_id: 'ws', context_id: 'workspace:ws', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1', scope_hash: 'a'.repeat(64), capability: 'asset.scan.execute', resource_id: 'asset', authorized: true, decided_at: '2026-08-31T00:00:00.000Z' } })).rejects.toBeInstanceOf(AssetScanRedriveError)
  })
})
