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
})

