import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 091 bind platform scope to ops role', () => {
  it('binds platform-wide policies to merchant_ops and preserves tenant writes', async () => {
    const sql = await readFile(new URL('./migrations/091_bind_platform_scope_to_ops_role.sql', import.meta.url), 'utf8')
    expect(sql).toContain("current_user = 'merchant_ops'")
    expect(sql).toContain('GRANT SELECT ON workspaces')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON platform_identities')
    expect(sql).toContain("WITH CHECK (id = current_setting('app.workspace_id', true))")
  })

  it('is the current tail of the executable migration chain', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 91)).toMatchObject({ version: 91, name: 'bind_platform_scope_to_ops_role' })
    expect(migrations.find(item => item.version === 92)).toMatchObject({ version: 92, name: 'image_generation_executions' })
    expect(migrations.find(item => item.version === 95)).toMatchObject({ version: 95, name: 'runtime_append_only_privileges' })
    expect(migrations.find(item => item.version === 96)).toMatchObject({ version: 96, name: 'reconciliation_evidence' })
    expect(migrations.find(item => item.version === 97)).toMatchObject({ version: 97, name: 'reconciliation_evidence_unknown_errors' })
  })
})
