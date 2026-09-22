import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 244', () => {
  it('adds pairing, request-bound challenges, RLS, and append-only audit', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 244)
    expect(migration?.name).toBe('local_plugin_install_instances')
    expect(migration?.sql).toContain('pairing_token_hash')
    expect(migration?.sql).toContain('REFERENCES local_plugin_connection_requests(id)')
    expect(migration?.sql).toContain('local_plugin_install_audit_append_only')
    expect(migration?.sql).toContain('FORCE ROW LEVEL SECURITY')
  })
})
