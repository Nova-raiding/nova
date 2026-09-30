import { describe, expect, it } from 'vitest'
import { loadMigrations, migrationChecksum } from './migration.js'

describe('migration 257 asset lifecycle snapshot reference', () => {
  it('keeps migration 256 immutable and adds a forward-only snapshot foreign key', async () => {
    const migrations = await loadMigrations()
    expect(migrations[255]).toMatchObject({ version: 256, name: 'asset_lifecycle' })
    expect(migrationChecksum(migrations[255]!.sql)).toBe('2c1bcf1fb344dbc2f3823d0ffc85b3561b1e3163e367f1bb45f2941c613ee619')
    const migration = migrations[256]
    expect(migration).toMatchObject({ version: 257, name: 'asset_snapshot_lifecycle_guard' })
    expect(migration?.sql).toContain("ADD COLUMN snapshot_entity_type TEXT NOT NULL DEFAULT 'asset'")
    expect(migration?.sql).toContain('FOREIGN KEY (workspace_id, snapshot_entity_type, asset_id)')
    expect(migration?.sql).toContain('REFERENCES business_entity_snapshots (workspace_id, entity_type, entity_id)')
    expect(migration?.sql).toContain('ON DELETE RESTRICT')
    expect(migration?.sql).toContain('merchant_asset_lifecycle_snapshot_fk_idx')
    expect(migrations[255]?.sql).toContain('merchant_asset_lifecycle_snapshot_delete_guard')
    expect(migration?.sql).not.toMatch(/DROP\s+TABLE|TRUNCATE/iu)
  })
})
