import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('migration 217', () => {
  it('adds embedding to the usage and budget ledgers', () => {
    const sql = readFileSync(new URL('./migrations/217_model_usage_embedding_modality.sql', import.meta.url), 'utf8')
    expect(sql).toContain("'embedding'")
    expect(sql).toContain('model_usage_ledger_modality_check')
    expect(sql).toContain('model_cost_budget_reservations_modality_check')
    expect(sql).toContain('ALTER TABLE model_cost_budget_reservations')
  })
})
