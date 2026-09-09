import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 175 legacy task snapshot scope repair', () => {
  it('registers a forward-only repair after the current migration tail', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 175)).toMatchObject({ version: 175, name: 'repair_legacy_task_snapshot_scope' })
  })

  it('derives only canonical and listing scope from the normalized task row', async () => {
    const sql = await readFile(new URL('./migrations/175_repair_legacy_task_snapshot_scope.sql', import.meta.url), 'utf8')
    expect(sql).toContain('task.canonical_product_id')
    expect(sql).toContain('task.listing_id')
    expect(sql).toContain("snapshot.entity_type = 'task'")
    expect(sql).not.toContain('publish_jobs')
    expect(sql).not.toContain('selectedVisuals')
  })
})
