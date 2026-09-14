import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('customer delivery migration', () => {
  it('defines a workspace-scoped checklist and multi-video evidence without destructive cascades', async () => {
    const sql = await readFile(new URL('./migrations/196_customer_delivery_workspace.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspace_customer_deliveries')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspace_customer_delivery_videos')
    expect(sql).toContain("payment_status IN ('unpaid', 'paid')")
    expect(sql).toContain('ON DELETE RESTRICT')
    expect(sql).toContain('workspace_id = current_setting')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE')
  })

  it('contains every customer-profile field required by the delivery brief', async () => {
    const sql = await readFile(new URL('./migrations/196_customer_delivery_workspace.sql', import.meta.url), 'utf8')
    for (const field of [
      'company_name',
      'contract_number',
      'payment_status',
      'contract_ref',
      'project_owner',
      'support_owner',
      'payment_date',
      'planned_go_live_at',
    ]) {
      expect(sql, `missing customer profile field: ${field}`).toContain(field)
    }
    for (const field of [
      'customer_profile_status',
      'system_integration_status',
      'functional_acceptance_status',
      'training_completed',
      'effective_at',
      'revision',
      'created_by_actor_id',
      'updated_by_actor_id',
    ]) {
      expect(sql, `missing workflow/audit field: ${field}`).toContain(field)
    }
  })

  it('enforces idempotent tenant-safe identity and non-destructive evidence retention', async () => {
    const sql = await readFile(new URL('./migrations/196_customer_delivery_workspace.sql', import.meta.url), 'utf8')
    expect(sql).toContain('lower(btrim(company_name))')
    expect(sql).toContain('PRIMARY KEY (workspace_id, id)')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ON DELETE RESTRICT')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE')
    expect(sql).not.toMatch(/workspace_customer_delivery_videos[\s\S]{0,500}ON DELETE CASCADE/i)
  })
})
