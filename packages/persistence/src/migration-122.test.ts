import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 122 campaign item legacy/canonical integrity', () => {
  it('registers a non-destructive fail-closed guard for new writes', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 122)).toMatchObject({ version: 122, name: 'campaign_item_legacy_canonical_integrity' })
    const sql = await readFile(new URL('./migrations/122_campaign_item_legacy_canonical_integrity.sql', import.meta.url), 'utf8')
    expect(sql).toContain('batch_campaign_items_legacy_canonical_integrity')
    expect(sql).toContain('canonical_legacy_product_id IS DISTINCT FROM NEW.legacy_product_id')
    expect(sql).toContain("USING ERRCODE = '23514'")
    expect(sql).not.toMatch(/\bDELETE\s+FROM|\bUPDATE\s+batch_campaign_items\b/iu)
  })
})
