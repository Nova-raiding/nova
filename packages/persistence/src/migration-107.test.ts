import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 107 canonical conflict verification evidence', () => {
  it('adds object-shaped evidence without changing business facts', async () => {
    const sql = await readFile(new URL('./migrations/107_canonical_backfill_conflict_verification_evidence.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS verification_evidence JSONB')
    expect(sql).toContain("CHECK (jsonb_typeof(verification_evidence) = 'object')")
    expect(sql).not.toMatch(/\bUPDATE\s+(products|canonical_products)\b|\bDELETE\s+FROM\s+(products|canonical_products)\b/iu)
  })
})
