import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 194 workspace enterprise binding guard', () => {
  it('installs a runtime-role trigger without broadening tenant privileges', async () => {
    const migrations = await loadMigrations()
    expect(migrations.at(-1)).toMatchObject({ version: 194, name: 'lock_workspace_enterprise_binding' })
    const sql = await readFile(new URL('./migrations/194_lock_workspace_enterprise_binding.sql', import.meta.url), 'utf8')
    expect(sql).toContain('prevent_workspace_enterprise_rebind')
    expect(sql).toContain("session_user IN ('merchant_app', 'merchant_ops')")
    expect(sql).toContain('BEFORE UPDATE OF enterprise_id ON workspaces')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.prevent_workspace_enterprise_rebind() FROM PUBLIC')
    expect(sql).not.toMatch(/GRANT\s+UPDATE\s+ON\s+workspaces\s+TO\s+merchant_app/iu)
    expect(sql).not.toMatch(/DROP\s+TABLE/iu)
  })
})
