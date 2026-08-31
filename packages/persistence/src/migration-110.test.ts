import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migrations 110-111 unified model run cost budget', () => {
  it('registers run-scoped budget fields and usage linkage', async () => {
    const sql = await readFile(new URL('./migrations/110_unified_model_run_cost_budget.sql', import.meta.url), 'utf8')
    const hardeningSql = await readFile(new URL('./migrations/111_harden_model_run_budget_linkage.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find((migration) => migration.version === 110)).toMatchObject({ version: 110, name: 'unified_model_run_cost_budget' })
    expect(migrations.find((migration) => migration.version === 111)).toMatchObject({ version: 111, name: 'harden_model_run_budget_linkage' })
    expect(sql).toContain('run_limit_cny')
    expect(sql).toContain('model_cost_budget_workspace_run_idx')
    expect(sql).toContain('model_usage_budget_run_idx')
    expect(sql).toContain('model_usage_budget_pair_valid')
    expect(sql).toContain('SET budget_reservation_key = reservation.reservation_key')
    expect(sql).toContain('model_usage_budget_reservation_fk')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE')
    expect(hardeningSql).toContain('REVOKE DELETE, TRUNCATE ON model_cost_budget_reservations FROM merchant_app')
  })
})
