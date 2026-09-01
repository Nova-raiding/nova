import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 136 workspace operation audit truncate guard', () => {
  it('registers the owner-safe append-only guard in the migration chain', async () => {
    const sql = await readFile(new URL('./migrations/136_workspace_operation_audit_truncate_guard.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 136)).toMatchObject({ version: 136, name: 'workspace_operation_audit_truncate_guard' })
    expect(sql).toContain('BEFORE TRUNCATE ON workspace_operation_audit')
    expect(sql).toContain("RAISE EXCEPTION 'workspace operation audit is append-only'")
    expect(sql).toContain('REVOKE TRUNCATE ON workspace_operation_audit FROM PUBLIC')
  })
})
