import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 127 platform role boundary enforcement gate', () => {
  it('validates the historical membership constraint without rewriting data', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 127)).toMatchObject({
      version: 127,
      name: 'validate_platform_role_boundary',
    })

    const sql = await readFile(new URL('./migrations/127_validate_platform_role_boundary.sql', import.meta.url), 'utf8')
    expect(sql).toContain('VALIDATE CONSTRAINT workspace_members_no_platform_role')
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\s+INTO?\b/iu)
  })
})
