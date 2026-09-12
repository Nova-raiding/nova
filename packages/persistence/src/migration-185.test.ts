import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 185 runtime role ACL hardening', () => {
  it('is registered as the latest forward-only runtime ACL repair', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 185)).toMatchObject({ version: 185, name: 'harden_runtime_role_acl' })
    const sql = await readFile(new URL('./migrations/185_harden_runtime_role_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE ALL ON platform_feature_flags')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE')
    expect(sql).toContain('knowledge_index_events, knowledge_deletion_proofs')
    expect(sql).toContain('schema_migrations')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE')
    expect(sql).not.toContain('DROP TABLE')
  })
})
