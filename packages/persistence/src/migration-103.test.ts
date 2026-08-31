import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 103 operation alert notification ACL', () => {
  it('hardens the existing notification ledger without rewriting migration 100', async () => {
    const sql = await readFile(new URL('./migrations/103_operation_alert_notification_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE ALL ON TABLE workspace_operation_alert_notifications FROM PUBLIC')
    expect(sql).toContain('GRANT SELECT,INSERT,UPDATE ON TABLE workspace_operation_alert_notifications TO merchant_app')
    expect(sql).toContain('REVOKE DELETE,TRUNCATE ON TABLE workspace_operation_alert_notifications FROM merchant_app')
    expect((await loadMigrations()).find(item => item.version === 103)).toMatchObject({ version: 103, name: 'operation_alert_notification_acl' })
  })
})
