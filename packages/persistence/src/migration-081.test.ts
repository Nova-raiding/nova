import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('migration 081 reconciliation status', () => {
  it('defines a workspace-scoped latest-status projection with idempotency and RLS', async () => {
    const sql = await readFile(new URL('./migrations/081_reconciliation_status.sql', import.meta.url), 'utf8')
    expect(sql).toContain('PRIMARY KEY (workspace_id, resource_type, resource_id)')
    expect(sql).toContain('last_idempotency_key')
    expect(sql).toContain('ALTER TABLE workspace_reconciliation_status FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE workspace_reconciliation_status TO merchant_app')
  })
})
