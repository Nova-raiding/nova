import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 099 canonical legacy brand integrity', () => {
  it('uses a generated legacy brand projection and a non-destructive NOT VALID composite foreign key', async () => {
    const sql = await readFile(new URL('./migrations/099_canonical_legacy_brand_integrity.sql', import.meta.url), 'utf8')
    expect(sql).toContain("GENERATED ALWAYS AS (NULLIF(btrim(data->>'brandId'), '')) STORED")
    expect(sql).toContain('products_workspace_brand_identity_key')
    expect(sql).toContain('FOREIGN KEY (workspace_id, brand_id, legacy_product_id)')
    expect(sql).toContain('REFERENCES products (workspace_id, brand_id, id)')
    expect(sql).toContain('NOT VALID')
    expect(sql).not.toMatch(/\bDELETE\s+FROM|\bUPDATE\s+products\b/iu)
    expect((await loadMigrations()).find(item => item.version === 99)).toMatchObject({ version: 99, name: 'canonical_legacy_brand_integrity' })
  })
})
