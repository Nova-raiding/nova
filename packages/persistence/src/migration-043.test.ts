import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('043 route B expand migration', () => {
  it('adds the gradual unified-path structures without contracting legacy data', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 43)
    expect(migration?.name).toBe('route_b_expand')
    expect(migration?.sql).toContain('ALTER COLUMN canonical_product_id DROP NOT NULL')
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS context_blobs')
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS context_snapshot_links')
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS object_storage_orphans')
    expect(migration?.sql).toContain('batch_campaign_items_product_listing_fk')
    expect(migration?.sql).toContain('tasks_campaign_item_fk')
    expect(migration?.sql).toContain('NOT VALID')
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS settlement_status')
    expect(migration?.sql).toContain('FORCE ROW LEVEL SECURITY')
  })
})
