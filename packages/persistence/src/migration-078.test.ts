import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 078 late asset binding backfill', () => {
  it('backfills same-workspace products when an asset snapshot arrives', async () => {
    const sql = await readFile(new URL('./migrations/078_asset_snapshot_binding_backfill.sql', import.meta.url), 'utf8')
    expect(sql).toContain('asset_snapshot_product_bindings_backfill')
    expect(sql).toContain('NEW.entity_type <> \'asset\'')
    expect(sql).toContain('product.workspace_id = NEW.workspace_id')
    expect(sql).toContain('AFTER INSERT OR UPDATE OF payload ON business_entity_snapshots')
    expect(sql).not.toContain('UPDATE OF data ON business_entity_snapshots')
    expect(sql).toContain('ON CONFLICT (workspace_id, product_id, asset_id, asset_role)')
    expect(sql).toContain('remove_product_asset_bindings_for_asset')
    expect(sql).not.toContain('DO UPDATE SET ordinal = EXCLUDED.ordinal, status = \'active\'')
    expect(sql).toContain('REVOKE ALL ON FUNCTION backfill_product_asset_bindings_for_asset() FROM PUBLIC')
  })

  it('is registered as the executable chain tail', async () => {
    expect((await loadMigrations()).find((migration) => migration.version === 78)).toMatchObject({ version: 78, name: 'asset_snapshot_binding_backfill' })
  })
})
