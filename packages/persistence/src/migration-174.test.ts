import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 174 private trial entitlement activation', () => {
  it('registers the private SKU activation as a forward, idempotent catalog migration', async () => {
    const migrations = await loadMigrations()
    expect(migrations.at(-1)).toMatchObject({ version: 174, name: 'private_trial_entitlement_activation' })
    const sql = await readFile(new URL('./migrations/174_private_trial_entitlement_activation.sql', import.meta.url), 'utf8')
    expect(sql).toContain("sku-version-private-validation-7d-v3")
    expect(sql).toContain("'approved', true")
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING')
  })
})
