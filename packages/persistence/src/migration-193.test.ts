import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 193 enterprise name sync ACL', () => {
  it('exposes only the platform-scoped projection function', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 193)).toMatchObject({ version: 193, name: 'enterprise_name_sync_acl' })
    const sql = await readFile(new URL('./migrations/193_enterprise_name_sync_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_enterprise_name_for_workspaces')
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain("session_user <> 'merchant_ops'")
    expect(sql).toContain("current_setting('app.platform_scope', true) IS DISTINCT FROM 'platform_ops'")
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_enterprise_name_for_workspaces(text[], text)')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_enterprise_name_for_workspaces(text[], text)')
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT,\s*)?UPDATE\s+ON\s+enterprises\s+TO\s+merchant_ops/iu)
    expect(sql).not.toMatch(/DROP\s+TABLE/iu)
  })
})
