import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('canonical catalog knowledge migration', () => {
  it('defines tenant-safe product hierarchy and 100MB image bound', async () => {
    const sql = await readFile(new URL('./migrations/198_canonical_catalog_knowledge.sql', import.meta.url), 'utf8')
    for (const table of ['canonical_skus','listing_skus','source_image_bindings']) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS canonical_products')
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS product_listings')
    expect(sql).toContain('REFERENCES product_listings(workspace_id,canonical_product_id,id)')
    expect(sql).toContain('byte_size <= 104857600')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ON DELETE RESTRICT')
  })
})
