import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('068 campaign lifecycle runtime grants', () => {
  it('grants only tenant-scoped read/write operations and never delete', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 68)
    expect(migration).toMatchObject({ name: 'campaign_lifecycle_runtime_grants' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('batch_campaigns, batch_campaign_items')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE')
    expect(sql).not.toMatch(/GRANT[^;]*DELETE/iu)
    expect(sql).toContain('REVOKE ALL')
    expect(sql).toContain('REVOKE ALL ON TABLE batch_campaigns, batch_campaign_items FROM merchant_ops')
  })
})
