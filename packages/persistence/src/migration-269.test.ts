import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('merchant activation status ACL migration 269', () => {
  it('registers the narrow status transition grant after the complete chain', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/269_merchant_activation_status_acl.sql', import.meta.url), 'utf8')
    expect(migrations.at(-1)).toEqual({ version: 269, name: 'merchant_activation_status_acl', sql })
    expect(sql).toContain('GRANT UPDATE (status, identity_id, revision, updated_at) ON workspace_members TO merchant_ops')
    expect(sql).toContain('REVOKE UPDATE ON workspace_members FROM merchant_ops')
  })

  it('does not widen table-level writes or grant unrelated workspace member columns', async () => {
    const sql = await readFile(new URL('./migrations/269_merchant_activation_status_acl.sql', import.meta.url), 'utf8')
    const uncommentedSql = sql.replace(/--[^\n]*/gu, '')
    const grants = [...uncommentedSql.matchAll(/\b(?:GRANT|REVOKE)\b[^;]+;/giu)].map((match) => match[0].replace(/\s+/gu, ' ').trim())

    expect(grants).toContain('REVOKE UPDATE ON workspace_members FROM merchant_ops;')
    expect(grants).toContain('GRANT UPDATE (status, identity_id, revision, updated_at) ON workspace_members TO merchant_ops;')
    expect(grants.filter((grant) => /^GRANT\s+UPDATE\s+ON\s+workspace_members\b/iu.test(grant))).toEqual([])
    expect(grants.filter((grant) => /^GRANT\s+UPDATE\s*\(/iu.test(grant))).toEqual([
      'GRANT UPDATE (status, identity_id, revision, updated_at) ON workspace_members TO merchant_ops;',
    ])
    expect(sql).toContain("EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops')")
  })
})
