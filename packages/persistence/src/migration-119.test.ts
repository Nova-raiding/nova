import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 119 image generation dispatch fence', () => {
  it('registers the dispatch-state constraint and recovery index', async () => {
    const sql = await readFile(new URL('./migrations/119_image_generation_execution_dispatch_fence.sql', import.meta.url), 'utf8')
    const migration = (await loadMigrations()).find(item => item.version === 119)

    expect(migration).toMatchObject({ version: 119, name: 'image_generation_execution_dispatch_fence' })
    expect(migration?.sql).toBe(sql)
    expect(sql).toContain("state IN ('provider_reserved','provider_dispatching')")
    expect(sql).toContain('image_generation_execution_dispatch_recovery_idx')
    expect(sql).toContain("state IN ('provider_reserved','provider_dispatching','outcome_unknown')")
  })
})
