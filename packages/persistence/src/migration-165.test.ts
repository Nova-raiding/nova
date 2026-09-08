import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 165 object storage orphan runtime ACL', () => {
  it('keeps the object-storage ACL repair immediately before migration 166', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 165)).toMatchObject({ version: 165, name: 'object_storage_orphan_runtime_acl' })
    expect(migrations.findIndex(item => item.version === 165)).toBe(migrations.findIndex(item => item.version === 164) + 1)
    expect(migrations.filter(item => item.version === 165)).toHaveLength(1)
    expect(migrations.findIndex(item => item.version === 165) + 1).toBe(migrations.findIndex(item => item.version === 166))
  })

  it('keeps migration 043 immutable and grants only the runtime queue actions', async () => {
    const [historical, forward] = await Promise.all([
      readFile(new URL('./migrations/043_route_b_expand.sql', import.meta.url), 'utf8'),
      readFile(new URL('./migrations/165_object_storage_orphan_runtime_acl.sql', import.meta.url), 'utf8'),
    ])
    expect(historical).not.toContain('GRANT SELECT, INSERT, UPDATE ON TABLE object_storage_orphans')
    expect(forward).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE object_storage_orphans TO merchant_app')
    expect(forward).toContain('REVOKE DELETE, TRUNCATE ON TABLE object_storage_orphans FROM merchant_app')
  })
})
