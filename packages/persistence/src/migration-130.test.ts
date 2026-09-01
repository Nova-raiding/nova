import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 130 canonical legacy identity uniqueness', () => {
  it('blocks historical ambiguity and adds a workspace-scoped partial unique index without rewriting data', async () => {
    const sql = await readFile(new URL('./migrations/130_canonical_legacy_identity_uniqueness.sql', import.meta.url), 'utf8')
    expect(sql).toContain('migration 130 blocked')
    expect(sql).toContain('GROUP BY workspace_id, legacy_product_id')
    expect(sql).toContain('CREATE UNIQUE INDEX canonical_products_workspace_legacy_identity_key')
    expect(sql).toContain('WHERE legacy_product_id IS NOT NULL')
    expect(sql).not.toMatch(/\bDELETE\s+FROM|\bUPDATE\s+canonical_products/iu)
    expect((await loadMigrations()).find(item => item.version === 130)).toMatchObject({ version: 130, name: 'canonical_legacy_identity_uniqueness' })
  })
})
