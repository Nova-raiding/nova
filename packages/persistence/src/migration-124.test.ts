import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 124 merchant membership role boundary', () => {
  it('blocks new platform roles without rewriting historical memberships', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 124)).toMatchObject({ version: 124, name: 'block_platform_role_in_workspace_members' })
    const sql = await readFile(new URL('./migrations/124_block_platform_role_in_workspace_members.sql', import.meta.url), 'utf8')

    expect(sql).toContain("CHECK (role <> 'platform_ops') NOT VALID")
    expect(sql).not.toMatch(/UPDATE\s+workspace_members|DELETE\s+FROM\s+workspace_members/iu)
  })
})
