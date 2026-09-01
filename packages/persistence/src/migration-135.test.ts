import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 135 authorization event scope integrity', () => {
  it('registers insert-time subject and workspace consistency guards', async () => {
    const sql = await readFile(new URL('./migrations/135_authorization_event_scope_integrity.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 135)).toMatchObject({
      version: 135,
      name: 'authorization_event_scope_integrity',
    })
    expect(sql).toContain('BEFORE INSERT ON platform_role_assignment_events')
    expect(sql).toContain('BEFORE INSERT ON ops_access_grant_events')
    expect(sql).toContain("RAISE EXCEPTION 'platform role assignment event scope is invalid'")
    expect(sql).toContain("RAISE EXCEPTION 'ops access grant event scope is invalid'")
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE/iu)
  })
})
