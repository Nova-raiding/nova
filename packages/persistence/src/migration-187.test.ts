import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 187 enterprise tenant root', () => {
  it('is registered as a forward-only enterprise boundary migration', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 187)).toMatchObject({ version: 187, name: 'enterprise_tenant_root' })
    const sql = await readFile(new URL('./migrations/187_enterprise_tenant_root.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS enterprises')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS enterprise_id')
    expect(sql).toContain('workspaces_enterprise_id_fkey')
    expect(sql).toContain('REVOKE ALL ON enterprises FROM merchant_app')
    expect(sql).not.toContain('DROP TABLE')
  })
})
