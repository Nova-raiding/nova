import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 108 model usage settled cost invariant', () => {
  it('fails closed on historical settled rows without rewriting accounting data', async () => {
    const sql = await readFile(new URL('./migrations/108_model_usage_settled_cost_invariant.sql', import.meta.url), 'utf8')

    expect(sql).toContain("WHERE settlement_status = 'settled'")
    expect(sql).toContain('AND cost_cny IS NULL')
    expect(sql).toContain('migration 108 blocked')
    expect(sql).toContain("ERRCODE = '23514'")
    expect(sql).toContain('explicit audited process')
    expect(sql).not.toMatch(/\bUPDATE\s+model_usage_ledger\b|\bDELETE\s+FROM\s+model_usage_ledger\b/iu)
  })

  it('requires cost for settled while preserving explicit zero-cost waivers', async () => {
    const sql = await readFile(new URL('./migrations/108_model_usage_settled_cost_invariant.sql', import.meta.url), 'utf8')

    expect(sql).toContain('ADD CONSTRAINT model_usage_settled_cost_required_check')
    expect(sql).toContain("CHECK (settlement_status <> 'settled' OR cost_cny IS NOT NULL)")
    expect(sql).toContain('NOT VALID')
    expect(sql).toContain('VALIDATE CONSTRAINT model_usage_settled_cost_required_check')
    expect(sql).not.toContain("settlement_status <> 'waived'")
  })
})
