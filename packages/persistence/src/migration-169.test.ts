import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations, verifyAppliedMigrations } from './migration.js'

const APPLIED_MIGRATION_168_CHECKSUM = '37f633fb25a7d1536f65a644a1adee3611c36ed416ac9a1bf3a10a1e92ab1ef1'

describe('migration 169 onboarding grant expiration', () => {
  it('is the ordered forward-only expiration-fact repair', async () => {
    const migrations = await loadMigrations()
    expect(migrations.findIndex(item => item.version === 169)).toBe(migrations.findIndex(item => item.version === 168) + 1)
    const sql = await readFile(new URL('./migrations/169_onboarding_grant_expiration.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS onboarding_point_grant_expirations_v2')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('onboarding_point_grant_expirations_v2_append_only')
  })

  it('accepts only the recorded pre-repair identity for migration 168', async () => {
    const migration168 = (await loadMigrations()).find(item => item.version === 168)
    expect(migration168).toBeDefined()
    expect(() => verifyAppliedMigrations([
      { version: 168, name: 'onboarding_grant_dispatch', checksum: APPLIED_MIGRATION_168_CHECKSUM },
    ], [migration168!])).not.toThrow()
    expect(() => verifyAppliedMigrations([
      { version: 168, name: 'onboarding_grant_dispatch', checksum: '0'.repeat(64) },
    ], [migration168!])).toThrowError(expect.objectContaining({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: 168 }))
  })
})
