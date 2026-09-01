import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 121 authorization reservation ACL convergence', () => {
  it('removes legacy merchant_app privileges and preserves worker least privilege', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 121)).toMatchObject({ version: 121, name: 'authorization_execution_reservations_acl' })
    const sql = await readFile(new URL('./migrations/121_authorization_execution_reservations_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE ALL ON authorization_execution_reservations FROM merchant_app')
    expect(sql).toContain('GRANT SELECT, INSERT ON authorization_execution_reservations TO merchant_ops')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON authorization_execution_reservations FROM merchant_ops')
  })
})
