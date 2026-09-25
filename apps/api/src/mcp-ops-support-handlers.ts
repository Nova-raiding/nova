import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { createSupportSlaCorrectionRun, type SupportSlaCorrectionApproval } from '../../../packages/contracts/src/ops/support-sla-report.js'
import type { SupportTicketContract, SupportTicketPageCursor, SupportTicketPriority, SupportTicketStatus } from '../../../packages/contracts/src/ops/support.js'
import type { SupportSlaReportingRepository } from '../../../packages/persistence/src/support-sla-report-repository.js'
import type { SupportRepository } from '../../../packages/persistence/src/support-repository.js'
import { SupportService, type SupportAuthorizationContext } from './ops/support-service.js'
import { requiredStringValue, optionalStringValue, optionalNumberValue, structuredValue, stringArrayValue } from './ops-params.js'

type SlaInput = { workspaceId: string; reportId: string; periodStart: string; periodEnd: string; cutoffAt: string }
type SlaReport = Awaited<ReturnType<SupportSlaReportingRepository['getReport']>>

export const MCP_OPS_SUPPORT_METHODS = new Set([
  'ops.support.sla.report', 'ops.support.sla.correction.create', 'ops.support.sla.correction.decide',
  'ops.support.tickets.list', 'ops.support.ticket.get', 'ops.support.ticket.create',
  'ops.support.ticket.assign', 'ops.support.ticket.transition', 'ops.support.ticket.comment',
])

export interface McpOpsSupportDependencies {
  persistence: { support?: SupportRepository; supportSlaReporting?: SupportSlaReportingRepository; listWorkspaceIds?: () => Promise<string[]> }
  memorySupportSlaReporting: SupportSlaReportingRepository
  knownWorkspaces: Set<string>
  generateSupportSlaMonthlyReport: (input: SlaInput) => Promise<NonNullable<SlaReport>>
  buildWorkspaceSupportSlaMonthlyReport: (input: SlaInput) => Promise<NonNullable<SlaReport>>
  verifiedApprovalActor: (params: Record<string, unknown>, req: IncomingMessage, workspaceId: string) => string | undefined
  requestActor: (req: IncomingMessage) => string
  isPlatformOperations: (req: IncomingMessage) => boolean
  requirePlatformReadRole: (req: IncomingMessage) => unknown
  supportContext: (req: IncomingMessage, workspaceId: string) => SupportAuthorizationContext
  invokeOpsDomain: <T>(operation: () => Promise<T>) => Promise<T>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function handleMcpOpsSupport(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, deps: McpOpsSupportDependencies): Promise<unknown> {
  const { persistence, memorySupportSlaReporting, knownWorkspaces, generateSupportSlaMonthlyReport, buildWorkspaceSupportSlaMonthlyReport, verifiedApprovalActor, requestActor, isPlatformOperations, requirePlatformReadRole, supportContext, invokeOpsDomain } = deps
  switch (method) {
    case 'ops.support.sla.report': {
      const repository = persistence.support
      if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置', 503)
      const periodStart = requiredStringValue(params, 'periodStart', 'period_start')
      const periodEnd = requiredStringValue(params, 'periodEnd', 'period_end')
      const cutoffAt = requiredStringValue(params, 'cutoffAt', 'cutoff_at')
      const reportId = optionalStringValue(params, 'reportId', 'report_id') ?? `support-sla:${workspaceId}:${periodStart}:${periodEnd}`
      return (await generateSupportSlaMonthlyReport({ workspaceId, reportId, periodStart, periodEnd, cutoffAt }))
    }
    case 'ops.support.sla.correction.create': {
      const reporting = persistence.supportSlaReporting ?? memorySupportSlaReporting
      const originalReportId = requiredStringValue(params, 'originalReportId', 'original_report_id')
      const original = await reporting.getReport({ workspaceId, reportId: originalReportId })
      if (!original) throw new DomainError('SUPPORT_SLA_REPORT_NOT_FOUND', '原始 SLA 月报不存在或不属于当前工作区', 404)
      const periodStart = requiredStringValue(params, 'periodStart', 'period_start')
      const periodEnd = requiredStringValue(params, 'periodEnd', 'period_end')
      const cutoffAt = requiredStringValue(params, 'cutoffAt', 'cutoff_at')
      if (periodStart !== original.periodStart || periodEnd !== original.periodEnd || cutoffAt !== original.cutoffAt) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'correction 的报告周期必须与原始月报完全一致', 400)
      const reason = requiredStringValue(params, 'reason', 'reason')
      const idempotencyKey = requiredStringValue(params, 'idempotencyKey', 'idempotency_key')
      const corrected = await buildWorkspaceSupportSlaMonthlyReport({ workspaceId, reportId: original.reportId, periodStart, periodEnd, cutoffAt })
      const correction = createSupportSlaCorrectionRun({ original, corrected, correctionId: idempotencyKey, reason })
      if (!correction) return ({ status: 'no_change', original_report_id: original.reportId, checksum: original.checksum })
      return (await reporting.createCorrection({ correction }))
    }
    case 'ops.support.sla.correction.decide': {
      const reporting = persistence.supportSlaReporting ?? memorySupportSlaReporting
      const correctionId = requiredStringValue(params, 'correctionId', 'correction_id')
      const correction = await reporting.getCorrection({ workspaceId, correctionId })
      if (!correction) throw new DomainError('SUPPORT_SLA_CORRECTION_NOT_FOUND', 'SLA correction 不存在或不属于当前工作区', 404)
      const existing = await reporting.getCorrectionDecision({ workspaceId, correctionId })
      if (existing) return (existing)
      const decision = requiredStringValue(params, 'decision', 'decision')
      if (decision !== 'approved' && decision !== 'rejected') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'correction decision 必须是 approved 或 rejected', 400)
      const reason = requiredStringValue(params, 'reason', 'reason')
      const idempotencyKey = requiredStringValue(params, 'idempotencyKey', 'idempotency_key')
      const actorId = requestActor(req)
      const decidedAt = new Date().toISOString()
      // `actorId` above is the authenticated caller submitting this approval act
      // - the identity the two-person rule below counts, and the identity the
      // database backstop (`UNIQUE (workspace_id, correction_id, actor_id)`)
      // enforces. The approver that *authorised* the act is a different
      // identity, resolved from the server-issued `x-authorization-approval-token`
      // grant exactly as the `approval` obligation resolves it. Recording only
      // the caller left the audit trail unable to name a token holder, so the
      // resolved approver is persisted alongside it. When no token satisfied the
      // obligation the field stays absent - the caller is never copied into it,
      // because a fabricated approver is worse than a missing one.
      const approvedByActorId = verifiedApprovalActor(params, req, workspaceId)
      const approval: SupportSlaCorrectionApproval = { approvalId: idempotencyKey, correctionId, workspaceId, decision, reason, actorId, ...(approvedByActorId ? { approvedByActorId } : {}), idempotencyKey, approvedAt: decidedAt }
      await reporting.addCorrectionApproval({ approval })
      const approvals = await reporting.listCorrectionApprovals({ workspaceId, correctionId })
      if (decision === 'rejected') return (await reporting.decideCorrection({ decision: { decisionId: `final:${correctionId}:rejected`, correctionId, workspaceId, decision: 'rejected', reason, actorId, idempotencyKey: `final:${correctionId}:rejected`, decidedAt } }))
      if (approvals.length < 2) return ({ status: 'pending_approval', correctionId, workspaceId, approvals, requiredApprovals: 2 })
      if (new Set(approvals.map(item => item.actorId)).size < 2) throw new DomainError('SUPPORT_SLA_CORRECTION_INDEPENDENT_APPROVAL_REQUIRED', 'SLA correction 批准必须来自两个不同的运营身份', 409)
      return (await reporting.decideCorrection({ decision: { decisionId: `final:${correctionId}:approved`, correctionId, workspaceId, decision: 'approved', reason: '两名独立运营人员批准 correction', actorId, idempotencyKey: `final:${correctionId}:approved`, decidedAt } }))
    }
    case 'ops.support.tickets.list': {
      const repository = persistence.support
      if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置', 503)
      const cursorValue = structuredValue(params, 'cursor', 'cursor_json')
      const cursor = cursorValue === undefined ? undefined : isObject(cursorValue)
        ? { id: cursorValue.id, createdAt: cursorValue.createdAt ?? cursorValue.created_at } as SupportTicketPageCursor
        : undefined
      if (cursorValue !== undefined && !cursor) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'cursor 必须是对象', 400)
      const platformScope = optionalStringValue(params, 'platformScope', 'platform_scope')
      if (platformScope && platformScope !== 'platform') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform_scope 只能是 platform', 400)
      if (platformScope === 'platform') {
        if (!isPlatformOperations(req)) throw new DomainError(ERROR_CODES.FORBIDDEN, '平台聚合视图需要已绑定的 platform workbench', 403)
        requirePlatformReadRole(req)
        const limit = Math.min(100, Math.max(1, optionalNumberValue(params, 'limit') ?? 50))
        const workspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
        const pages = [] as SupportTicketContract[]
        for (let offset = 0; offset < workspaceIds.length; offset += 8) {
          const batch = await Promise.all(workspaceIds.slice(offset, offset + 8).map(targetWorkspaceId => new SupportService(repository).list(supportContext(req, targetWorkspaceId), {
            workspaceId: targetWorkspaceId,
            ...(optionalStringValue(params, 'status') ? { status: optionalStringValue(params, 'status') as SupportTicketStatus } : {}),
            ...(optionalStringValue(params, 'priority') ? { priority: optionalStringValue(params, 'priority') as SupportTicketPriority } : {}),
            ...(optionalStringValue(params, 'slaState', 'sla_state') ? { slaState: optionalStringValue(params, 'slaState', 'sla_state') as import('../../../packages/contracts/src/ops/support.js').SupportSlaState } : {}),
            ...(optionalStringValue(params, 'assigneeId', 'assignee_id') ? { assigneeId: optionalStringValue(params, 'assigneeId', 'assignee_id') } : {}),
            ...(optionalStringValue(params, 'customerId', 'customer_id') ? { customerId: optionalStringValue(params, 'customerId', 'customer_id') } : {}),
            ...(optionalStringValue(params, 'query') ? { query: optionalStringValue(params, 'query') } : {}),
            limit,
          })))
          for (const page of batch) pages.push(...page.items)
        }
        const groups = new Map<string, { status: SupportTicketStatus; priority: SupportTicketPriority; count: number; latestCreatedAt: string }>()
        for (const ticket of pages) {
          const key = `${ticket.status}:${ticket.priority}`
          const current = groups.get(key)
          if (current) { current.count += 1; if (ticket.createdAt > current.latestCreatedAt) current.latestCreatedAt = ticket.createdAt }
          else groups.set(key, { status: ticket.status, priority: ticket.priority, count: 1, latestCreatedAt: ticket.createdAt })
        }
        const items = [...groups.values()].sort((left, right) => right.latestCreatedAt.localeCompare(left.latestCreatedAt)).map((group, index) => ({ id: `platform-support-group-${index + 1}`, workspaceId: 'platform-aggregate', ticketNumber: `平台聚合-${index + 1}`, subject: `${group.count} 个客服工单`, description: '平台聚合视图已脱敏；切换到明确工作区授权会话查看工单详情。', status: group.status, priority: group.priority, customerId: 'redacted', customerName: '平台聚合', tags: [], revision: 0, createdBy: 'platform_aggregate', createdAt: group.latestCreatedAt, updatedAt: group.latestCreatedAt, aggregate: true, count: group.count }))
        return ({ items: items.slice(0, limit), aggregate: true, truncated: items.length > limit })
      }
      return (await invokeOpsDomain(() => new SupportService(repository).list(supportContext(req, workspaceId), {
        workspaceId,
        ...(optionalStringValue(params, 'status') ? { status: optionalStringValue(params, 'status') as SupportTicketStatus } : {}),
        ...(optionalStringValue(params, 'priority') ? { priority: optionalStringValue(params, 'priority') as SupportTicketPriority } : {}),
        ...(optionalStringValue(params, 'slaState', 'sla_state') ? { slaState: optionalStringValue(params, 'slaState', 'sla_state') as import('../../../packages/contracts/src/ops/support.js').SupportSlaState } : {}),
        ...(optionalStringValue(params, 'assigneeId', 'assignee_id') ? { assigneeId: optionalStringValue(params, 'assigneeId', 'assignee_id') } : {}),
        ...(optionalStringValue(params, 'customerId', 'customer_id') ? { customerId: optionalStringValue(params, 'customerId', 'customer_id') } : {}),
        ...(optionalStringValue(params, 'query') ? { query: optionalStringValue(params, 'query') } : {}),
        ...(cursor ? { cursor } : {}),
        ...(optionalNumberValue(params, 'limit') !== undefined ? { limit: optionalNumberValue(params, 'limit') } : {}),
      })))
    }
    case 'ops.support.ticket.get': {
      const repository = persistence.support
      if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置', 503)
      return (await invokeOpsDomain(() => new SupportService(repository).get(supportContext(req, workspaceId), workspaceId, requiredStringValue(params, 'ticketId', 'ticket_id'))))
    }
    case 'ops.support.ticket.create': {
      const repository = persistence.support
      if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置', 503)
      return (await invokeOpsDomain(() => new SupportService(repository).create(supportContext(req, workspaceId), {
        workspaceId,
        subject: requiredStringValue(params, 'subject'), description: requiredStringValue(params, 'description'),
        priority: requiredStringValue(params, 'priority') as SupportTicketPriority,
        customerId: requiredStringValue(params, 'customerId', 'customer_id'), customerName: requiredStringValue(params, 'customerName', 'customer_name'),
        ...(optionalStringValue(params, 'customerEmail', 'customer_email') ? { customerEmail: optionalStringValue(params, 'customerEmail', 'customer_email') } : {}),
        ...(optionalStringValue(params, 'relatedOrderId', 'related_order_id') ? { relatedOrderId: optionalStringValue(params, 'relatedOrderId', 'related_order_id') } : {}),
        ...(optionalStringValue(params, 'relatedTaskId', 'related_task_id') ? { relatedTaskId: optionalStringValue(params, 'relatedTaskId', 'related_task_id') } : {}),
        ...(stringArrayValue(params, 'tags', 'tags_json') ? { tags: stringArrayValue(params, 'tags', 'tags_json') } : {}),
        idempotencyKey: requiredStringValue(params, 'idempotencyKey', 'idempotency_key'),
      })))
    }
    case 'ops.support.ticket.assign':
    case 'ops.support.ticket.transition':
    case 'ops.support.ticket.comment': {
      const repository = persistence.support
      if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置', 503)
      const support = new SupportService(repository)
      const context = supportContext(req, workspaceId)
      const common = { workspaceId, ticketId: requiredStringValue(params, 'ticketId', 'ticket_id'), expectedRevision: optionalNumberValue(params, 'expectedRevision', 'expected_revision') ?? 0, idempotencyKey: requiredStringValue(params, 'idempotencyKey', 'idempotency_key') }
      if (method === 'ops.support.ticket.assign') return (await invokeOpsDomain(() => support.assign(context, { ...common, assigneeId: requiredStringValue(params, 'assigneeId', 'assignee_id') })))
      if (method === 'ops.support.ticket.transition') return (await invokeOpsDomain(() => support.transition(context, { ...common, status: requiredStringValue(params, 'status') as SupportTicketStatus, reason: requiredStringValue(params, 'reason') })))
      return (await invokeOpsDomain(() => support.comment(context, { ...common, body: requiredStringValue(params, 'body'), visibility: requiredStringValue(params, 'visibility') as 'internal' | 'customer' })))
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知客服 MCP 方法: ${method}`, 400)
  }
}
