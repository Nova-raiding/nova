import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 090 isolate ops workspace directory', () => {
  it('exposes only the bounded ops summary to merchant_ops', async () => {
    const sql = await readFile(new URL('./migrations/090_isolate_ops_workspace_directory.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()

    expect(migrations.find(item => item.version === 90)).toMatchObject({ version: 90, name: 'isolate_ops_workspace_directory' })
    expect(migrations.find(item => item.version === 91)).toMatchObject({ version: 91, name: 'bind_platform_scope_to_ops_role' })
    expect(migrations.find(item => item.version === 92)).toMatchObject({ version: 92, name: 'image_generation_executions' })
    expect(migrations.find(item => item.version === 95)).toMatchObject({ version: 95, name: 'runtime_append_only_privileges' })
    expect(migrations.find(item => item.version === 96)).toMatchObject({ version: 96, name: 'reconciliation_evidence' })
    expect(migrations.find(item => item.version === 97)).toMatchObject({ version: 97, name: 'reconciliation_evidence_unknown_errors' })
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: 109 }, (_, index) => index + 1))
    expect(sql).toContain('WITH (security_barrier = true)')
    expect(sql).toContain('REVOKE ALL ON TABLE ops_workspace_summaries FROM merchant_app')
    expect(sql).toContain('GRANT SELECT ON TABLE ops_workspace_summaries TO merchant_ops')
  })
})
