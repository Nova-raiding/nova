import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 240 creative point allocation reservation index repair', () => {
  it('restores the legacy-missing reservation lookup index without blocking writes', async () => {
    const migrations = await loadMigrations()
    const migration = migrations.find(item => item.version === 240)
    expect(migration).toMatchObject({
      version: 240,
      name: 'repair_creative_point_allocation_reservation_index',
      transactional: false,
    })
    expect(migrations.findIndex(item => item.version === 240)).toBe(migrations.findIndex(item => item.version === 239) + 1)

    const sql = await readFile(new URL('./migrations/240_repair_creative_point_allocation_reservation_index.sql', import.meta.url), 'utf8')
    expect(sql.split('\n')[0]).toBe('-- migrate:no-transaction')
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS creative_point_allocations_reservation_idx\s+ON creative_point_allocations \(workspace_id, reservation_id, created_at, id\);/u)
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|UPDATE)\b/u)
  })
})
