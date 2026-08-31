import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 102 canonical backfill conflicts', () => {
  it('registers the RLS human-review queue', async () => {
    const sql = await readFile(new URL('./migrations/102_canonical_backfill_conflicts.sql', import.meta.url), 'utf8')
    expect(sql).toContain('canonical_backfill_conflicts')
    expect(sql).toContain("status IN ('open','claimed','resolved','dismissed')")
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting('app.workspace_id', true)")
    expect((await loadMigrations()).find(item => item.version === 102)).toMatchObject({ version: 102, name: 'canonical_backfill_conflicts' })
  })

  it('keeps verification evidence additive in a later migration', async () => {
    const sql = await readFile(new URL('./migrations/107_canonical_backfill_conflict_verification_evidence.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS verification_evidence JSONB')
    expect(sql).toContain("jsonb_typeof(verification_evidence) = 'object'")
    expect(sql).not.toMatch(/\bDELETE\s+FROM|\bUPDATE\s+canonical_backfill_conflicts\b/iu)
    expect((await loadMigrations()).find(item => item.version === 107)).toMatchObject({ version: 107, name: 'canonical_backfill_conflict_verification_evidence' })
  })
})
