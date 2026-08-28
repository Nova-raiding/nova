import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('045 platform identity lifecycle migration', () => {
  it('ships the identity, session, event, member binding, RLS and append-only contract', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 45)
    expect(migration?.name).toBe('platform_identity_lifecycle')
    for (const table of ['platform_identities', 'platform_auth_sessions', 'platform_identity_events']) {
      expect(migration?.sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
      expect(migration?.sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    }
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS identity_id UUID')
    expect(migration?.sql).toContain('workspace_members_workspace_identity_key')
    expect(migration?.sql).toContain('workspace_members_select_scope')
    expect(migration?.sql).toContain('workspace_members_update_scope')
    expect(migration?.sql).toContain('platform_identity_events_idempotency_idx')
    expect(migration?.sql).toContain('platform_identity_events_append_only')
    expect(migration?.sql).toContain("current_setting('app.identity_id', true)")
  })
})
