import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 151 legacy creative-point allocation constraint', () => {
  it('replaces the legacy positive-only check with signed allocation semantics', async () => {
    const sql = await readFile(new URL('./migrations/151_repair_legacy_creative_point_allocation_constraint.sql', import.meta.url), 'utf8')

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS creative_point_allocations_points_check')
    expect(sql).toContain('ADD CONSTRAINT creative_point_allocations_points_delta_check')
    expect(sql).toContain('CHECK (points_delta <> 0)')
  })

  it('is registered in the migration chain', async () => {
    expect((await loadMigrations()).find(item => item.version === 151)).toMatchObject({
      version: 151,
      name: 'repair_legacy_creative_point_allocation_constraint',
    })
  })
})
