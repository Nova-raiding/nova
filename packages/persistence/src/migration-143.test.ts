import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 143 operations platform scope', () => {
  it('requires an explicit platform operations scope for the summary view', async () => {
    const sql = await readFile(new URL('./migrations/143_require_ops_platform_scope_for_summary.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 143)).toMatchObject({ version: 143, name: 'require_ops_platform_scope_for_summary' })
    expect(sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
    expect(sql).toContain('security_barrier = true')
  })
})
