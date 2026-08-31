import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations, migrationChecksum } from './migration.js'

describe('migration 100 operation alert notifications', () => {
  it('registers the tenant-isolated durable notification ledger', async () => {
    const sql = await readFile(new URL('./migrations/100_operation_alert_notifications.sql', import.meta.url), 'utf8')
    expect(sql).toContain('workspace_operation_alert_notifications')
    expect(sql).toContain("delivery IN ('disabled','blocked','delivered','failed')")
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting('app.workspace_id', true)")
    expect(migrationChecksum(sql)).toBe('eac982d6be0148f62af509efc4676570b95537154df76431e64f457f470714c4')
    expect((await loadMigrations()).find(item => item.version === 100)).toMatchObject({ version: 100, name: 'operation_alert_notifications' })
    expect((await loadMigrations()).find(item => item.version === 105)).toMatchObject({ version: 105, name: 'durable_authorization_grants' })
  })
})
