import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 160 commercial point adjustment approval ACL repair', () => {
  it('keeps merchant_ops read-only and grants only API runtime inserts', async () => {
    const sql = await readFile(new URL('./migrations/160_commercial_point_adjustment_approval_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE')
    expect(sql).toContain('FROM merchant_ops')
    expect(sql).toContain('GRANT SELECT, INSERT')
    expect(sql).toContain('TO merchant_app')
  })
  it('is registered at version 160', async () => {
    expect((await loadMigrations()).find(item => item.version === 160)).toMatchObject({ version: 160, name: 'commercial_point_adjustment_approval_acl' })
  })
})
