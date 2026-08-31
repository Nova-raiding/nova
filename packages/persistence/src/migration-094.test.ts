import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 094 image reconciliation cursor index', () => {
  it('registers the partial stable-order index', async () => {
    const sql = await readFile(new URL('./migrations/094_image_generation_reconciliation_cursor_index.sql', import.meta.url), 'utf8')
    expect(sql).toContain('workspace_id, updated_at DESC, job_id ASC')
    expect(sql).toContain("state IN ('provider_started', 'outcome_unknown')")
    expect((await loadMigrations()).find(item => item.version === 94)).toMatchObject({ version: 94, name: 'image_generation_reconciliation_cursor_index' })
  })
})
