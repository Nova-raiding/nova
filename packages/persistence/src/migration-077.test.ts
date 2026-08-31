import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 077 canonical publish scope integrity', () => {
  it('is registered after 076 and preserves the legacy chain', async () => {
    const migrations = await loadMigrations()
    const migration = migrations.find(item => item.version === 77)
    expect(migration?.name).toBe('canonical_publish_scope_integrity')
    expect(migration?.sql).toContain('tasks_canonical_publish_scope')
    expect(migration?.sql).toContain('publish_jobs_task_scope')
    expect(migration?.sql).toContain('publish_jobs_task_scope_idx')
    expect(migration?.sql).not.toMatch(/\bDELETE\s+FROM\b|\bUPDATE\s+tasks\b|\bUPDATE\s+publish_jobs\b/iu)
  })

  it('fails closed on canonical, listing, platform, or account mismatches', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 77)?.sql ?? ''
    expect(sql).toContain('canonical.legacy_product_id IS DISTINCT FROM NEW.product_id')
    expect(sql).toContain('listing.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id')
    expect(sql).toContain('listing.platform IS DISTINCT FROM NEW.platform')
    expect(sql).toContain('task.platform_account_id IS DISTINCT FROM NEW.platform_account_id')
    expect(sql).toContain("USING ERRCODE = '23514'")
  })
})
