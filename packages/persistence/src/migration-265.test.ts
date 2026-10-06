import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('commercial benefit bundle reference reader migration 265', () => {
  it('registers the unique migration tail and retains the frozen order references', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/265_commercial_bundle_reference_reader.sql', import.meta.url), 'utf8')
    expect(migrations[264]).toEqual({ version: 265, name: 'commercial_bundle_reference_reader', sql })
    expect(migrations.map(row => row.version)).toEqual(Array.from({ length: 267 }, (_, index) => index + 1))
    expect(migrations.filter(row => row.version === 265)).toHaveLength(1)
    expect(sql).toContain('commercial_catalog_bundle_refs_v3')
    expect(sql).toContain("jsonb_array_elements(")
    expect(sql).toContain("os.snapshot->'sku'->'payload'->'bundleRefs'")
  })

  it('requires Ops platform scope and returns a bounded keyset page with total and cursor', async () => {
    const sql = await readFile(new URL('./migrations/265_commercial_bundle_reference_reader.sql', import.meta.url), 'utf8')
    expect(sql).toContain("current_setting('app.platform_scope',true) IS DISTINCT FROM 'platform_ops'")
    expect(sql).toContain('p_limit+1')
    expect(sql).toContain("'next_after_id'")
    expect(sql).toContain("'total'")
    expect(sql).toContain('REVOKE ALL ON FUNCTION merchant_ops_benefit_bundle_references_v3(text,text,text,integer) FROM PUBLIC')
    expect(sql).toContain('TO merchant_ops')
  })
})
