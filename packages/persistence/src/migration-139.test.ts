import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 139 interactive confirmation ticket reservations', () => {
  it('adds an additive, tenant-scoped reservation lease with least-privilege updates', async () => {
    const sql = await readFile(new URL('./migrations/139_interactive_confirmation_ticket_reservations.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reservation_id TEXT')
    expect(sql).toContain('interactive_confirmation_ticket_reservation_shape')
    expect(sql).toContain('reservation_expires_at <= expires_at')
    expect(sql).toContain('interactive_confirmation_tickets_active_reservation_idx')
    expect(sql).toContain('BEFORE UPDATE OF consumed_at, reservation_id, reserved_at, reservation_expires_at')
    expect(sql).toContain('GRANT UPDATE (consumed_at, reservation_id, reserved_at, reservation_expires_at)')
    expect(sql).toContain('REVOKE UPDATE (workspace_id, actor_id, session_id, intent_hash, nonce_hash, expires_at)')
    expect((await loadMigrations()).at(-1)).toMatchObject({ version: 139, name: 'interactive_confirmation_ticket_reservations' })
  })
})
