import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 176 private trial entitlement benefits', () => {
  it('registers after the task snapshot repair', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 176)).toMatchObject({ version: 176, name: 'private_trial_entitlement_benefits' })
  })

  it('normalizes the one-brand, one-store and 500-point benefits', async () => {
    const sql = await readFile(new URL('./migrations/176_private_trial_entitlement_benefits.sql', import.meta.url), 'utf8')
    expect(sql).toContain("'max_brands', 1")
    expect(sql).toContain("'max_stores', 1")
    expect(sql).toContain("'creative_points', 500")
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING')
  })
})
