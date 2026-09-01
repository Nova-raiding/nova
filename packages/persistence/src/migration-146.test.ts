import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 146 commercial catalog v2', () => {
  it('registers an immutable global catalog without creating transactional commerce state', async () => {
    const sql = await readFile(new URL('./migrations/146_commercial_catalog_v2.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 146)).toMatchObject({ version: 146, name: 'commercial_catalog_v2' })
    for (const table of ['commercial_catalog_skus', 'commercial_catalog_sku_versions', 'commercial_catalog_sku_benefits', 'creative_point_rate_card_versions_v2', 'creative_point_rate_rules_v2', 'commercial_catalog_events_v2']) expect(sql).toContain(table)
    expect(sql).toContain('reject_commercial_catalog_fact_mutation')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE')
    expect(sql).toContain('REVOKE ALL ON commercial_catalog_skus')
    expect(sql).toContain("encode(sha256(convert_to(payload::text, 'UTF8')), 'hex')")
    expect(sql).toContain("'point_pack'")
    expect(sql).not.toMatch(/kind IN \([^)]*'recharge'/)
    expect(sql).not.toMatch(/'points_(?:500|2000)', 'recharge'/)
    expect(sql).not.toMatch(/CREATE TABLE\s+(?:commercial_orders|billing_orders|workspace_subscription|creative_point_grants)/i)
  })

  it('seeds every source entry as draft or pending and non-executable', async () => {
    const sql = await readFile(new URL('./migrations/146_commercial_catalog_v2.sql', import.meta.url), 'utf8')
    expect(sql).toContain("SELECT id, sku_id, 1, 'draft', false")
    expect(sql).toContain("'pending_business_approval', false")
    expect(sql).not.toMatch(/VALUES\s*\([^)]*'approved'[^)]]*true/i)
    expect(sql).toContain("'image.generate.standard', 'image', 1, 'fixed', NULL, false")
    expect(sql).toContain("'image.edit.annotation', 'image', 1, 'fixed', NULL, false")
    expect(sql).toContain("'video.generate.standard_15s', 'video', 90, 'starts_at', NULL, false")
    expect(sql).toContain("'text.generate', 'request', NULL, 'unresolved', NULL, false")
  })

  it('preserves exact commercial values and leaves 50g normalization null', async () => {
    const sql = await readFile(new URL('./migrations/146_commercial_catalog_v2.sql', import.meta.url), 'utf8')
    for (const value of ['500000::BIGINT', '199900::BIGINT', '200000::BIGINT', '500000::BIGINT', '1000000::BIGINT', '30000::BIGINT', '100000::BIGINT']) expect(sql).toContain(value)
    expect(sql).toContain("'cloud_storage', 50, '50g', 'g', NULL, 'STORAGE_UNIT_UNRESOLVED'")
    expect(sql).toContain("'private', 'commercial.private_sku.read'")
    expect(sql).toContain('"grantCount":6')
    expect(sql).toContain('"pointsPerGrant":500')
  })
})
