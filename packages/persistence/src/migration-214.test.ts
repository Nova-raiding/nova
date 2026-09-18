import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('migration 214', () => {
  it('adds embedding to the usage and budget ledgers', () => {
    const sql = readFileSync(new URL('./migrations/217_model_usage_embedding_modality.sql', import.meta.url), 'utf8')
    expect(sql).toContain("'embedding'")
    expect(sql).toContain('model_usage_ledger_modality_check')
    expect(sql).toContain('model_cost_budget_reservations_modality_check')
    expect(sql.match(/NOT VALID;/g)).toHaveLength(2)
    expect(sql.match(/VALIDATE CONSTRAINT/g)).toHaveLength(2)
    expect(sql.indexOf('VALIDATE CONSTRAINT model_usage_ledger_modality_embedding_check'))
      .toBeLessThan(sql.indexOf('ALTER TABLE model_usage_ledger DROP CONSTRAINT %I'))
    expect(sql.indexOf('VALIDATE CONSTRAINT model_cost_budget_reservations_modality_embedding_check'))
      .toBeLessThan(sql.indexOf('ALTER TABLE model_cost_budget_reservations DROP CONSTRAINT %I'))
    expect(sql).toContain('c.conkey = ARRAY[a.attnum]::smallint[]')
    expect(sql).toContain('ALTER TABLE model_cost_budget_reservations')
  })
})
