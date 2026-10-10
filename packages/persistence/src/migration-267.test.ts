import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('asset snapshot lifecycle repair migration 267', () => {
  it('registers the forward-only repair at the migration tail', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/267_asset_snapshot_lifecycle_repair.sql', import.meta.url), 'utf8')
    expect(migrations.find(row => row.version === 267)).toEqual({ version: 267, name: 'asset_snapshot_lifecycle_repair', sql })
    expect(migrations.slice(-6).map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 267, name: 'asset_snapshot_lifecycle_repair' },
      { version: 268, name: 'demo_evaluation_regrant_guard' },
      { version: 269, name: 'merchant_activation_status_acl' },
      { version: 270, name: 'catalog_batch_import_idempotency' },
      { version: 271, name: 'cash_return_receipt_scope' },
      { version: 272, name: 'publish_media_orphan_outbox' },
    ])
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS snapshot_entity_type')
    expect(sql).toContain('merchant_asset_lifecycle_asset_snapshot_fk')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS merchant_asset_lifecycle_snapshot_fk_idx')
  })
})
