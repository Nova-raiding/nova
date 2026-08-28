import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('047 Route B task projection migration', () => {
  it('backfills the five normalized task scope columns and validates tenant-safe relationships', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 47)
    expect(migration?.name).toBe('route_b_task_projection')
    for (const field of ['brandId', 'canonicalProductId', 'listingId', 'campaignId', 'campaignItemId']) {
      expect(migration?.sql).toContain(`data->>'${field}'`)
    }
    expect(migration?.sql).toContain('batch_campaign_items_task_scope_key')
    expect(migration?.sql).toContain('tasks_campaign_item_scope_fk')
    expect(migration?.sql).toContain('tasks_campaign_scope_idx')
    expect(migration?.sql).toContain('tasks_canonical_requires_brand_check')
    expect(migration?.sql).toContain('tasks_campaign_scope_complete_check')
    for (const constraint of [
      'tasks_brand_fk',
      'tasks_brand_canonical_fk',
      'tasks_product_listing_fk',
      'tasks_campaign_item_fk',
      'tasks_campaign_pair_check',
      'tasks_listing_requires_product_check',
      'tasks_canonical_requires_brand_check',
      'tasks_campaign_scope_complete_check',
      'tasks_campaign_item_scope_fk',
    ]) {
      expect(migration?.sql).toContain(`VALIDATE CONSTRAINT ${constraint}`)
    }
    expect(migration?.sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DROP COLUMN/i)
  })
})
