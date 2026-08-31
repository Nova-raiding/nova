import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('migration 080 storage quota', () => {
  it('defines workspace-scoped quota ledger, reservations, and RLS', async () => {
    const sql = await readFile(new URL('./migrations/080_storage_quota.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspace_storage_quotas')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS storage_quota_reservations')
    expect(sql).toContain('PRIMARY KEY (workspace_id,reservation_key)')
    expect(sql).toContain('ALTER TABLE workspace_storage_quotas FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE storage_quota_reservations FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("status IN ('active','settled','released','over_limit')")
  })
})
