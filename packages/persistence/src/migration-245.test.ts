import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 245 local plugin authorization timestamp', () => {
  it('adds the forward-only authorized timestamp constraint without inventing historical authorization data', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 245)
    expect(migration).toMatchObject({ name: 'local_plugin_authorized_timestamp' })
    expect(migration?.sql).toContain('ALTER TABLE local_plugin_connection_requests')
    expect(migration?.sql).toContain('ADD CONSTRAINT local_plugin_connection_requests_authorized_timestamp_check')
    expect(migration?.sql).toContain("CHECK (status <> 'authorized' OR authorized_at IS NOT NULL)")
    expect(migration?.sql).not.toContain('DROP CONSTRAINT')
    expect(migration?.sql).not.toContain('UPDATE local_plugin_connection_requests')
  })
})
