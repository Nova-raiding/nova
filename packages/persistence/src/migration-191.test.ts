import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 191 rule pack category', () => {
  it('adds the durable governance category without changing existing rows', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 191)).toMatchObject({ version: 191, name: 'rule_pack_category' })
    const sql = await readFile(new URL('./migrations/191_rule_pack_category.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS category')
    expect(sql).toContain("'advertising_publish'")
    expect(sql).not.toContain('DROP TABLE')
  })
})
