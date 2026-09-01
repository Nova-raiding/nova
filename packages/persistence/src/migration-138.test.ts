import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 138 interactive confirmation ticket nonce digest', () => {
  it('marks existing rows as legacy and defaults future rows to digest storage', async () => {
    const sql = await readFile(new URL('./migrations/138_interactive_confirmation_ticket_nonce_digest.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS nonce_digest_version SMALLINT NOT NULL DEFAULT 1')
    expect(sql).toContain('CHECK (nonce_digest_version IN (1, 2))')
    expect(sql).toContain('ALTER COLUMN nonce_digest_version SET DEFAULT 2')
    expect(sql).toContain('GRANT INSERT (workspace_id, actor_id, session_id, intent_hash, nonce_hash, expires_at)')
    expect(sql).toContain('REVOKE UPDATE (nonce_digest_version) ON interactive_confirmation_tickets FROM merchant_app')
    expect((await loadMigrations()).at(-1)).toMatchObject({ version: 138, name: 'interactive_confirmation_ticket_nonce_digest' })
  })
})
