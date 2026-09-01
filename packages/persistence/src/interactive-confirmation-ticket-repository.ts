import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface InteractiveConfirmationTicket {
  workspaceId: string
  actorId: string
  sessionId: string
  intentHash: string
  nonceHash: string
  expiresAt: string
}

export type ConsumeInteractiveConfirmationTicketInput = Omit<InteractiveConfirmationTicket, 'expiresAt'> & {
  /** Raw bearer accepted only for rows created before digest-versioned storage. */
  legacyNonceHash?: string
}

export interface ReserveInteractiveConfirmationTicketInput extends ConsumeInteractiveConfirmationTicketInput {
  reservationId: string
  reservationExpiresAt: string
}

export type FinalizeInteractiveConfirmationTicketInput = Omit<ReserveInteractiveConfirmationTicketInput, 'reservationExpiresAt'>

export interface InteractiveConfirmationTicketRepository {
  issue(input: InteractiveConfirmationTicket): Promise<InteractiveConfirmationTicket>
  consume(input: ConsumeInteractiveConfirmationTicketInput): Promise<boolean>
}

export interface ReservableInteractiveConfirmationTicketRepository extends InteractiveConfirmationTicketRepository {
  reserve(input: ReserveInteractiveConfirmationTicketInput): Promise<boolean>
  finalize(input: FinalizeInteractiveConfirmationTicketInput): Promise<boolean>
  release(input: FinalizeInteractiveConfirmationTicketInput): Promise<boolean>
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
    ...(input.legacyNonceHash === undefined ? {} : { legacyNonceHash: digest(input.legacyNonceHash, 'INTERACTIVE_CONFIRMATION_LEGACY_NONCE_HASH_INVALID') }),
  }
}

function reservation(input: FinalizeInteractiveConfirmationTicketInput) {
  return { ...scope(input), reservationId: identifier(input.reservationId, 'INTERACTIVE_CONFIRMATION_RESERVATION_ID_INVALID', 255) }
}

function reservationExpiry(value: string, now: Date) {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error('INTERACTIVE_CONFIRMATION_RESERVATION_EXPIRES_AT_INVALID')
  if (milliseconds <= now.getTime()) throw new Error('INTERACTIVE_CONFIRMATION_RESERVATION_EXPIRED')
  if (milliseconds - now.getTime() > MAX_TICKET_TTL_MS) throw new Error('INTERACTIVE_CONFIRMATION_RESERVATION_TTL_EXCEEDED')
  return value
}

interface MemoryTicketState {
  ticket: InteractiveConfirmationTicket
  reservationId?: string
  reservationExpiresAt?: string
  consumedAt?: string
}

export class MemoryInteractiveConfirmationTicketRepository implements ReservableInteractiveConfirmationTicketRepository {
  private readonly tickets = new Map<string, MemoryTicketState>()

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async issue(input: InteractiveConfirmationTicket) {
    const bound = scope(input)
    const ticket = { ...bound, expiresAt: expiry(input.expiresAt, this.clock()) }
    if (this.tickets.has(ticket.nonceHash)) throw new Error('INTERACTIVE_CONFIRMATION_NONCE_CONFLICT')
    this.tickets.set(ticket.nonceHash, { ticket })
    return ticket
  }

  async consume(input: ConsumeInteractiveConfirmationTicketInput) {
    const ticket = scope(input)
    const stored = this.tickets.get(ticket.nonceHash)
    if (!stored || !this.matches(stored, ticket) || stored.consumedAt) return false
    const now = this.clock()
    if (Date.parse(stored.ticket.expiresAt) <= now.getTime()) return false
    if (stored.reservationId && Date.parse(stored.reservationExpiresAt!) > now.getTime()) return false
    stored.consumedAt = now.toISOString()
    return true
  }

  async reserve(input: ReserveInteractiveConfirmationTicketInput) {
    const bound = reservation(input)
    const now = this.clock()
    const leaseExpiry = reservationExpiry(input.reservationExpiresAt, now)
    const stored = this.tickets.get(bound.nonceHash)
    if (!stored || !this.matches(stored, bound) || stored.consumedAt || Date.parse(stored.ticket.expiresAt) <= now.getTime() || Date.parse(leaseExpiry) > Date.parse(stored.ticket.expiresAt)) return false
    if (stored.reservationId && stored.reservationId !== bound.reservationId && Date.parse(stored.reservationExpiresAt!) > now.getTime()) return false
    stored.reservationId = bound.reservationId
    stored.reservationExpiresAt = leaseExpiry
    return true
  }

  async finalize(input: FinalizeInteractiveConfirmationTicketInput) {
    const bound = reservation(input)
    const stored = this.tickets.get(bound.nonceHash)
    if (!stored || !this.matches(stored, bound) || stored.reservationId !== bound.reservationId) return false
    if (stored.consumedAt) return true
    const now = this.clock()
    if (Date.parse(stored.ticket.expiresAt) <= now.getTime() || Date.parse(stored.reservationExpiresAt!) <= now.getTime()) return false
    stored.consumedAt = now.toISOString()
    return true
  }

  async release(input: FinalizeInteractiveConfirmationTicketInput) {
    const bound = reservation(input)
    const stored = this.tickets.get(bound.nonceHash)
    if (!stored || !this.matches(stored, bound) || stored.consumedAt || stored.reservationId !== bound.reservationId) return false
    delete stored.reservationId
    delete stored.reservationExpiresAt
    return true
  }

  private matches(stored: MemoryTicketState, input: ConsumeInteractiveConfirmationTicketInput) {
    const ticket = stored.ticket
    return ticket.workspaceId === input.workspaceId && ticket.actorId === input.actorId && ticket.sessionId === input.sessionId && ticket.intentHash === input.intentHash
  }
}

export class PostgresInteractiveConfirmationTicketRepository implements ReservableInteractiveConfirmationTicketRepository {
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
            AND (
              (nonce_digest_version=2 AND nonce_hash=$5)
              OR (nonce_digest_version=1 AND nonce_hash IN ($5,$6))
            )
            AND consumed_at IS NULL
            AND (reservation_id IS NULL OR reservation_expires_at<=now())
            AND expires_at>now()`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.legacyNonceHash ?? ticket.nonceHash],
      )
      return result.rowCount === 1
    })
  }

  async reserve(input: ReserveInteractiveConfirmationTicketInput) {
    const ticket = reservation(input)
    const reservationExpiresAt = reservationExpiry(input.reservationExpiresAt, this.clock())
    return withWorkspaceTransaction(this.pool, ticket.workspaceId, async client => {
      const result = await client.query(
        `UPDATE interactive_confirmation_tickets
            SET reservation_id=$6,
                reserved_at=now(),
                reservation_expires_at=$7::timestamptz
          WHERE workspace_id=$1
            AND actor_id=$2
            AND session_id=$3
            AND intent_hash=$4
            AND nonce_hash=$5
            AND consumed_at IS NULL
            AND expires_at>now()
            AND $7::timestamptz>now()
            AND $7::timestamptz<=expires_at
            AND (reservation_id IS NULL OR reservation_expires_at<=now() OR reservation_id=$6)`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.reservationId, reservationExpiresAt],
      )
      return result.rowCount === 1
    })
  }

  async finalize(input: FinalizeInteractiveConfirmationTicketInput) {
    const ticket = reservation(input)
    return withWorkspaceTransaction(this.pool, ticket.workspaceId, async client => {
      const result = await client.query(
        `UPDATE interactive_confirmation_tickets
            SET consumed_at=now()
          WHERE workspace_id=$1
            AND actor_id=$2
            AND session_id=$3
            AND intent_hash=$4
            AND nonce_hash=$5
            AND reservation_id=$6
            AND reservation_expires_at>now()
            AND expires_at>now()
            AND consumed_at IS NULL`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.reservationId],
      )
      if (result.rowCount === 1) return true
      const replay = await client.query(
        `SELECT 1
           FROM interactive_confirmation_tickets
          WHERE workspace_id=$1
            AND actor_id=$2
            AND session_id=$3
            AND intent_hash=$4
            AND nonce_hash=$5
            AND reservation_id=$6
            AND consumed_at IS NOT NULL`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.reservationId],
      )
      return replay.rowCount === 1
    })
  }

  async release(input: FinalizeInteractiveConfirmationTicketInput) {
    const ticket = reservation(input)
    return withWorkspaceTransaction(this.pool, ticket.workspaceId, async client => {
      const result = await client.query(
        `UPDATE interactive_confirmation_tickets
            SET reservation_id=NULL,
                reserved_at=NULL,
                reservation_expires_at=NULL
          WHERE workspace_id=$1
            AND actor_id=$2
            AND session_id=$3
            AND intent_hash=$4
            AND nonce_hash=$5
            AND reservation_id=$6
            AND consumed_at IS NULL`,
        [ticket.workspaceId, ticket.actorId, ticket.sessionId, ticket.intentHash, ticket.nonceHash, ticket.reservationId],
      )
      return result.rowCount === 1
    })
  }
}
