import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 243 local plugin connection requests', () => {
  it('persists the one-time state machine with isolated ops ACL', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 243)
    expect(migration).toMatchObject({ name: 'local_plugin_connection_requests' })
    expect(migration?.sql).toContain("status IN ('pending','authorized','exchanged','expired')")
    expect(migration?.sql).toContain('REVOKE ALL ON local_plugin_connection_requests FROM PUBLIC')
    expect(migration?.sql).toContain('merchant_ops')
  })
})
