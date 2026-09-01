export const supportTicketStatuses = [
  'open',
  'in_progress',
  'waiting_customer',
  'resolved',
  'closed',
] as const

export const supportTicketPriorities = ['low', 'normal', 'high', 'urgent'] as const
export const supportTicketEventTypes = ['created', 'assigned', 'status_changed', 'commented', 'sla_at_risk', 'sla_breached'] as const
export const supportRoles = ['support', 'platform_ops'] as const
export const supportPermissions = [
  'support.ticket.read',
  'support.ticket.create',
  'support.ticket.assign',
  'support.ticket.transition',
  'support.ticket.comment',
  'support.crm.export',
] as const

export type SupportTicketStatus = typeof supportTicketStatuses[number]
export type SupportTicketPriority = typeof supportTicketPriorities[number]
export type SupportTicketEventType = typeof supportTicketEventTypes[number]
export type SupportRole = typeof supportRoles[number]
export type SupportPermission = typeof supportPermissions[number]
export type { SupportSlaProjection, SupportSlaPolicySnapshot, SupportSlaState } from './support-sla.js'
import type { SupportSlaProjection } from './support-sla.js'

export const supportRolePermissions = {
  support: [
    'support.ticket.read',
    'support.ticket.create',
    'support.ticket.assign',
    'support.ticket.transition',
    'support.ticket.comment',
  ],
  platform_ops: supportPermissions,
} as const satisfies Readonly<Record<SupportRole, readonly SupportPermission[]>>

export interface SupportTicketContract {
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
  /** Present only on platform-scope redacted aggregate rows; never a customer ticket. */
  aggregate?: boolean
  count?: number
}

export interface SupportTicketEventContract {
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

export interface SupportTicketPageCursor {
  createdAt: string
  id: string
}

export interface SupportTicketPageContract {
  items: SupportTicketContract[]
  nextCursor?: SupportTicketPageCursor
}

export interface CreateSupportTicketCommand {
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
  idempotencyKey: string
}

export interface AssignSupportTicketCommand {
  workspaceId: string
  ticketId: string
  assigneeId: string
  expectedRevision: number
  idempotencyKey: string
}

export interface TransitionSupportTicketCommand {
  workspaceId: string
  ticketId: string
  status: SupportTicketStatus
  reason: string
  expectedRevision: number
  idempotencyKey: string
}

export interface CommentOnSupportTicketCommand {
  workspaceId: string
  ticketId: string
  body: string
  visibility: 'internal' | 'customer'
  expectedRevision: number
  idempotencyKey: string
}

export interface SupportCrmProjectionContract {
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

export interface SupportCrmExportContract {
  generatedAt: string
  workspaceId: string
  columns: readonly [
    'customer_id',
    'customer_name',
    'customer_email',
    'total_tickets',
    'open_tickets',
    'urgent_tickets',
    'last_ticket_at',
    'last_ticket_status',
  ]
  rows: SupportCrmProjectionContract[]
}

export function isSupportTicketStatus(value: unknown): value is SupportTicketStatus {
  return typeof value === 'string' && (supportTicketStatuses as readonly string[]).includes(value)
}

export function isSupportTicketPriority(value: unknown): value is SupportTicketPriority {
  return typeof value === 'string' && (supportTicketPriorities as readonly string[]).includes(value)
}
