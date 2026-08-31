import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 095 runtime append-only privileges', () => {
  it('removes destructive privileges from durable evidence tables', async () => {
    const sql = await readFile(new URL('./migrations/095_runtime_append_only_privileges.sql', import.meta.url), 'utf8')
    expect(sql).toContain('action_ledger')
    expect(sql).toContain('model_usage_ledger')
    expect(sql).toContain('workspace_operation_audit')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE')
    expect((await loadMigrations()).find(item => item.version === 95)).toMatchObject({ version: 95, name: 'runtime_append_only_privileges' })
    expect((await loadMigrations()).find(item => item.version === 96)).toMatchObject({ version: 96, name: 'reconciliation_evidence' })
    expect((await loadMigrations()).find(item => item.version === 97)).toMatchObject({ version: 97, name: 'reconciliation_evidence_unknown_errors' })
  })
})
