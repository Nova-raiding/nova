import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 186 runtime auth ACL hardening', () => {
  it('is registered as a forward-only auth ACL repair', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 186)).toMatchObject({ version: 186, name: 'harden_runtime_auth_acl' })
    const sql = await readFile(new URL('./migrations/186_harden_runtime_auth_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE ALL ON platform_identities')
    expect(sql).toContain('platform_password_accounts')
    expect(sql).not.toContain('DROP TABLE')
  })
})
