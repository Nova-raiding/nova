import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery control-plane migration', () => {
  it('registers a forward-only ACL repair for evidence and atomic audits', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 200)
    expect(migration?.name).toBe('customer_delivery_control_plane_acl')
    expect(migration?.sql).toContain('workspace_customer_delivery_checklist_items FROM merchant_app')
    expect(migration?.sql).toContain('workspace_customer_delivery_checklist_items TO merchant_ops')
    expect(migration?.sql).toContain('GRANT INSERT ON workspace_operation_audit TO merchant_ops')
    expect(migration?.sql).toContain('GRANT UPDATE (deleted_at)')
    expect(migration?.sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE TABLE/u)
  })

  it('keeps runtime wiring, bootstrap and role gate aligned with the ops-only ACL', async () => {
    const api = await readFile(new URL('../../../apps/api/src/server.ts', import.meta.url), 'utf8')
    const bootstrap = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
    const gate = await readFile(new URL('../../../infra/scripts/verify-runtime-db-role.sh', import.meta.url), 'utf8')
    expect(api).toContain('new PostgresCustomerDeliveryRepository(opsSqlPool)')
    expect(bootstrap).toContain("'workspace_customer_delivery_checklist_items'")
    expect(gate).toContain('Customer delivery control-plane ACL mismatch')
    expect(gate).toContain('Customer delivery audit must be append-only')
  })
})
