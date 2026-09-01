import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 105 durable authorization grants', () => {
  it('ships the complete migration chain and durable authorization tables', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 105)).toMatchObject({ version: 105, name: 'durable_authorization_grants' })
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: 122 }, (_, index) => index + 1))
    const sql = await readFile(new URL('./migrations/105_durable_authorization_grants.sql', import.meta.url), 'utf8')
    for (const table of ['authorization_revisions', 'platform_role_assignments', 'platform_role_assignment_events', 'ops_access_grants', 'ops_access_grant_events']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    }
  })

  it('binds control-plane RLS to the database role and strips tenant/runtime privileges', async () => {
    const sql = await readFile(new URL('./migrations/105_durable_authorization_grants.sql', import.meta.url), 'utf8')
    expect(sql.match(/current_user = 'merchant_ops'/gu)?.length).toBeGreaterThanOrEqual(5)
    expect(sql.match(/current_setting\('app\.platform_scope', true\) = 'platform_ops'/gu)?.length).toBeGreaterThanOrEqual(5)
    expect(sql).toContain('REVOKE ALL ON authorization_revisions, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_app')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON authorization_revisions')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON platform_role_assignment_events, ops_access_grant_events FROM merchant_ops')
  })

  it('enforces revocation completeness, JIT TTL, use budgets, and two-person write approval in PostgreSQL', async () => {
    const sql = await readFile(new URL('./migrations/105_durable_authorization_grants.sql', import.meta.url), 'utf8')
    expect(sql).toContain("expires_at <= issued_at + interval '15 minutes'")
    expect(sql).toContain("expires_at <= issued_at + interval '5 minutes'")
    expect(sql).toContain("access_mode <> 'write' OR approved_by <> issued_by")
    expect(sql).toContain('use_count >= 0 AND use_count <= max_uses')
    expect(sql).toContain('revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL')
    expect(sql).toContain('authorization_revision BIGINT NOT NULL CHECK (authorization_revision > 0)')
  })
})
