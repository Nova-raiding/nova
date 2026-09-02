import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 158 creative point reversal allocation guard', () => {
  it('permits only typed append-only allocations for active or settled targets', async () => {
    const sql = await readFile(new URL('./migrations/158_creative_point_reversal_allocation_guard.sql', import.meta.url), 'utf8')
    expect(sql).toContain("NEW.allocation_type IN ('reserve','release','settle_adjustment') AND reservation_status <> 'active'")
    expect(sql).toContain("NEW.allocation_type IN ('reverse','adjustment') AND reservation_status <> 'settled'")
    expect(sql).toContain("NEW.allocation_type IN ('release','reverse') AND NEW.points_delta > -1")
    expect(sql).toContain('grant_allocated+NEW.points_delta < 0')
  })
  it('is registered at version 158', async () => {
    expect((await loadMigrations()).find(item => item.version === 158)).toMatchObject({ version: 158, name: 'creative_point_reversal_allocation_guard' })
  })
})
