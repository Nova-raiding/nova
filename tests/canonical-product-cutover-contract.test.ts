import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8')

describe('canonical product cutover static contract', () => {
  it('keeps the additive migrations and legacy chain recoverable', () => {
    const expand = read('packages/persistence/src/migrations/043_route_b_expand.sql')
    const backfill = read('packages/persistence/src/migrations/049_legacy_snapshot_backfill.sql')
    const design = read('doc/todo/data/canonical-product-cutover-design-2026-08-29.md')

    expect(expand).toContain('does not remove legacy columns')
    expect(expand).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
    expect(backfill).toContain('ON CONFLICT DO NOTHING')
    expect(backfill).toContain('unsafe descendant never causes an unsafe ancestor')
    expect(design).toContain('不删除旧表、旧字段、旧快照和旧发布记录')
    expect(design).toContain('canonical_read_mode')
    expect(design).toContain('rolled_back')
  })

  it('requires scoped canonical/listing/campaign relationships before cutover', () => {
    const routeB = read('packages/persistence/src/migrations/043_route_b_expand.sql')
    const listingIntegrity = read('packages/persistence/src/migrations/063_product_listing_brand_canonical_integrity.sql')
    const accountIntegrity = read('packages/persistence/src/migrations/069_platform_account_scope_integrity.sql')
    const design = read('doc/todo/data/canonical-product-cutover-design-2026-08-29.md')

    expect(routeB).toContain('batch_campaign_items_product_listing_fk')
    expect(routeB).toContain('tasks_product_listing_fk')
    expect(listingIntegrity).toContain('FOREIGN KEY (workspace_id, brand_id, canonical_product_id)')
    expect(accountIntegrity).toContain('assert_platform_account_scope')
    expect(design).toContain('多候选或非 verified 直接返回可修复的冲突，不猜测')
    expect(design).toContain('所有活跃可发布 listing 的关系状态为 `verified`')
  })
})
