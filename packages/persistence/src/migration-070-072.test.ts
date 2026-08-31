import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

async function migrationSql(version: number) {
  const migration = (await loadMigrations()).find(item => item.version === version)
  expect(migration, `migration ${version} must be registered`).toBeDefined()
  return migration!.sql
}

describe('product asset binding migrations', () => {
  it('keeps 070 before 072 and ships both physical SQL files', async () => {
    const migrations = await loadMigrations()
    const v070 = migrations.findIndex(item => item.version === 70)
    const v072 = migrations.findIndex(item => item.version === 72)

    expect(v070).toBeGreaterThanOrEqual(0)
    expect(v072).toBeGreaterThan(v070)
    expect(await readFile(new URL('./migrations/070_product_asset_bindings.sql', import.meta.url), 'utf8')).toContain('products_asset_bindings_sync')
    expect(await readFile(new URL('./migrations/072_product_asset_binding_integrity.sql', import.meta.url), 'utf8')).toContain('product_asset_bindings_asset_validate')
  })

  it('guards malformed sourceAssetIds instead of expanding non-arrays', async () => {
    const sql = await migrationSql(72)

    expect(sql).toContain("jsonb_typeof(NEW.data->'sourceAssetIds') = 'array'")
    expect(sql).toContain("ELSE '[]'::jsonb")
    expect(sql).toContain('jsonb_array_elements_text(source_ids)')
    expect(sql).not.toContain("jsonb_array_elements_text(COALESCE(NEW.data->'sourceAssetIds'")
  })

  it('preserves disabled source bindings and curated non-source roles', async () => {
    const sql = await migrationSql(72)
    const schemaSql = await migrationSql(70)

    expect(sql).toContain("binding.asset_role = 'source'")
    expect(sql).toContain("binding.status = 'active'")
    expect(sql).toContain("SET status = 'disabled'")
    expect(schemaSql).toContain("asset_role IN ('source', 'main', 'secondary', 'detail')")
    expect(sql).not.toContain('DELETE FROM public.product_asset_bindings')
    expect(sql).not.toContain('status = \'active\', updated_at = now()')
  })

  it('rejects direct writes for missing or cross-workspace assets', async () => {
    const sql = await migrationSql(72)

    expect(sql).toContain('BEFORE INSERT OR UPDATE OF workspace_id, asset_id')
    expect(sql).toContain('asset.workspace_id = NEW.workspace_id')
    expect(sql).toContain('asset.entity_type = \'asset\'')
    expect(sql).toContain('asset.entity_id = NEW.asset_id')
    expect(sql).toContain("RAISE EXCEPTION 'asset % does not exist in workspace %'")
    expect(sql).toContain("USING ERRCODE = '23503'")
  })

  it('keeps 070 backfill tenant-scoped and conservative for unresolved IDs', async () => {
    const sql = await migrationSql(70)

    expect(sql).toContain('product.workspace_id, product.id, value')
    expect(sql).toContain('asset.workspace_id = product.workspace_id')
    expect(sql).toContain("asset.entity_type = 'asset'")
    expect(sql).toContain('ON CONFLICT (workspace_id, product_id, asset_id, asset_role) DO NOTHING')
    expect(sql).toContain('Unresolved')
  })
})
