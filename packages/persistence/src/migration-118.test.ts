import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 118 model usage budget run linkage', () => {
  it('makes the reservation and run identity a database-enforced triple', async () => {
    const sql = await readFile(new URL('./migrations/118_enforce_model_usage_budget_run_linkage.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 118)).toMatchObject({ version: 118, name: 'enforce_model_usage_budget_run_linkage' })
    expect(sql).toContain('UNIQUE (workspace_id,reservation_key,run_key)')
    expect(sql).toContain('FOREIGN KEY (workspace_id,budget_reservation_key,budget_run_key)')
    expect(sql).toContain('REFERENCES model_cost_budget_reservations(workspace_id,reservation_key,run_key)')
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(sql).not.toMatch(/UPDATE\s+model_usage_ledger/iu)
    expect(sql).not.toMatch(/DELETE\s+FROM/iu)
  })
})
