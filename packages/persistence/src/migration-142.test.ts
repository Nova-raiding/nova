import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 142 authorization execution decision correlation', () => {
  it('makes the admitting decision durable and validates legacy backfill values', async () => {
    const sql = await readFile(new URL('./migrations/142_authorization_execution_decision_correlation.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 142)).toMatchObject({ version: 142, name: 'authorization_execution_decision_correlation' })
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS decision_id TEXT')
    expect(sql).toContain("'legacy-reservation:' || reservation_id")
    expect(sql).toContain('ALTER COLUMN decision_id SET NOT NULL')
  })
})
