import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 241 operations read ACL repair', () => {
  it('restores only read access for the directory and finance projections', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 241)
    expect(migration?.name).toBe('repair_ops_directory_finance_read_acl')
    expect(migration?.sql).toContain('GRANT SELECT ON TABLE')
    expect(migration?.sql).toContain('ops_workspace_summaries')
    expect(migration?.sql).toContain('commercial_orders_v2')
    expect(migration?.sql).toContain('commercial_payment_events_v2')
    expect(migration?.sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE')
    expect(migration?.sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)/u)
  })
})
