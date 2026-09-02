import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 155 workspace data export requests', () => {
  it('creates a tenant-isolated request table whose ready state requires external delivery evidence', async () => {
    const sql = await readFile(new URL('./migrations/155_workspace_data_export_requests.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE workspace_data_export_requests')
    expect(sql).toContain('UNIQUE (workspace_id, idempotency_key)')
    expect(sql).toContain('workspace_data_export_ready_evidence_check')
    expect(sql).toContain('delivery_evidence_ref IS NOT NULL')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('WITH CHECK')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON workspace_data_export_requests TO merchant_app')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON workspace_data_export_requests FROM merchant_app')
  })

  it('is registered before subsequent hardening migrations', async () => {
    expect((await loadMigrations()).find(item => item.version === 155)).toMatchObject({ version: 155, name: 'workspace_data_export_requests' })
  })
})
