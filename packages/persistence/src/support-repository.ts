import { randomUUID } from 'node:crypto'
import {
  requireWorkspaceScope,
  type SqlClient,
  type SqlPool,
  withWorkspaceTransaction,
} from './repository.js'
import { createSupportSlaProjection, deriveSupportSlaState, projectSupportSlaFromEvents, type SupportSlaProjection, type SupportSlaState } from '@merchant-marketing/contracts'

export type SupportTicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed'
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent'
export type SupportTicketEventType = 'created' | 'assigned' | 'status_changed' | 'commented' | 'sla_at_risk' | 'sla_breached'

export interface SupportTicket {
  id: string
  workspaceId: string
  ticketNumber: string
  subject: string
  description: string
  status: SupportTicketStatus
  priority: SupportTicketPriority
  customerId: string
  customerName: string
  customerEmail?: string
  assignedTo?: string
  relatedOrderId?: string
  relatedTaskId?: string
  tags: string[]
  revision: number
  createdBy: string
  createdAt: string
  updatedAt: string
  sla: SupportSlaProjection
}

export interface SupportTicketEvent {
  id: string
  workspaceId: string
  ticketId: string
  sequence: number
  eventType: SupportTicketEventType
  actorId: string
  idempotencyKey: string
  payload: Readonly<Record<string, unknown>>
  createdAt: string
}

export interface SupportTicketPageCursor { createdAt: string; id: string }
export interface SupportTicketPage {
  items: SupportTicket[]
  nextCursor?: SupportTicketPageCursor
  /**
   * Set when an `slaState` filter hit the bounded scan in `list()` and the queue
   * may not have been walked to its end. `items` is then a truthful but possibly
   * partial answer: more matching tickets can exist behind `nextCursor`, which a
   * caller that follows cursors reaches without needing this flag. A caller that
   * reads a single page must treat the result as the first matches, not as all
   * of them. The flag is conservative - it can be set when the scan happened to
   * end exactly on the last row, and the follow-up call then returns an empty
   * page - but it is never set for a page that did reach the end, so it can
   * never turn a complete answer into a partial one.
   */
  scanTruncated?: boolean
}
export interface CreateSupportTicketInput {
  workspaceId: string
  subject: string
  description: string
  priority: SupportTicketPriority
  customerId: string
  customerName: string
  customerEmail?: string
  relatedOrderId?: string
  relatedTaskId?: string
  tags?: string[]
  actorId: string
  idempotencyKey: string
}

export interface SupportTicketListInput {
  workspaceId: string
  status?: SupportTicketStatus
  priority?: SupportTicketPriority
  slaState?: SupportSlaState
  assigneeId?: string
  customerId?: string
  relatedOrderId?: string
  relatedTaskId?: string
  query?: string
  cursor?: SupportTicketPageCursor
  limit?: number
}

export type SupportTicketMutationInput = {
  workspaceId: string
  ticketId: string
  expectedRevision: number
  actorId: string
  idempotencyKey: string
}

export interface SupportTicketMutationResult {
  ticket: SupportTicket
  event: SupportTicketEvent
  replayed: boolean
}

export interface SupportSlaActionInput extends SupportTicketMutationInput {
  state: 'at_risk' | 'breached'
  dueAt: string
}

export interface SupportRepository {
  create(input: CreateSupportTicketInput): Promise<SupportTicketMutationResult>
  list(input: SupportTicketListInput): Promise<SupportTicketPage>
  get(workspaceId: string, ticketId: string): Promise<SupportTicket | undefined>
  listEvents(workspaceId: string, ticketId: string): Promise<SupportTicketEvent[]>
  assign(input: SupportTicketMutationInput & { assigneeId: string }): Promise<SupportTicketMutationResult>
  transition(input: SupportTicketMutationInput & { status: SupportTicketStatus; reason: string }): Promise<SupportTicketMutationResult>
  comment(input: SupportTicketMutationInput & { body: string; visibility: 'internal' | 'customer' }): Promise<SupportTicketMutationResult>
  recordSlaAction(input: SupportSlaActionInput): Promise<SupportTicketMutationResult>
}

export class SupportTicketNotFoundError extends Error {
  readonly code = 'SUPPORT_TICKET_NOT_FOUND'
  constructor() { super('SUPPORT_TICKET_NOT_FOUND'); this.name = 'SupportTicketNotFoundError' }
}

export class SupportTicketRevisionConflictError extends Error {
  readonly code = 'SUPPORT_TICKET_REVISION_CONFLICT'
  constructor() { super('SUPPORT_TICKET_REVISION_CONFLICT'); this.name = 'SupportTicketRevisionConflictError' }
}

export class SupportTicketIdempotencyConflictError extends Error {
  readonly code = 'SUPPORT_TICKET_IDEMPOTENCY_CONFLICT'
  constructor() { super('SUPPORT_TICKET_IDEMPOTENCY_CONFLICT'); this.name = 'SupportTicketIdempotencyConflictError' }
}

const now = () => new Date().toISOString()
const cloneTicket = (ticket: SupportTicket): SupportTicket => ({ ...ticket, tags: [...ticket.tags] })
const cloneEvent = (event: SupportTicketEvent): SupportTicketEvent => ({ ...event, payload: { ...event.payload } })
// Rows scanned per statement when an SLA-state filter cannot be pushed into
// SQL and the page has to be filled from projected tickets.
const SLA_FILTER_SCAN_BATCH = 200
// Hard ceiling on that scan, in batches. The SLA state is a read-time
// projection of the event stream against the current clock, so no SQL predicate
// and no index can express it (see `list()`): a rare state such as `breached`
// on a healthy queue would otherwise cost one page read plus one batched event
// read per 200 rows, for as long as it takes to fill the page or empty the
// table - a single request could scan a 100,000-ticket workspace inside one
// transaction, on one connection, 1,003 statements deep. The ceiling keeps a
// request at 23 statements and 2,000 rows while `nextCursor` still lets a
// caller walk the whole queue, 200 rows at a time, in resumable steps.
const SLA_FILTER_SCAN_MAX_BATCHES = 10
const clampLimit = (limit = 50, max = 100) => {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('SUPPORT_PAGE_LIMIT_INVALID')
  return Math.min(max, limit)
}
const pageBefore = (ticket: SupportTicket, cursor?: SupportTicketPageCursor) => !cursor
  || ticket.createdAt < cursor.createdAt
  || (ticket.createdAt === cursor.createdAt && ticket.id < cursor.id)

function normalizedTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20)
}

function createIdentity(input: CreateSupportTicketInput) {
  return JSON.stringify({
    subject: input.subject,
    description: input.description,
    priority: input.priority,
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    relatedOrderId: input.relatedOrderId,
    relatedTaskId: input.relatedTaskId,
    tags: normalizedTags(input.tags),
  })
}

function projectTicketSla(ticket: SupportTicket, events: readonly SupportTicketEvent[], now = new Date()): SupportTicket {
  return { ...ticket, sla: projectSupportSlaFromEvents(ticket.sla, events, now) }
}

export class MemorySupportRepository implements SupportRepository {
  private readonly tickets = new Map<string, SupportTicket & { createIdempotencyKey: string; createIdentity: string }>()
  private readonly events = new Map<string, SupportTicketEvent>()
  async create(input: CreateSupportTicketInput): Promise<SupportTicketMutationResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const eventKey = `${workspaceId}:${input.idempotencyKey}`
    const replay = this.events.get(eventKey)
    if (replay) {
      const existing = this.tickets.get(`${workspaceId}:${replay.ticketId}`)
      if (!existing || replay.actorId !== input.actorId || replay.eventType !== 'created' || existing.createIdentity !== createIdentity(input)) throw new SupportTicketIdempotencyConflictError()
      return { ticket: cloneTicket(existing), event: cloneEvent(replay), replayed: true }
    }
    const timestamp = now()
    const id = randomUUID()
    const ticket: SupportTicket & { createIdempotencyKey: string; createIdentity: string } = {
      id,
      workspaceId,
      ticketNumber: `SUP-${timestamp.slice(0, 10).replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`,
      subject: input.subject,
      description: input.description,
      status: 'open',
      priority: input.priority,
      customerId: input.customerId,
      customerName: input.customerName,
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
      ...(input.relatedOrderId ? { relatedOrderId: input.relatedOrderId } : {}),
      ...(input.relatedTaskId ? { relatedTaskId: input.relatedTaskId } : {}),
      tags: normalizedTags(input.tags),
      revision: 1,
      createdBy: input.actorId,
      createdAt: timestamp,
      updatedAt: timestamp,
      sla: createSupportSlaProjection(input.priority, new Date(timestamp)),
      createIdempotencyKey: input.idempotencyKey,
      createIdentity: createIdentity(input),
    }
    const event: SupportTicketEvent = {
      id: randomUUID(), workspaceId, ticketId: id, sequence: 1, eventType: 'created', actorId: input.actorId,
      idempotencyKey: input.idempotencyKey, payload: { status: 'open', priority: input.priority }, createdAt: timestamp,
    }
    this.tickets.set(`${workspaceId}:${id}`, ticket)
    this.events.set(eventKey, event)
    return { ticket: cloneTicket(projectTicketSla(ticket, [event])), event: cloneEvent(event), replayed: false }
  }

  async list(input: SupportTicketListInput): Promise<SupportTicketPage> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const limit = clampLimit(input.limit)
    const query = input.query?.trim().toLocaleLowerCase()
    const rows = [...this.tickets.values()]
      .filter(ticket => ticket.workspaceId === workspaceId)
      .filter(ticket => !input.status || ticket.status === input.status)
      .filter(ticket => !input.priority || ticket.priority === input.priority)
      .filter(ticket => !input.slaState || deriveSupportSlaState(projectTicketSla(ticket, [...this.events.values()].filter(event => event.ticketId === ticket.id)).sla) === input.slaState)
      .filter(ticket => !input.assigneeId || ticket.assignedTo === input.assigneeId)
      .filter(ticket => !input.customerId || ticket.customerId === input.customerId)
      .filter(ticket => !input.relatedOrderId || ticket.relatedOrderId === input.relatedOrderId)
      .filter(ticket => !input.relatedTaskId || ticket.relatedTaskId === input.relatedTaskId)
      .filter(ticket => !query || [ticket.ticketNumber, ticket.subject, ticket.customerId, ticket.customerName].some(value => value.toLocaleLowerCase().includes(query)))
      .filter(ticket => pageBefore(ticket, input.cursor))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map(ticket => cloneTicket(projectTicketSla(ticket, [...this.events.values()].filter(event => event.ticketId === ticket.id)))),
      ...(rows.length > limit && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    }
  }

  async get(workspaceId: string, ticketId: string) {
    const row = this.tickets.get(`${requireWorkspaceScope(workspaceId)}:${ticketId}`)
    return row ? cloneTicket(projectTicketSla(row, [...this.events.values()].filter(event => event.ticketId === row.id))) : undefined
  }

  async listEvents(workspaceId: string, ticketId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return [...this.events.values()].filter(event => event.workspaceId === scope && event.ticketId === ticketId)
      .sort((a, b) => a.sequence - b.sequence).map(cloneEvent)
  }

  async assign(input: SupportTicketMutationInput & { assigneeId: string }) {
    return this.mutate(input, 'assigned',
      event => event.payload.to === input.assigneeId,
      ticket => ({ assignedTo: input.assigneeId, payload: { from: ticket.assignedTo ?? null, to: input.assigneeId } }))
  }

  async transition(input: SupportTicketMutationInput & { status: SupportTicketStatus; reason: string }) {
    return this.mutate(input, 'status_changed',
      event => event.payload.to === input.status && event.payload.reason === input.reason,
      ticket => ({ status: input.status, payload: { from: ticket.status, to: input.status, reason: input.reason } }))
  }

  async comment(input: SupportTicketMutationInput & { body: string; visibility: 'internal' | 'customer' }) {
    return this.mutate(input, 'commented',
      event => event.payload.body === input.body && event.payload.visibility === input.visibility,
      () => ({ payload: { body: input.body, visibility: input.visibility } }))
  }

  async recordSlaAction(input: SupportSlaActionInput) {
    return this.mutate(input, input.state === 'at_risk' ? 'sla_at_risk' : 'sla_breached',
      event => event.payload.dueAt === input.dueAt,
      () => ({ payload: { state: input.state, dueAt: input.dueAt } }))
  }

  private async mutate(
    input: SupportTicketMutationInput,
    eventType: Exclude<SupportTicketEventType, 'created'>,
    replayMatches: (event: SupportTicketEvent) => boolean,
    change: (ticket: SupportTicket) => { assignedTo?: string; status?: SupportTicketStatus; payload: Record<string, unknown> },
  ): Promise<SupportTicketMutationResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const idempotencyKey = `${workspaceId}:${input.idempotencyKey}`
    const replay = this.events.get(idempotencyKey)
    if (replay) {
      if (replay.actorId !== input.actorId || replay.ticketId !== input.ticketId || replay.eventType !== eventType || !replayMatches(replay)) throw new SupportTicketIdempotencyConflictError()
      const ticket = this.tickets.get(`${workspaceId}:${input.ticketId}`)
      if (!ticket) throw new SupportTicketNotFoundError()
      return { ticket: cloneTicket(projectTicketSla(ticket, [...this.events.values()].filter(event => event.ticketId === ticket.id))), event: cloneEvent(replay), replayed: true }
    }
    const ticket = this.tickets.get(`${workspaceId}:${input.ticketId}`)
    if (!ticket) throw new SupportTicketNotFoundError()
    if (ticket.revision !== input.expectedRevision) throw new SupportTicketRevisionConflictError()
    const delta = change(cloneTicket(ticket))
    const timestamp = now()
    ticket.revision += 1
    ticket.updatedAt = timestamp
    if (delta.assignedTo !== undefined) ticket.assignedTo = delta.assignedTo
    if (delta.status !== undefined) ticket.status = delta.status
    const event: SupportTicketEvent = {
      id: randomUUID(), workspaceId, ticketId: ticket.id, sequence: ticket.revision, eventType,
      actorId: input.actorId, idempotencyKey: input.idempotencyKey, payload: delta.payload, createdAt: timestamp,
    }
    this.events.set(idempotencyKey, event)
    return { ticket: cloneTicket(projectTicketSla(ticket, [...this.events.values()].filter(item => item.ticketId === ticket.id))), event: cloneEvent(event), replayed: false }
  }

}

type TicketRow = {
  id: string; workspace_id: string; ticket_number: string; subject: string; description: string
  status: SupportTicketStatus; priority: SupportTicketPriority; customer_id: string; customer_name: string
  customer_email: string | null; assigned_to: string | null; related_order_id: string | null; related_task_id: string | null
  tags: string[]; revision: number; created_by: string; created_at: string | Date; updated_at: string | Date
  sla_snapshot_json: SupportSlaProjection | null
}
type EventRow = {
  id: string; workspace_id: string; ticket_id: string; sequence: number; event_type: SupportTicketEventType
  actor_id: string; idempotency_key: string; payload_json: Record<string, unknown>; created_at: string | Date
}
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const mapTicket = (row: TicketRow): SupportTicket => ({
  id: row.id, workspaceId: row.workspace_id, ticketNumber: row.ticket_number, subject: row.subject,
  description: row.description, status: row.status, priority: row.priority, customerId: row.customer_id,
  customerName: row.customer_name, ...(row.customer_email ? { customerEmail: row.customer_email } : {}),
  ...(row.assigned_to ? { assignedTo: row.assigned_to } : {}),
  ...(row.related_order_id ? { relatedOrderId: row.related_order_id } : {}),
  ...(row.related_task_id ? { relatedTaskId: row.related_task_id } : {}), tags: row.tags ?? [],
  revision: row.revision, createdBy: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  sla: row.sla_snapshot_json ? { ...row.sla_snapshot_json, policy: { ...row.sla_snapshot_json.policy }, pausedMinutes: row.sla_snapshot_json.pausedMinutes ?? 0, state: deriveSupportSlaState(row.sla_snapshot_json) } : createSupportSlaProjection(row.priority, new Date(iso(row.created_at))),
})
const mapEvent = (row: EventRow): SupportTicketEvent => ({
  id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id, sequence: row.sequence,
  eventType: row.event_type, actorId: row.actor_id, idempotencyKey: row.idempotency_key,
  payload: row.payload_json, createdAt: iso(row.created_at),
})
const ticketColumns = `id, workspace_id, ticket_number, subject, description, status, priority, customer_id,
  customer_name, customer_email, assigned_to, related_order_id, related_task_id, tags, revision, created_by, created_at, updated_at, sla_snapshot_json`
const eventColumns = 'id, workspace_id, ticket_id, sequence, event_type, actor_id, idempotency_key, payload_json, created_at'

export class PostgresSupportRepository implements SupportRepository {
  constructor(private readonly pool: SqlPool) {}

  async create(input: CreateSupportTicketInput): Promise<SupportTicketMutationResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.lockIdempotencyKey(client, workspaceId, input.idempotencyKey)
      const replay = await this.findEventByIdempotency(client, workspaceId, input.idempotencyKey)
      if (replay) {
        if (replay.actorId !== input.actorId || replay.eventType !== 'created') throw new SupportTicketIdempotencyConflictError()
        const ticket = await this.getInTransaction(client, workspaceId, replay.ticketId)
        if (!ticket || createIdentity(input) !== JSON.stringify({ subject: ticket.subject, description: ticket.description, priority: ticket.priority, customerId: ticket.customerId, customerName: ticket.customerName, customerEmail: ticket.customerEmail, relatedOrderId: ticket.relatedOrderId, relatedTaskId: ticket.relatedTaskId, tags: ticket.tags })) throw new SupportTicketIdempotencyConflictError()
        return { ticket, event: replay, replayed: true }
      }
      const id = randomUUID()
      const createdAt = new Date()
      const ticketNumber = `SUP-${createdAt.toISOString().slice(0, 10).replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`
      const sla = createSupportSlaProjection(input.priority, createdAt)
      const inserted = await client.query<TicketRow>(`INSERT INTO workspace_support_tickets
        (id, workspace_id, ticket_number, subject, description, status, priority, customer_id, customer_name,
         customer_email, related_order_id, related_task_id, tags, revision, create_idempotency_key, created_by, created_at, updated_at, sla_snapshot_json)
        VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$15,$16::jsonb)
        RETURNING ${ticketColumns}`,
      [id, workspaceId, ticketNumber, input.subject, input.description, input.priority, input.customerId, input.customerName,
        input.customerEmail ?? null, input.relatedOrderId ?? null, input.relatedTaskId ?? null, normalizedTags(input.tags), input.idempotencyKey, input.actorId, createdAt.toISOString(), JSON.stringify(sla)])
      const ticket = mapTicket(inserted.rows[0]!)
      const event = await this.insertEvent(client, ticket, 'created', input.actorId, input.idempotencyKey, { status: 'open', priority: input.priority })
      return { ticket: projectTicketSla(ticket, await this.listEventsInTransaction(client, workspaceId, ticket.id)), event, replayed: false }
    })
  }

  async list(input: SupportTicketListInput): Promise<SupportTicketPage> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const limit = clampLimit(input.limit)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      // `sla.state` is a read-time projection: deriveSupportSlaState evaluates
      // the event stream against the current clock. `sla_snapshot_json` is
      // frozen at creation by migration 112 and can only ever hold 'on_track' or
      // 'at_risk', so filtering that column returned nothing for 'breached' and
      // 'met' while the very same ticket reported that state in the response
      // body. The SLA predicate is therefore applied to the projected ticket,
      // and the keyset scan continues until a full page (plus one, to detect a
      // next page) of matching rows is collected - but never further than
      // SLA_FILTER_SCAN_MAX_BATCHES, so one request stays bounded no matter how
      // rare the requested state is in the workspace.
      const slaFilter = input.slaState !== undefined
      const batch = slaFilter ? Math.max(limit + 1, SLA_FILTER_SCAN_BATCH) : limit + 1
      const maxBatches = slaFilter ? SLA_FILTER_SCAN_MAX_BATCHES : 1
      const items: SupportTicket[] = []
      // Doubles as the next batch's keyset position. It advances once per row
      // that the scan has fully accounted for, which is what makes a truncated
      // scan resumable: the cursor reports where the scan stopped, not where the
      // page ended, so the rows a bounded scan did not reach are not skipped.
      let cursor = input.cursor
      let hasMoreRows = true
      let batches = 0
      let scanTruncated = false
      while (hasMoreRows && items.length <= limit) {
        if (batches >= maxBatches) { scanTruncated = true; break }
        const rows = await this.listPageRows(client, workspaceId, input, batch, cursor)
        batches += 1
        if (!rows.length) break
        hasMoreRows = rows.length === batch
        const eventsByTicket = await this.eventsForRows(client, workspaceId, rows)
        for (const row of rows) {
          cursor = { createdAt: iso(row.created_at), id: row.id }
          const ticket = projectTicketSla(mapTicket(row), eventsByTicket.get(row.id) ?? [])
          if (input.slaState && ticket.sla.state !== input.slaState) continue
          items.push(ticket)
          if (items.length > limit) break
        }
      }
      const page = items.slice(0, limit)
      const last = page.at(-1)
      // A full page is the pre-existing contract: the cursor continues at the
      // last returned row. A truncated scan ends on a row the caller was never
      // shown, so its cursor is the scan position instead.
      const nextCursor = items.length > limit
        ? (last ? { createdAt: last.createdAt, id: last.id } : undefined)
        : (scanTruncated ? cursor : undefined)
      return { items: page, ...(nextCursor ? { nextCursor } : {}), ...(scanTruncated ? { scanTruncated: true } : {}) }
    })
  }

  /** One keyset page of ticket rows. The SLA state is deliberately absent from
   * the SQL predicate: the list() projection filter owns it, and list() bounds
   * how many of these pages it will read. */
  private async listPageRows(client: SqlClient, workspaceId: string, input: SupportTicketListInput, batch: number, cursor?: SupportTicketPageCursor): Promise<TicketRow[]> {
    const result = await client.query<TicketRow>(`SELECT ${ticketColumns} FROM workspace_support_tickets
        WHERE workspace_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::text IS NULL OR priority=$3)
          AND ($4::text IS NULL OR assigned_to=$4)
          AND ($5::text IS NULL OR customer_id=$5)
          AND ($6::text IS NULL OR related_order_id=$6)
          AND ($7::text IS NULL OR related_task_id=$7)
          AND ($8::text IS NULL OR ticket_number ILIKE '%' || $8 || '%' OR subject ILIKE '%' || $8 || '%' OR customer_id ILIKE '%' || $8 || '%' OR customer_name ILIKE '%' || $8 || '%')
          AND ($9::timestamptz IS NULL OR (created_at,id) < ($9::timestamptz,$10::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $11`, [workspaceId, input.status ?? null, input.priority ?? null,
      input.assigneeId ?? null, input.customerId ?? null, input.relatedOrderId ?? null, input.relatedTaskId ?? null,
      input.query?.trim() || null, cursor?.createdAt ?? null, cursor?.id ?? null, batch])
    return result.rows
  }

  /** One batched event read per scanned batch instead of one read per ticket:
   * the per-ticket loop cost 2 x batch statements inside a single transaction. */
  private async eventsForRows(client: SqlClient, workspaceId: string, rows: readonly TicketRow[]): Promise<Map<string, SupportTicketEvent[]>> {
    const events = await client.query<EventRow>(`SELECT ${eventColumns} FROM workspace_support_ticket_events WHERE workspace_id=$1 AND ticket_id = ANY($2::uuid[]) ORDER BY ticket_id, sequence ASC`, [workspaceId, rows.map(row => row.id)])
    const eventsByTicket = new Map<string, SupportTicketEvent[]>()
    for (const event of events.rows.map(mapEvent)) {
      const existing = eventsByTicket.get(event.ticketId)
      if (existing) existing.push(event)
      else eventsByTicket.set(event.ticketId, [event])
    }
    return eventsByTicket
  }

  async get(workspaceId: string, ticketId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, client => this.getInTransaction(client, scope, ticketId))
  }

  async listEvents(workspaceId: string, ticketId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<EventRow>(`SELECT ${eventColumns} FROM workspace_support_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY sequence ASC`, [scope, ticketId])
      return result.rows.map(mapEvent)
    })
  }

  async assign(input: SupportTicketMutationInput & { assigneeId: string }) {
    return this.mutate(input, 'assigned', { assignedTo: input.assigneeId },
      event => event.payload.to === input.assigneeId,
      ticket => ({ from: ticket.assignedTo ?? null, to: input.assigneeId }))
  }

  async transition(input: SupportTicketMutationInput & { status: SupportTicketStatus; reason: string }) {
    return this.mutate(input, 'status_changed', { status: input.status },
      event => event.payload.to === input.status && event.payload.reason === input.reason,
      ticket => ({ from: ticket.status, to: input.status, reason: input.reason }))
  }

  async comment(input: SupportTicketMutationInput & { body: string; visibility: 'internal' | 'customer' }) {
    return this.mutate(input, 'commented', {},
      event => event.payload.body === input.body && event.payload.visibility === input.visibility,
      () => ({ body: input.body, visibility: input.visibility }))
  }

  async recordSlaAction(input: SupportSlaActionInput) {
    return this.mutate(input, input.state === 'at_risk' ? 'sla_at_risk' : 'sla_breached', {},
      event => event.payload.dueAt === input.dueAt,
      () => ({ state: input.state, dueAt: input.dueAt }))
  }

  private async mutate(
    input: SupportTicketMutationInput,
    eventType: Exclude<SupportTicketEventType, 'created'>,
    patch: { assignedTo?: string; status?: SupportTicketStatus },
    replayMatches: (event: SupportTicketEvent) => boolean,
    payload: (ticket: SupportTicket) => Record<string, unknown>,
  ): Promise<SupportTicketMutationResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.lockIdempotencyKey(client, workspaceId, input.idempotencyKey)
      const replay = await this.findEventByIdempotency(client, workspaceId, input.idempotencyKey)
      if (replay) {
        if (replay.actorId !== input.actorId || replay.ticketId !== input.ticketId || replay.eventType !== eventType || !replayMatches(replay)) throw new SupportTicketIdempotencyConflictError()
        const ticket = await this.getInTransaction(client, workspaceId, input.ticketId)
        if (!ticket) throw new SupportTicketNotFoundError()
        return { ticket: projectTicketSla(ticket, await this.listEventsInTransaction(client, workspaceId, ticket.id)), event: replay, replayed: true }
      }
      const current = await this.getInTransaction(client, workspaceId, input.ticketId, true)
      if (!current) throw new SupportTicketNotFoundError()
      if (current.revision !== input.expectedRevision) throw new SupportTicketRevisionConflictError()
      const result = await client.query<TicketRow>(`UPDATE workspace_support_tickets SET
          assigned_to=COALESCE($4,assigned_to), status=COALESCE($5,status), revision=revision+1, updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING ${ticketColumns}`,
      [workspaceId, input.ticketId, input.expectedRevision, patch.assignedTo ?? null, patch.status ?? null])
      if (!result.rows[0]) throw new SupportTicketRevisionConflictError()
      const ticket = mapTicket(result.rows[0])
      const event = await this.insertEvent(client, ticket, eventType, input.actorId, input.idempotencyKey, payload(current))
      return { ticket: projectTicketSla(ticket, await this.listEventsInTransaction(client, workspaceId, ticket.id)), event, replayed: false }
    })
  }

  private async getInTransaction(client: SqlClient, workspaceId: string, ticketId: string, lock = false) {
    const result = await client.query<TicketRow>(`SELECT ${ticketColumns} FROM workspace_support_tickets WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [workspaceId, ticketId])
    return result.rows[0] ? projectTicketSla(mapTicket(result.rows[0]), await this.listEventsInTransaction(client, workspaceId, ticketId)) : undefined
  }

  private async listEventsInTransaction(client: SqlClient, workspaceId: string, ticketId: string) {
    const result = await client.query<EventRow>(`SELECT ${eventColumns} FROM workspace_support_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY sequence ASC`, [workspaceId, ticketId])
    return result.rows.map(mapEvent)
  }

  private async findEventByIdempotency(client: SqlClient, workspaceId: string, idempotencyKey: string) {
    const result = await client.query<EventRow>(`SELECT ${eventColumns} FROM workspace_support_ticket_events WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, idempotencyKey])
    return result.rows[0] ? mapEvent(result.rows[0]) : undefined
  }

  private async lockIdempotencyKey(client: SqlClient, workspaceId: string, idempotencyKey: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`support:${workspaceId}:${idempotencyKey}`])
  }

  private async insertEvent(client: SqlClient, ticket: SupportTicket, eventType: SupportTicketEventType, actorId: string, idempotencyKey: string, payload: Record<string, unknown>) {
    const result = await client.query<EventRow>(`INSERT INTO workspace_support_ticket_events
      (id, workspace_id, ticket_id, sequence, event_type, actor_id, idempotency_key, payload_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING ${eventColumns}`,
    [randomUUID(), ticket.workspaceId, ticket.id, ticket.revision, eventType, actorId, idempotencyKey, JSON.stringify(payload)])
    return mapEvent(result.rows[0]!)
  }

}
