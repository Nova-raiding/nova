import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations, migrationChecksum } from './migration.js'

const frozenChecksum = 'ef962eb7ef1cba894f622b32e7b43962b6ccdb121b1ddbba822f404d57fbe83a'

describe('frozen commercial result notification migration 264', () => {
  it('loads the actual frozen SQL asset as the unique contiguous production tail', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/264_commercial_result_notifications_and_reads.sql', import.meta.url), 'utf8')
    const migration = migrations.find(row => row.version === 264)!
    expect(migration).toEqual({ version: 264, name: 'commercial_result_notifications_and_reads', sql })
    expect(migrations.map(row => row.version)).toEqual(Array.from({ length: migrations.length }, (_, index) => index + 1))
    expect(migrationChecksum(migration.sql)).toBe(frozenChecksum)
    expect(migrations.filter(row => row.version === 264)).toHaveLength(1)
  })

  it('retains source/member isolation and immutable read facts without granting commercial app delivery authority', async () => {
    const migration = (await loadMigrations()).find(row => row.version === 264)!
    expect(migration.sql).toContain("result_state IN ('active','scheduled','awaiting_dependency','reconciliation_required')")
    expect(migration.sql).toContain('FOREIGN KEY(source_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id)')
    expect(migration.sql).toContain('PRIMARY KEY(workspace_id,member_id,idempotency_key)')
    expect(migration.sql).toContain("current_setting(''app.member_id'',true)")
    expect(migration.sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration.sql).toContain('REVOKE ALL ON commercial_purchase_result_notification_outbox FROM merchant_app')
    expect(migration.sql).toContain('BEFORE UPDATE OR DELETE')
  })
})
