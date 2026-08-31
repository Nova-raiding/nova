import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 120 authorization execution reservations', () => {
  it('registers a tenant-scoped, append-only reservation table with CAS identity constraints', async () => {
    const sql = await readFile(new URL('./migrations/120_authorization_execution_reservations.sql', import.meta.url), 'utf8')
    const migration = (await loadMigrations()).find(item => item.version === 120)
    expect(migration).toMatchObject({ version: 120, name: 'authorization_execution_reservations' })
    expect(migration?.sql).toBe(sql)
    expect(sql).toContain('authorization_execution_reservations')
    expect(sql).toContain('event_id TEXT NOT NULL UNIQUE')
    expect(sql).toContain('grant_id UUID REFERENCES ops_access_grants(id)')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('GRANT SELECT, INSERT ON authorization_execution_reservations TO merchant_ops')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON authorization_execution_reservations FROM merchant_ops')
  })
})
