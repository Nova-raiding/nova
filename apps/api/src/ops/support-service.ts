import type {
  AssignSupportTicketCommand,
  CommentOnSupportTicketCommand,
  CreateSupportTicketCommand,
  SupportCrmExportContract,
  SupportPermission,
  SupportRole,
  SupportTicketPageCursor,
  SupportTicketPriority,
  SupportTicketStatus,
  TransitionSupportTicketCommand,
} from '../../../../packages/contracts/src/ops/support.js'
import { supportRolePermissions } from '../../../../packages/contracts/src/ops/support.js'
import {
  SupportTicketNotFoundError,
  type SupportRepository,
  type SupportTicketListInput,
} from '../../../../packages/persistence/src/support-repository.js'
/**
 * The shared HTTP/MCP adapter must construct this from a verified session.
 * The service never reads headers and never accepts an unbound target tenant.
 */
export interface SupportAuthorizationContext {
  actorId: string
  role: SupportRole
  workspaceId: string
  permissions: readonly SupportPermission[]
}

export class SupportAuthorizationError extends Error {
  readonly code = 'SUPPORT_FORBIDDEN'
  constructor() { super('SUPPORT_FORBIDDEN'); this.name = 'SupportAuthorizationError' }
}

export class SupportValidationError extends Error {
  readonly code = 'SUPPORT_VALIDATION_FAILED'
  constructor(readonly field: string, message: string) { super(message); this.name = 'SupportValidationError' }
}

const transitions: Readonly<Record<SupportTicketStatus, readonly SupportTicketStatus[]>> = {
  open: ['in_progress', 'closed'],
  in_progress: ['open', 'waiting_customer', 'resolved'],
  waiting_customer: ['in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: ['in_progress'],
}

const priorities = new Set<SupportTicketPriority>(['low', 'normal', 'high', 'urgent'])
const statuses = new Set<SupportTicketStatus>(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'])

function required(value: string, field: string, max: number, min = 1): string {
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new SupportValidationError(field, `${field} length must be between ${min} and ${max}`)
  return normalized
}

function optional(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return required(value, field, max)
}

function idempotencyKey(value: string): string {
  return required(value, 'idempotencyKey', 256, 8)
}

function expectedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new SupportValidationError('expectedRevision', 'expectedRevision must be a positive integer')
  return value
}

function assertAccess(context: SupportAuthorizationContext, workspaceId: string, permission: SupportPermission) {
  const allowedByRole = (supportRolePermissions[context.role] as readonly SupportPermission[]).includes(permission)
  if (!allowedByRole || !context.actorId.trim() || !context.workspaceId.trim() || context.workspaceId !== workspaceId || !context.permissions.includes(permission)) throw new SupportAuthorizationError()
}

function pageCursor(cursor: SupportTicketPageCursor | undefined): SupportTicketPageCursor | undefined {
  if (!cursor) return undefined
  if (!isUuid(cursor.id) || Number.isNaN(Date.parse(cursor.createdAt))) throw new SupportValidationError('cursor', 'cursor is invalid')
  return { id: cursor.id.toLowerCase(), createdAt: new Date(cursor.createdAt).toISOString() }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string): boolean => uuidPattern.test(value.trim())

function parseTicketId(value: string): string {
  const normalized = required(value, 'ticketId', 36)
  if (!isUuid(normalized)) throw new SupportValidationError('ticketId', 'ticketId must be a UUID')
  return normalized.toLowerCase()
}

function normalizedTags(tags: readonly string[] | undefined): string[] {
  const result = [...new Set((tags ?? []).map(tag => tag.trim().toLowerCase()).filter(Boolean))]
  if (result.length > 20 || result.some(tag => tag.length > 40)) throw new SupportValidationError('tags', 'tags must contain at most 20 values of 40 characters')
  return result
}

function customerEmail(value: string | undefined): string | undefined {
  const email = optional(value, 'customerEmail', 320)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SupportValidationError('customerEmail', 'customerEmail is invalid')
  return email?.toLowerCase()
}

export class SupportService {
  constructor(private readonly repository: SupportRepository, private readonly clock: () => Date = () => new Date()) {}

  async create(context: SupportAuthorizationContext, command: CreateSupportTicketCommand) {
    assertAccess(context, command.workspaceId, 'support.ticket.create')
    if (!priorities.has(command.priority)) throw new SupportValidationError('priority', 'priority is invalid')
    const email = customerEmail(command.customerEmail)
    const relatedOrderId = optional(command.relatedOrderId, 'relatedOrderId', 256)
    const relatedTaskId = optional(command.relatedTaskId, 'relatedTaskId', 256)
    return this.repository.create({
      workspaceId: command.workspaceId,
      subject: required(command.subject, 'subject', 200, 3),
      description: required(command.description, 'description', 10_000),
      priority: command.priority,
      customerId: required(command.customerId, 'customerId', 256),
      customerName: required(command.customerName, 'customerName', 200),
      ...(email ? { customerEmail: email } : {}),
      ...(relatedOrderId ? { relatedOrderId } : {}),
      ...(relatedTaskId ? { relatedTaskId } : {}),
      tags: normalizedTags(command.tags),
      actorId: context.actorId,
      idempotencyKey: idempotencyKey(command.idempotencyKey),
    })
  }

  async list(context: SupportAuthorizationContext, input: Omit<SupportTicketListInput, 'workspaceId'> & { workspaceId: string }) {
    assertAccess(context, input.workspaceId, 'support.ticket.read')
    if (input.status && !statuses.has(input.status)) throw new SupportValidationError('status', 'status is invalid')
    if (input.priority && !priorities.has(input.priority)) throw new SupportValidationError('priority', 'priority is invalid')
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new SupportValidationError('limit', 'limit must be between 1 and 100')
    const cursor = pageCursor(input.cursor)
    const assigneeId = optional(input.assigneeId, 'assigneeId', 256)
    const customerId = optional(input.customerId, 'customerId', 256)
    const query = optional(input.query, 'query', 200)
    return this.repository.list({
      workspaceId: input.workspaceId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
  }

  async get(context: SupportAuthorizationContext, workspaceId: string, ticketId: string) {
    assertAccess(context, workspaceId, 'support.ticket.read')
    const id = parseTicketId(ticketId)
    const ticket = await this.repository.get(workspaceId, id)
    if (!ticket) throw new SupportTicketNotFoundError()
    return { ticket, events: await this.repository.listEvents(workspaceId, id) }
  }

  async assign(context: SupportAuthorizationContext, command: AssignSupportTicketCommand) {
    assertAccess(context, command.workspaceId, 'support.ticket.assign')
    return this.repository.assign({
      workspaceId: command.workspaceId,
      ticketId: parseTicketId(command.ticketId),
      assigneeId: required(command.assigneeId, 'assigneeId', 256),
      expectedRevision: expectedRevision(command.expectedRevision),
      actorId: context.actorId,
      idempotencyKey: idempotencyKey(command.idempotencyKey),
    })
  }

  async transition(context: SupportAuthorizationContext, command: TransitionSupportTicketCommand) {
    assertAccess(context, command.workspaceId, 'support.ticket.transition')
    if (!statuses.has(command.status)) throw new SupportValidationError('status', 'status is invalid')
    const id = parseTicketId(command.ticketId)
    const current = await this.repository.get(command.workspaceId, id)
    if (!current) return this.repository.transition({
      workspaceId: command.workspaceId, ticketId: id, status: command.status, reason: required(command.reason, 'reason', 1000, 3),
      expectedRevision: expectedRevision(command.expectedRevision), actorId: context.actorId, idempotencyKey: idempotencyKey(command.idempotencyKey),
    })
    // A retried request carries the previous expected revision. Let the
    // repository inspect its idempotency event before treating it as stale.
    if (current.revision === command.expectedRevision && !transitions[current.status].includes(command.status)) throw new SupportValidationError('status', `transition ${current.status} -> ${command.status} is not allowed`)
    return this.repository.transition({
      workspaceId: command.workspaceId,
      ticketId: id,
      status: command.status,
      reason: required(command.reason, 'reason', 1000, 3),
      expectedRevision: expectedRevision(command.expectedRevision),
      actorId: context.actorId,
      idempotencyKey: idempotencyKey(command.idempotencyKey),
    })
  }

  async comment(context: SupportAuthorizationContext, command: CommentOnSupportTicketCommand) {
    assertAccess(context, command.workspaceId, 'support.ticket.comment')
    if (command.visibility !== 'internal' && command.visibility !== 'customer') throw new SupportValidationError('visibility', 'visibility is invalid')
    return this.repository.comment({
      workspaceId: command.workspaceId,
      ticketId: parseTicketId(command.ticketId),
      body: required(command.body, 'body', 10_000),
      visibility: command.visibility,
      expectedRevision: expectedRevision(command.expectedRevision),
      actorId: context.actorId,
      idempotencyKey: idempotencyKey(command.idempotencyKey),
    })
  }

  async exportCrm(context: SupportAuthorizationContext, workspaceId: string, limit = 5000): Promise<SupportCrmExportContract> {
    assertAccess(context, workspaceId, 'support.crm.export')
    if (context.role !== 'platform_ops') throw new SupportAuthorizationError()
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new SupportValidationError('limit', 'limit must be between 1 and 5000')
    return {
      generatedAt: this.clock().toISOString(),
      workspaceId,
      columns: ['customer_id', 'customer_name', 'customer_email', 'total_tickets', 'open_tickets', 'urgent_tickets', 'last_ticket_at', 'last_ticket_status'],
      rows: await this.repository.listCrmProjection(workspaceId, limit),
    }
  }
}

export type { SupportTicketPageCursor }
export type { SupportPermission, SupportRole }
