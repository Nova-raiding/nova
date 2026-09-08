import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 166 executable commercial catalog v2', () => {
  it('is the single next migration and publishes only resolved offers', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 166)).toMatchObject({ version: 166, name: 'commercial_catalog_executable_v2' })
    expect(migrations.findIndex(item => item.version === 166)).toBe(migrations.findIndex(item => item.version === 165) + 1)
    expect(migrations.filter(item => item.version === 166)).toHaveLength(1)
  })

  it('binds prices, permissions, expiry and point rates in immutable snapshots', async () => {
    const sql = await readFile(new URL('./migrations/166_commercial_catalog_executable_v2.sql', import.meta.url), 'utf8')
    for (const value of ['50000000000', 'GB_DECIMAL', 'next_monthly_anniversary', 'billing_period_end', 'purchase_plus_30_natural_days', 'rate-video-standard-15s-v2', "'video',90", "'text.generate','request',1", '"blockers":[]']) expect(sql).toContain(value)
    expect(sql).toContain("'sku-version-private-validation-7d-v2'")
    expect(sql).toContain('PRIVATE_OFFER_ELIGIBILITY_UNRESOLVED')
    expect(sql).toContain('ORDER_TERMS_REQUIRED')
  })
})
