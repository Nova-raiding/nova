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
})
