import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('069 platform account scope integrity', () => {
  it('pins lookup resolution and exposes no trigger-function execution', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 69)
    expect(migration).toMatchObject({ name: 'platform_account_scope_integrity' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('SET search_path = pg_catalog, public')
    expect(sql).toContain('FROM public.platform_accounts account')
    expect(sql).toContain('REVOKE ALL ON FUNCTION assert_platform_account_scope() FROM PUBLIC')
    expect(sql).toContain('REVOKE ALL ON FUNCTION assert_platform_account_scope() FROM merchant_app')
    expect(sql).toContain('REVOKE ALL ON FUNCTION assert_platform_account_scope() FROM merchant_ops')
    for (const table of ['products', 'tasks', 'publish_jobs']) {
      expect(sql).toContain(`CREATE TRIGGER ${table}_platform_account_scope`)
    }
    expect(sql).not.toMatch(/GRANT\s+/iu)
  })
})
