import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('commercial assisted order beneficiary migration 266', () => {
  it('registers an additive migration with no inferred legacy recipients', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/266_commercial_order_beneficiaries.sql', import.meta.url), 'utf8')
    expect(migrations.at(-1)).toEqual({ version: 266, name: 'commercial_order_beneficiaries', sql })
    expect(migrations.map(row => row.version)).toEqual(Array.from({ length: 266 }, (_, index) => index + 1))
    expect(sql).toContain('REFERENCES workspace_members(workspace_id,id)')
    expect(sql).toContain('ADD COLUMN beneficiary_member_id UUID')
    expect(sql).toContain('merchant_commercial_order_beneficiary')
    expect(sql).not.toMatch(/UPDATE commercial_order_terms_v3 SET beneficiary_member_id/iu)
  })
})
