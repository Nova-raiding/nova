import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { buildSupportSlaMonthlyReport, type SupportSlaReportTicket } from '../../../packages/contracts/src/ops/support-sla-report.js'
import type { SupportTicketPageCursor } from '../../../packages/contracts/src/ops/support.js'
import type { OperationalAlert, OperationalAlertsRepository } from '../../../packages/persistence/src/index.js'
import type { SupportSlaReportingRepository } from '../../../packages/persistence/src/support-sla-report-repository.js'
import type { SupportRepository } from '../../../packages/persistence/src/support-repository.js'
import { planSupportSlaScan } from '../../../packages/workers/src/support-sla-scan.js'

export type SupportSlaReportInput = { workspaceId: string; reportId: string; periodStart: string; periodEnd: string; cutoffAt: string }

export interface SupportSlaOperationsDependencies {
  support?: SupportRepository
  reporting: SupportSlaReportingRepository
  alerts: OperationalAlertsRepository
  notifyAlert: (alert: OperationalAlert) => Promise<void>
}

function assertWorkspaceTickets(workspaceId: string, tickets: readonly { workspaceId: string }[]) {
  if (tickets.some(ticket => ticket.workspaceId !== workspaceId)) {
    throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '客服工单读取结果超出请求工作区，已阻止 SLA 处理', 403)
  }
}

export async function runSupportSlaScan(workspaceId: string, limit: number, deps: SupportSlaOperationsDependencies) {
  const repository = deps.support
  if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置，SLA 扫描已阻断', 503)
  const tickets: Awaited<ReturnType<SupportRepository['list']>>['items'] = []
  let cursor: SupportTicketPageCursor | undefined
  do {
    const page = await repository.list({ workspaceId, limit: Math.min(100, limit), ...(cursor ? { cursor } : {}) })
    assertWorkspaceTickets(workspaceId, page.items)
    tickets.push(...page.items)
    cursor = page.nextCursor
  } while (cursor && tickets.length < limit)
  const actions = planSupportSlaScan(tickets.slice(0, limit).map(ticket => ({ workspaceId, ticketId: ticket.id, status: ticket.status, sla: ticket.sla })))
  const recorded: Array<{ ticketId: string; state: 'at_risk' | 'breached'; replayed: boolean }> = []
  for (const action of actions) {
    const ticket = tickets.find(candidate => candidate.id === action.ticketId)
    if (!ticket) continue
    const result = await repository.recordSlaAction({ workspaceId, ticketId: action.ticketId, state: action.state, dueAt: action.dueAt, expectedRevision: ticket.revision, actorId: 'worker:support-sla', idempotencyKey: action.idempotencyKey })
    recorded.push({ ticketId: action.ticketId, state: action.state, replayed: result.replayed })
    const alert = await deps.alerts.upsert({
      workspaceId,
      alertKey: `support-sla:${action.ticketId}:${action.state}:${action.dueAt}`,
      code: action.state === 'breached' ? 'SUPPORT_SLA_BREACHED' : 'SUPPORT_SLA_AT_RISK',
      severity: 'high',
      entityType: 'support_ticket',
      entityId: action.ticketId,
      title: action.state === 'breached' ? '客服工单已违反 SLA' : '客服工单即将违反 SLA',
      observedAt: new Date().toISOString(),
      evidence: { ticket_id: action.ticketId, state: action.state, due_at: action.dueAt, event_replayed: result.replayed },
      nextAction: action.state === 'breached' ? '立即检查负责人和暂停原因，补充人工处理记录并在解决后复盘。' : '立即分派客服负责人并完成有效人工响应，避免工单进入违约。',
    })
    // Alert persistence is authoritative; notification delivery is separately recorded.
    void deps.notifyAlert(alert)
  }
  return { workspaceId, checked: tickets.length, planned: actions.length, recorded }
}

export async function buildWorkspaceSupportSlaMonthlyReport(input: SupportSlaReportInput, deps: SupportSlaOperationsDependencies) {
  const support = deps.support
  if (!support) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置，SLA 月报已阻断', 503)
  const tickets: Awaited<ReturnType<SupportRepository['list']>>['items'] = []
  let cursor: SupportTicketPageCursor | undefined
  do {
    const page = await support.list({ workspaceId: input.workspaceId, limit: 100, ...(cursor ? { cursor } : {}) })
    assertWorkspaceTickets(input.workspaceId, page.items)
    tickets.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  const reportTickets: SupportSlaReportTicket[] = []
  for (const ticket of tickets) {
    const events = await support.listEvents(input.workspaceId, ticket.id)
    if (events.some(event => event.workspaceId !== input.workspaceId || event.ticketId !== ticket.id)) {
      throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '客服工单事件读取结果超出请求范围，已阻止 SLA 月报', 403)
    }
    reportTickets.push({ workspaceId: input.workspaceId, ticketId: ticket.id, sla: ticket.sla, events })
  }
  try {
    return buildSupportSlaMonthlyReport({ ...input, tickets: reportTickets })
  } catch (error) {
    if (error instanceof RangeError) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'SLA 月报的周期和截止时间必须是规范 UTC 时间且周期有效', 400)
    throw error
  }
}

export async function generateSupportSlaMonthlyReport(input: SupportSlaReportInput, deps: SupportSlaOperationsDependencies) {
  const report = await buildWorkspaceSupportSlaMonthlyReport(input, deps)
  return deps.reporting.createReport({ report })
}
