import { deriveSupportSlaState, supportSlaReportCutoffAt, type SupportSlaProjection } from '../../contracts/src/ops/support-sla.js'

export type SlaScanTicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed'

export interface SlaScanTicket {
  workspaceId: string
  ticketId: string
  status: SlaScanTicketStatus
  sla: SupportSlaProjection
}

export interface SlaScanAction {
  workspaceId: string
  ticketId: string
  state: 'at_risk' | 'breached'
  idempotencyKey: string
  dueAt: string
}

export interface SupportSlaReportSchedule {
  periodStart: string
  periodEnd: string
  cutoffAt: string
  reportId: string
}

/** Returns the previous UTC calendar month once its third business-day cutoff
 * has arrived. The report id is stable, so repeated Worker ticks are safe. */
export function planSupportSlaReportSchedule(now = new Date()): SupportSlaReportSchedule | undefined {
  const periodEndDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const periodStartDate = new Date(Date.UTC(periodEndDate.getUTCFullYear(), periodEndDate.getUTCMonth() - 1, 1))
  const periodEnd = periodEndDate.toISOString()
  const cutoffAt = supportSlaReportCutoffAt(periodEnd)
  if (now.getTime() < Date.parse(cutoffAt)) return undefined
  const periodStart = periodStartDate.toISOString()
  return { periodStart, periodEnd, cutoffAt, reportId: `support-sla:${periodStart}:${periodEnd}` }
}

/**
 * Plans only durable, business-visible SLA notifications. It never mutates a
 * ticket: the caller must append the action through its workspace transaction
 * and use idempotencyKey as the unique event key.
 */
export function planSupportSlaScan(
  tickets: readonly SlaScanTicket[],
  now = new Date(),
): SlaScanAction[] {
  const actions: SlaScanAction[] = []
  for (const ticket of tickets) {
    if (ticket.status === 'waiting_customer' || ticket.status === 'resolved' || ticket.status === 'closed') continue
    // The stored state is only a cache; the scan must evaluate deadlines at
    // scan time so a missed tick cannot hide a newly breached ticket.
    const state = deriveSupportSlaState(ticket.sla, now)
    if (state !== 'at_risk' && state !== 'breached') continue
    const dueAt = state === 'breached' ? ticket.sla.resolutionDueAt : ticket.sla.firstResponseDueAt
    if (Date.parse(dueAt) > now.getTime()) continue
    actions.push({
      workspaceId: ticket.workspaceId,
      ticketId: ticket.ticketId,
      state,
      dueAt,
      idempotencyKey: `support-sla:${ticket.ticketId}:${state}:${dueAt}`,
    })
  }
  return actions.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.ticketId.localeCompare(b.ticketId) || a.state.localeCompare(b.state))
}
