import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('065 asset parse leases', () => {
  it('is tenant-scoped and enforces complete state shapes', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 65)
    expect(migration).toMatchObject({ name: 'asset_parse_leases' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('PRIMARY KEY (workspace_id, asset_id)')
    expect(sql).toContain('asset_parse_leases_workspace_scope')
    expect(sql).toContain("state IN ('processing', 'succeeded', 'failed')")
    expect(sql).toContain("facts IS NOT NULL AND jsonb_typeof(facts) = 'object'")
    expect(sql).toContain("facts <> '{}'::jsonb")
    expect(sql).toContain("state = 'processing' AND lease_token IS NOT NULL")
    expect(sql).toContain("state = 'succeeded' AND lease_token IS NULL AND lease_until IS NULL")
    expect(sql).toContain("state = 'failed' AND lease_token IS NULL AND lease_until IS NULL")
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting('app.workspace_id', true)")
    expect(sql).toContain('asset_parse_leases_recovery_idx')
  })
})
