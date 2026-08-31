import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface InteractiveConfirmationTicket {
  workspaceId: string
  actorId: string
  sessionId: string
  intentHash: string
  nonceHash: string
  expiresAt: string
}

export type ConsumeInteractiveConfirmationTicketInput = Omit<InteractiveConfirmationTicket, 'expiresAt'>

export interface InteractiveConfirmationTicketRepository {
  issue(input: InteractiveConfirmationTicket): Promise<InteractiveConfirmationTicket>
  consume(input: ConsumeInteractiveConfirmationTicketInput): Promise<boolean>
}

const MAX_TICKET_TTL_MS = 15 * 60 * 1_000
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f\p{Cf}]/u

function identifier(value: string, code: string, maxLength: number) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength || CONTROL.test(value)) throw new Error(code)
  return value
}

function digest(value: string, code: string) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(code)
  return value
}

function expiry(value: string, now: Date) {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error('INTERACTIVE_CONFIRMATION_EXPIRES_AT_INVALID')
  if (milliseconds <= now.getTime()) throw new Error('INTERACTIVE_CONFIRMATION_EXPIRED')
  if (milliseconds - now.getTime() > MAX_TICKET_TTL_MS) throw new Error('INTERACTIVE_CONFIRMATION_TTL_EXCEEDED')
  return value
}

function scope(input: ConsumeInteractiveConfirmationTicketInput) {
  return {
    workspaceId: identifier(requireWorkspaceScope(input.workspaceId), 'INTERACTIVE_CONFIRMATION_WORKSPACE_ID_INVALID', 255),
    actorId: identifier(input.actorId, 'INTERACTIVE_CONFIRMATION_ACTOR_ID_INVALID', 255),
    sessionId: identifier(input.sessionId, 'INTERACTIVE_CONFIRMATION_SESSION_ID_INVALID', 512),
    intentHash: digest(input.intentHash, 'INTERACTIVE_CONFIRMATION_INTENT_HASH_INVALID'),
    nonceHash: digest(input.nonceHash, 'INTERACTIVE_CONFIRMATION_NONCE_HASH_INVALID'),
  }
}

export class MemoryInteractiveConfirmationTicketRepository implements InteractiveConfirmationTicketRepository {
  private readonly tickets = new Map<string, InteractiveConfirmationTicket>()

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async issue(input: InteractiveConfirmationTicket) {
    const bound = scope(input)
    const ticket = { ...bound, expiresAt: expiry(input.expiresAt, this.clock()) }
    if (this.tickets.has(ticket.nonceHash)) throw new Error('INTERACTIVE_CONFIRMATION_NONCE_CONFLICT')
    this.tickets.set(ticket.nonceHash, ticket)
    return ticket
  }

  async consume(input: ConsumeInteractiveConfirmationTicketInput) {
    const ticket = scope(input)
    const stored = this.tickets.get(ticket.nonceHash)
    if (!stored || stored.workspaceId !== ticket.workspaceId || stored.actorId !== ticket.actorId || stored.sessionId !== ticket.sessionId || stored.intentHash !== ticket.intentHash) return false
    if (Date.parse(stored.expiresAt) <= this.clock().getTime()) return false
    this.tickets.delete(ticket.nonceHash)
    return true
  }
}

export class PostgresInteractiveConfirmationTicketRepository implements InteractiveConfirmationTicketRepository {
  constructor(private readonly pool: SqlPool, private readonly clock: () => Date = () => new Date()) {}

  async issue(input: InteractiveConfirmationTicket) {
    const bound = scope(input)
    const ticket = { ...bound, expiresAt: expiry(input.expiresAt, this.clock()) }
    return withWorkspaceTransaction(this.pool, ticket.workspaceId, async client => {
      const result = await client.query(
        `INSERT INTO interactive_confirmation_tickets
          (workspace_id,actor_id,session_id,intent_hash,nonce_hash,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz)`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.expiresAt],
      )
      if (result.rowCount !== 1) throw new Error('INTERACTIVE_CONFIRMATION_ISSUE_FAILED')
      return ticket
    })
  }

  async consume(input: ConsumeInteractiveConfirmationTicketInput) {
    const ticket = scope(input)
    return withWorkspaceTransaction(this.pool, ticket.workspaceId, async client => {
      const result = await client.query(
        `UPDATE interactive_confirmation_tickets
            SET consumed_at=now()
          WHERE workspace_id=$1
            AND actor_id=$2
            AND session_id=$3
            AND intent_hash=$4
            AND nonce_hash=$5
            AND consumed_at IS NULL
            AND expires_at>now()`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash],
      )
      return result.rowCount === 1
    })
  }
}
