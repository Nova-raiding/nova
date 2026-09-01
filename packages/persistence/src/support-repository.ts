import { randomUUID } from 'node:crypto'
import {
  requireWorkspaceScope,
  type SqlClient,
  type SqlPool,
  withWorkspaceTransaction,
} from './repository.js'
import { createSupportSlaProjection, deriveSupportSlaState, projectSupportSlaFromEvents, type SupportSlaProjection } from '@merchant-marketing/contracts'

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
export interface SupportTicketPage { items: SupportTicket[]; nextCursor?: SupportTicketPageCursor }
export interface SupportCrmProjection {
  workspaceId: string
  customerId: string
  customerName: string
  customerEmail?: string
  totalTickets: number
  openTickets: number
  urgentTickets: number
  lastTicketAt: string
  lastTicketStatus: SupportTicketStatus
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
  assigneeId?: string
  customerId?: string
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
  listCrmProjection(workspaceId: string, limit?: number): Promise<SupportCrmProjection[]>
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
      .filter(ticket => !input.assigneeId || ticket.assignedTo === input.assigneeId)
      .filter(ticket => !input.customerId || ticket.customerId === input.customerId)
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

  async listCrmProjection(workspaceId: string, limit = 1000): Promise<SupportCrmProjection[]> {
    const scope = requireWorkspaceScope(workspaceId)
    const max = clampLimit(limit, 5000)
    const grouped = new Map<string, SupportTicket[]>()
    for (const ticket of this.tickets.values()) {
      if (ticket.workspaceId !== scope) continue
      const rows = grouped.get(ticket.customerId) ?? []
      rows.push(ticket)
      grouped.set(ticket.customerId, rows)
    }
    return [...grouped.values()].map(rows => {
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const latest = rows[0]!
      return {
        workspaceId: scope, customerId: latest.customerId, customerName: latest.customerName,
        ...(latest.customerEmail ? { customerEmail: latest.customerEmail } : {}),
        totalTickets: rows.length,
        openTickets: rows.filter(row => !['resolved', 'closed'].includes(row.status)).length,
        urgentTickets: rows.filter(row => row.priority === 'urgent').length,
        lastTicketAt: latest.createdAt, lastTicketStatus: latest.status,
      }
    }).sort((a, b) => b.lastTicketAt.localeCompare(a.lastTicketAt) || a.customerId.localeCompare(b.customerId)).slice(0, max)
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
      const result = await client.query<TicketRow>(`SELECT ${ticketColumns} FROM workspace_support_tickets
        WHERE workspace_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::text IS NULL OR priority=$3)
          AND ($4::text IS NULL OR assigned_to=$4)
          AND ($5::text IS NULL OR customer_id=$5)
          AND ($6::text IS NULL OR ticket_number ILIKE '%' || $6 || '%' OR subject ILIKE '%' || $6 || '%' OR customer_id ILIKE '%' || $6 || '%' OR customer_name ILIKE '%' || $6 || '%')
          AND ($7::timestamptz IS NULL OR (created_at,id) < ($7::timestamptz,$8::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $9`, [workspaceId, input.status ?? null, input.priority ?? null,
        input.assigneeId ?? null, input.customerId ?? null, input.query?.trim() || null, input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null, limit + 1])
      const rows = await Promise.all(result.rows.map(async row => projectTicketSla(mapTicket(row), await this.listEventsInTransaction(client, workspaceId, row.id))))
      const items = rows.slice(0, limit)
      const last = items.at(-1)
      return { items, ...(rows.length > limit && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}) }
    })
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

  async listCrmProjection(workspaceId: string, limit = 1000): Promise<SupportCrmProjection[]> {
    const scope = requireWorkspaceScope(workspaceId)
    const max = clampLimit(limit, 5000)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{
        workspace_id: string; customer_id: string; customer_name: string; customer_email: string | null
        total_tickets: number | string; open_tickets: number | string; urgent_tickets: number | string
        last_ticket_at: string | Date; last_ticket_status: SupportTicketStatus
      }>(`WITH ranked AS (
          SELECT workspace_id, customer_id, customer_name, customer_email, status, priority, created_at, id,
            ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC, id DESC) AS customer_rank,
            COUNT(*) OVER (PARTITION BY customer_id) AS total_tickets,
            COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')) OVER (PARTITION BY customer_id) AS open_tickets,
            COUNT(*) FILTER (WHERE priority='urgent') OVER (PARTITION BY customer_id) AS urgent_tickets
          FROM workspace_support_tickets
          WHERE workspace_id=$1
        )
        SELECT workspace_id, customer_id, customer_name, customer_email, total_tickets, open_tickets,
          urgent_tickets, created_at AS last_ticket_at, status AS last_ticket_status
        FROM ranked
        WHERE customer_rank=1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`, [scope, max])
      return result.rows.map(row => ({
        workspaceId: row.workspace_id, customerId: row.customer_id, customerName: row.customer_name,
        ...(row.customer_email ? { customerEmail: row.customer_email } : {}), totalTickets: Number(row.total_tickets),
        openTickets: Number(row.open_tickets), urgentTickets: Number(row.urgent_tickets),
        lastTicketAt: iso(row.last_ticket_at), lastTicketStatus: row.last_ticket_status,
      })).sort((a, b) => b.lastTicketAt.localeCompare(a.lastTicketAt) || a.customerId.localeCompare(b.customerId))
    })
  }
}
