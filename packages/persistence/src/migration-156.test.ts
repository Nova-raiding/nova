import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 156 commercial outbox insert ACL', () => {
  it('grants only append permission required by the atomic commercial UoW', async () => {
    const sql = await readFile(new URL('./migrations/156_commercial_outbox_insert_acl.sql', import.meta.url), 'utf8')
    expect(sql).toContain('GRANT INSERT ON outbox_events TO merchant_app')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON outbox_events FROM merchant_app')
    expect(sql).not.toContain('GRANT ALL')
  })
  it('is the registered migration tail', async () => {
    expect((await loadMigrations()).find(item => item.version === 156)).toMatchObject({ version: 156, name: 'commercial_outbox_insert_acl' })
  })
})
