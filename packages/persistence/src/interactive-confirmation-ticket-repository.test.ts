import { describe, expect, it } from 'vitest'
import { PostgresInteractiveConfirmationTicketRepository, type InteractiveConfirmationTicket } from './interactive-confirmation-ticket-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly affectedRows: number[]) {}
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    const rowCount = text.startsWith('INSERT INTO interactive_confirmation_tickets') || text.startsWith('UPDATE interactive_confirmation_tickets')
      ? this.affectedRows.shift() ?? 0
      : 0
    return { rows: [] as Row[], rowCount }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const now = new Date('2026-08-31T03:00:00.000Z')
const ticket: InteractiveConfirmationTicket = {
  workspaceId: 'ws_confirm_a',
  actorId: 'actor-a',
  sessionId: 'session-a',
  intentHash: 'a'.repeat(64),
  nonceHash: 'b'.repeat(64),
  expiresAt: '2026-08-31T03:10:00.000Z',
}

describe('PostgresInteractiveConfirmationTicketRepository', () => {
  it('issues a bounded ticket inside the workspace transaction', async () => {
    const client = new RecordingClient([1])
    const repository = new PostgresInteractiveConfirmationTicketRepository(new RecordingPool(client), () => now)
    await expect(repository.issue(ticket)).resolves.toEqual(ticket)
    const insert = client.calls.find(call => call.text.startsWith('INSERT INTO interactive_confirmation_tickets'))
    expect(insert?.values).toEqual([ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.expiresAt])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it.each([[1, true], [0, false]] as const)('atomically consumes rowCount=%i as %s', async (rowCount, consumed) => {
    const client = new RecordingClient([rowCount])
    const repository = new PostgresInteractiveConfirmationTicketRepository(new RecordingPool(client), () => now)
    await expect(repository.consume(ticket)).resolves.toBe(consumed)
    const updates = client.calls.filter(call => call.text.startsWith('UPDATE interactive_confirmation_tickets'))
    expect(updates).toHaveLength(1)
    expect(updates[0]!.text).toContain('SET consumed_at=now()')
    expect(updates[0]!.text).toContain('consumed_at IS NULL')
    expect(updates[0]!.text).toContain('expires_at>now()')
    expect(updates[0]!.text).toContain('actor_id=$2')
    expect(updates[0]!.text).toContain('session_id=$3')
    expect(updates[0]!.text).toContain('intent_hash=$4')
    expect(updates[0]!.values).toEqual([ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash])
  })

  it('rejects expired, overlong, malformed, or normalized-away ticket fields before SQL', async () => {
    const client = new RecordingClient([])
    const repository = new PostgresInteractiveConfirmationTicketRepository(new RecordingPool(client), () => now)
    await expect(repository.issue({ ...ticket, expiresAt: now.toISOString() })).rejects.toThrow('INTERACTIVE_CONFIRMATION_EXPIRED')
    await expect(repository.issue({ ...ticket, expiresAt: '2026-08-31T03:16:00.000Z' })).rejects.toThrow('INTERACTIVE_CONFIRMATION_TTL_EXCEEDED')
    await expect(repository.issue({ ...ticket, actorId: ' actor-a' })).rejects.toThrow('INTERACTIVE_CONFIRMATION_ACTOR_ID_INVALID')
    await expect(repository.issue({ ...ticket, intentHash: 'A'.repeat(64) })).rejects.toThrow('INTERACTIVE_CONFIRMATION_INTENT_HASH_INVALID')
    await expect(repository.consume({ ...ticket, sessionId: 'session\u0000' })).rejects.toThrow('INTERACTIVE_CONFIRMATION_SESSION_ID_INVALID')
    expect(client.calls).toEqual([])
  })
})
