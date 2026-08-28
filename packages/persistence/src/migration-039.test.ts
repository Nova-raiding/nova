import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 039 multi-brand batch schema', () => {
  it('loads after every prior migration and declares the additive schema', async () => {
    const migrations = await loadMigrations()
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: 47 }, (_, index) => index + 1))
    const migration = migrations.find(item => item.version === 39)
    expect(migration?.name).toBe('multi_brand_batch')
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS brands')
    for (const table of ['brand_store_bindings', 'brand_access_grants', 'canonical_products', 'product_listings', 'batch_campaigns', 'batch_campaign_items', 'context_snapshots']) {
      expect(migration?.sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(migration?.sql).toContain("ARRAY['brands', 'brand_store_bindings', 'brand_access_grants', 'canonical_products', 'product_listings', 'batch_campaigns', 'batch_campaign_items', 'context_snapshots']")
    expect(migration?.sql).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY")
    expect(migration?.sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY")
    expect(migration?.sql).toContain("table_name || '_workspace_isolation'")
    expect(migration?.sql).toContain("current_setting(''app.workspace_id'', true)")
  })

  it('keeps tenant and binding integrity explicit without destructive legacy changes', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 39)!
    expect(migration.sql).toContain('brand_store_bindings_account_platform_fk')
    expect(migration.sql).toContain('product_listings_brand_store_fk')
    expect(migration.sql).toContain('batch_campaign_items_listing_fk')
    expect(migration.sql).toContain('context_snapshots_campaign_item_fk')
    expect(migration.sql).toContain("current_setting(''app.workspace_id'', true)")
    expect(migration.sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DROP COLUMN/i)
    expect(migration.sql).not.toContain('ALTER TABLE products')
    expect(migration.sql).not.toContain('ALTER TABLE brand_profiles')
  })
})
