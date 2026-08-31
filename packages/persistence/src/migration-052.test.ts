import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('052 workspace context snapshots', () => {
  it('allows every generation task to freeze context before brand assignment', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 52)
    expect(migration).toMatchObject({ name: 'workspace_context_snapshots' })
    expect(migration?.sql).toContain('ALTER COLUMN brand_id DROP NOT NULL')
    expect(migration?.sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i)
  })
})
