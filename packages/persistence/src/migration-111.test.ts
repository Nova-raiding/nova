import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 111 model run budget linkage hardening', () => {
  it('reapplies immutable linkage and least-privilege invariants', async () => {
    const sql = await readFile(new URL('./migrations/111_harden_model_run_budget_linkage.sql', import.meta.url), 'utf8')
    const localRole = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
    const runtimeRoleGate = await readFile(new URL('../../../infra/scripts/verify-runtime-db-role.sh', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find((migration) => migration.version === 111)).toMatchObject({ version: 111, name: 'harden_model_run_budget_linkage' })
    expect(sql).toContain('model_usage_budget_pair_valid')
    expect(sql).toContain('model_usage_budget_reservation_fk')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON model_cost_budget_reservations FROM merchant_app')
    expect(localRole).toContain('REVOKE DELETE, TRUNCATE ON TABLE model_cost_budget_reservations FROM merchant_app')
    expect(runtimeRoleGate).toContain('tenant runtime role must not delete or truncate model cost budget reservations')
  })
})
