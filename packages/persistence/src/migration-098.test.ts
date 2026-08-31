import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 098 unified link audit', () => {
  it('creates a workspace-isolated, upsertable canonical relationship audit projection', async () => {
    const sql = await readFile(new URL('./migrations/098_unified_link_audit.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS unified_link_audit')
    expect(sql).toContain('UNIQUE (workspace_id,audit_key)')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('GRANT SELECT,INSERT,UPDATE ON TABLE unified_link_audit TO merchant_app')
    expect((await loadMigrations()).find(item => item.version === 98)).toMatchObject({ version: 98, name: 'unified_link_audit' })
  })
})
