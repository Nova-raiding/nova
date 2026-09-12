import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 188 enterprise workspace bootstrap', () => {
  it('keeps workspace bootstrap compatible with the enterprise invariant', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 188)).toMatchObject({ version: 188, name: 'enterprise_workspace_bootstrap' })
    const sql = await readFile(new URL('./migrations/188_enterprise_workspace_bootstrap.sql', import.meta.url), 'utf8')
    expect(sql).toContain('assign_workspace_enterprise_id')
    expect(sql).toContain('BEFORE INSERT ON workspaces')
    expect(sql).toContain('INSERT INTO enterprises')
    expect(sql).not.toContain('DROP TABLE')
  })
})
