import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 106 canonical legacy brand integrity guard', () => {
  it('is contiguous and rejects historical NULL/mismatched brands without rewriting data', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 106)).toMatchObject({ version: 106, name: 'canonical_legacy_brand_integrity_guard' })
    expect(migrations.find(item => item.version === 109)).toMatchObject({ version: 109, name: 'asset_scan_redrive' })
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: 122 }, (_, index) => index + 1))
    const sql = await readFile(new URL('./migrations/106_canonical_legacy_brand_integrity_guard.sql', import.meta.url), 'utf8')
    expect(sql).toContain('migration 106 blocked')
    expect(sql).toContain('p.brand_id IS NULL')
    expect(sql).toContain('IS DISTINCT FROM legacy_brand_id')
    expect(sql).toContain('ENABLE ALWAYS TRIGGER canonical_products_legacy_brand_integrity_guard')
    expect(sql).toContain('VALIDATE CONSTRAINT canonical_products_brand_legacy_fk')
    expect(sql).not.toMatch(/\bDELETE\s+FROM|\bUPDATE\s+products\b/iu)
  })
})
