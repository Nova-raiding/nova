import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 147 platform authorization audit', () => {
  it('registers a separate platform-scoped append-only sink', async () => {
    const sql = await readFile(new URL('./migrations/147_platform_authorization_audit.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 147)).toMatchObject({ version: 147, name: 'platform_authorization_audit' })
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS platform_authorization_audit')
    expect(sql).toContain("workbench = 'platform'")
    expect(sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
    expect(sql).toContain('platform_authorization_audit_immutable')
    expect(sql).toContain('platform_authorization_audit_no_truncate')
    expect(sql).toContain('REVOKE ALL ON platform_authorization_audit FROM merchant_app')
    expect(sql).toContain('GRANT SELECT, INSERT ON platform_authorization_audit TO merchant_ops')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON platform_authorization_audit FROM merchant_ops')
    expect(sql).not.toContain('workspace_id')
  })
})
