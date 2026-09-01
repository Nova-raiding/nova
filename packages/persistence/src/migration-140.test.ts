import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 140 interactive confirmation ticket fencing', () => {
  it('adds fenced leases and immutable consumed operation binding with least privilege', async () => {
    const sql = await readFile(new URL('./migrations/140_interactive_confirmation_ticket_fencing.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reservation_token TEXT')
    expect(sql).toContain('reservation_revision BIGINT NOT NULL DEFAULT 0')
    expect(sql).toContain('consumed_operation_id TEXT')
    expect(sql).toContain("reservation_token = encode(gen_random_bytes(32), 'hex')")
    expect(sql).toContain("consumed_operation_id = 'legacy-ticket:' || nonce_hash")
    expect(sql).toContain("reservation_token ~ '^[0-9a-f]{64}$'")
    expect(sql).toContain('reservation_revision > 0')
    expect(sql).toContain('consumed_at IS NOT NULL')
    expect(sql).toContain('BEFORE UPDATE OF consumed_at, consumed_operation_id, reservation_id, reservation_token')
    expect(sql).toContain('GRANT UPDATE (consumed_at, consumed_operation_id, reservation_id, reservation_token')
    expect(sql).toContain('REVOKE UPDATE (workspace_id, actor_id, session_id, intent_hash, nonce_hash')
    expect((await loadMigrations()).at(-1)).toMatchObject({ version: 140, name: 'interactive_confirmation_ticket_fencing' })
  })
})
