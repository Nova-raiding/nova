import { describe, expect, it } from 'vitest'
import { loadMigrations, splitTopLevelSqlStatements } from './migration.js'

describe('workspace identity binding membership integrity migration SQL contract', () => {
  it('adds one transactional, deferred foreign key without rewriting historical data', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 203)
    expect(migration).toMatchObject({ name: 'workspace_identity_binding_member_fk' })
    expect(migration?.transactional).not.toBe(false)

    const statements = splitTopLevelSqlStatements(migration!.sql)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('ADD CONSTRAINT workspace_identity_bindings_member_fk')
    expect(statements[0]).toContain('FOREIGN KEY (workspace_id, external_subject)')
    expect(statements[0]).toContain('REFERENCES workspace_members (workspace_id, external_subject)')
    expect(statements[0]).toContain('ON DELETE RESTRICT')
    expect(statements[0]).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(statements[0]).toContain('NOT VALID')
  })

  it('does not backfill membership, relax tenant isolation, or mutate identity bindings', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 203)!.sql
    expect(sql).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+workspace_|DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?workspace_)\b/iu)
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE|POLICY|DISABLE ROW LEVEL SECURITY)\b/iu)
    expect(sql).not.toContain('VALIDATE CONSTRAINT')
  })
})
