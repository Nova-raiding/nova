import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 101 canonical backfill runs', () => {
  it('registers durable tenant-isolated batch control state', async () => {
    const sql = await readFile(new URL('./migrations/101_canonical_backfill_runs.sql', import.meta.url), 'utf8')
    expect(sql).toContain('canonical_backfill_runs')
    expect(sql).toContain("status IN ('planned','running','paused','completed','failed')")
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting('app.workspace_id', true)")
    expect((await loadMigrations()).find(item => item.version === 101)).toMatchObject({ version: 101, name: 'canonical_backfill_runs' })
  })
})
