import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 145 ops workspace summary security', () => {
  it('preserves invoker RLS semantics and removes tenant view access', async () => {
    const sql = await readFile(new URL('./migrations/145_harden_ops_workspace_summary_security.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 145)).toMatchObject({ version: 145, name: 'harden_ops_workspace_summary_security' })
    expect(sql).toContain('security_barrier = true, security_invoker = true')
    expect(sql).toContain('REVOKE ALL ON TABLE ops_workspace_summaries FROM merchant_app')
    expect(sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
  })
})
