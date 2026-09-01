import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 125 authorization event immutability', () => {
  it('protects role and grant history beyond runtime ACLs', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 125)).toMatchObject({
      version: 125,
      name: 'authorization_events_append_only',
    })

    const sql = await readFile(new URL('./migrations/125_authorization_events_append_only.sql', import.meta.url), 'utf8')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON platform_role_assignment_events')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON ops_access_grant_events')
    expect(sql).toContain("RAISE EXCEPTION 'authorization events are append-only'")
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE')
  })
})
