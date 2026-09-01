import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 141 interactive confirmation ticket ACL guard', () => {
  it('closes nullable reservation and inherited table privilege bypasses', async () => {
    const sql = await readFile(new URL('./migrations/141_interactive_confirmation_ticket_acl_guard.sql', import.meta.url), 'utf8')
    expect(sql).toContain('reservation_token IS NOT NULL')
    expect(sql).toContain('REVOKE UPDATE ON TABLE interactive_confirmation_tickets FROM merchant_app')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON TABLE interactive_confirmation_tickets FROM merchant_app')
    expect((await loadMigrations()).find(item => item.version === 141)).toMatchObject({ version: 141, name: 'interactive_confirmation_ticket_acl_guard' })
  })
})
