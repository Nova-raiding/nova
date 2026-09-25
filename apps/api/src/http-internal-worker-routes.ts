import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type ApiEnvelope } from '../../../packages/contracts/src/index.js'
import type { SupportSlaMonthlyReport } from '../../../packages/contracts/src/ops/support-sla-report.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'
import { requiredStringValue } from './ops-params.js'

type JsonObject = Record<string, unknown>
type SlaScan = {
  workspaceId: string
  checked: number
  planned: number
  recorded: Array<{ ticketId: string; state: 'at_risk' | 'breached'; replayed: boolean }>
}

export interface InternalWorkerRouteDependencies {
  requireWorkerAuthorization: (req: IncomingMessage) => Promise<void>
  headerRequired: (req: IncomingMessage, name: string) => string
  body: (req: IncomingMessage) => Promise<JsonObject>
  send: <T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error?: ApiEnvelope<T>['error'], req?: IncomingMessage) => void
  runWorkspaceStorageReconciliation: (workspaceId: string) => Promise<unknown>
  runSupportSlaScan: (workspaceId: string, limit: number) => Promise<SlaScan>
  generateSupportSlaMonthlyReport: (input: { workspaceId: string; reportId: string; periodStart: string; periodEnd: string; cutoffAt: string }) => Promise<SupportSlaMonthlyReport>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

/** Worker authorization is repeated here, as in the original routes, after the server's common gate. */
export async function handleInternalWorkerRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: InternalWorkerRouteDependencies): Promise<boolean> {
  if (req.method !== 'POST') return false
  const {
    requireWorkerAuthorization, headerRequired, body, send,
    runWorkspaceStorageReconciliation, runSupportSlaScan,
    generateSupportSlaMonthlyReport, recordOperationAudit,
  } = deps

  if (path === '/v1/internal/storage/reconciliation') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const report = await runWorkspaceStorageReconciliation(workspaceId)
    send(res, 200, workspaceId, { report, read_only: true, workspace_id: workspaceId }, null, req)
    return true
  }
  if (path === '/v1/internal/support/sla-scan') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const input = await body(req)
    const limit = input.limit === undefined ? 100 : Number(input.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 至 1000 的整数', 400)
    if (input.workspace_id !== undefined && input.workspace_id !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, 'SLA 扫描工作区不匹配', 403)
    const scan = await runSupportSlaScan(workspaceId, limit)
    await recordOperationAudit({ workspaceId, actorId: 'worker:support-sla', action: 'support.sla.scan', resourceType: 'support_sla', resourceId: workspaceId, before: {}, after: scan, reason: 'reconcile worker 扫描客服 SLA 临期与违约事件' })
    send(res, 200, workspaceId, scan, null, req)
    return true
  }
  if (path === '/v1/internal/support/sla-report') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const input = await body(req)
    if (input.workspace_id !== undefined && input.workspace_id !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, 'SLA 月报工作区不匹配', 403)
    const periodStart = requiredStringValue(input, 'periodStart', 'period_start')
    const periodEnd = requiredStringValue(input, 'periodEnd', 'period_end')
    const cutoffAt = requiredStringValue(input, 'cutoffAt', 'cutoff_at')
    const reportId = requiredStringValue(input, 'reportId', 'report_id')
    const report = await generateSupportSlaMonthlyReport({ workspaceId, reportId, periodStart, periodEnd, cutoffAt })
    await recordOperationAudit({ workspaceId, actorId: 'worker:support-sla-report', action: 'support.sla.report.generate', resourceType: 'support_sla_report', resourceId: report.reportId, before: {}, after: { checksum: report.checksum, period_start: report.periodStart, period_end: report.periodEnd }, reason: 'reconcile worker 在报告 cutoff 后生成 SLA 月报' })
    send(res, 200, workspaceId, report, null, req)
    return true
  }
  return false
}
