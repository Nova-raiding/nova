import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 097 reconciliation evidence unknown errors', () => {
  it('allows unknown observations to retain fail-closed error context', async () => {
    const sql = await readFile(new URL('./migrations/097_reconciliation_evidence_unknown_errors.sql', import.meta.url), 'utf8')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS reconciliation_evidence_failure_details')
    expect(sql).toContain("provider_state IN ('failed','unknown')")
    expect((await loadMigrations()).find(item => item.version === 97)).toMatchObject({ version: 97, name: 'reconciliation_evidence_unknown_errors' })
  })
})
