import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('asset scan bootstrap migration 279', () => {
  it('registers immutable, tenant-scoped evidence for historical unscanned assets', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/279_asset_scan_bootstrap.sql', import.meta.url), 'utf8')
    expect(migrations.find(row => row.version === 279)).toEqual({ version: 279, name: 'asset_scan_bootstrap', sql })
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS asset_scan_bootstraps')
    expect(sql).toContain('UNIQUE (workspace_id,recovery_key)')
    expect(sql).toContain('ALTER TABLE asset_scan_bootstraps FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("asset scan bootstrap evidence is immutable and cannot be deleted")
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE asset_scan_bootstraps TO merchant_app')
    const repository = await readFile(new URL('./asset-scan-redrive-repository.ts', import.meta.url), 'utf8')
    const bootstrapSource = repository.slice(repository.indexOf('async bootstrapUnscanned('))
    expect(bootstrapSource).toContain('FOR UPDATE')
    expect(bootstrapSource).toContain("current.scanStatus !== 'unscanned'")
    expect(bootstrapSource).toContain("next.scanStatus = 'quarantined'")
    expect(bootstrapSource).toContain("'asset.scan_bootstrap_requested'")
    expect(bootstrapSource).not.toContain("next.scanStatus = 'clean'")
  })
})
