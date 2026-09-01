import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 134 authorization event truncate guard', () => {
  it('registers owner-level truncate protection for both authorization ledgers', async () => {
    const sql = await readFile(new URL('./migrations/134_authorization_events_truncate_guard.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 134)).toMatchObject({ version: 134, name: 'authorization_events_truncate_guard' })
    expect(sql).toContain('BEFORE TRUNCATE ON platform_role_assignment_events')
    expect(sql).toContain('BEFORE TRUNCATE ON ops_access_grant_events')
    expect(sql).toContain('FOR EACH STATEMENT')
    expect(sql).toContain("RAISE EXCEPTION 'authorization events are append-only'")
  })
})
