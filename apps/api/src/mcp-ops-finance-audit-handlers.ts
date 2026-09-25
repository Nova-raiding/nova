import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { AuditCenterRepository } from '../../../packages/persistence/src/index.js'
import type { FinanceSearchRepository } from '../../../packages/persistence/src/finance-search-repository.js'
import type { FinanceRecordKind, FinanceSearchQuery } from '../../../packages/contracts/src/ops/finance-search.js'
import type { AuditSource } from '../../../packages/contracts/src/ops/audit-center.js'
import { FinanceSearchService } from './ops/finance-search-service.js'
import { AuditCenterService } from './ops/audit-center-service.js'
import { optionalNumberValue, optionalStringValue, requiredStringValue, stringArrayValue } from './ops-params.js'

export const MCP_OPS_FINANCE_AUDIT_METHODS = new Set([
  'ops.finance.search', 'ops.finance.detail', 'ops.finance.export',
  'ops.audit.platform.list', 'ops.audit.list', 'ops.audit.export', 'ops.audit.detail',
])

type FinancePrincipal = Parameters<FinanceSearchService['search']>[0]
type AuditPrincipal = Parameters<AuditCenterService['list']>[0]

export interface McpOpsFinanceAuditDependencies {
  financeSearch?: FinanceSearchRepository
  auditCenter?: AuditCenterRepository
  listWorkspaceIds?: () => Promise<string[]>
  financePrincipal: (req: IncomingMessage) => FinancePrincipal
  auditCenterPrincipal: (req: IncomingMessage, workspaceId: string) => AuditPrincipal
  requirePlatformReadRole: (req: IncomingMessage) => unknown
  invokeOpsDomain: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Returns the unwrapped MCP value; the caller retains transport-specific response handling. */
export async function handleMcpOpsFinanceAuditMethod(
  method: string,
  params: Record<string, unknown>,
  req: IncomingMessage,
  workspaceId: string,
  dependencies: McpOpsFinanceAuditDependencies,
): Promise<unknown> {
  const { invokeOpsDomain } = dependencies
  if (method === 'ops.finance.search' || method === 'ops.finance.detail' || method === 'ops.finance.export') {
    const repository = dependencies.financeSearch
    if (!repository) throw new DomainError('FINANCE_SEARCH_REPOSITORY_UNAVAILABLE', '跨租户财务检索仅在 PostgreSQL 持久化模式可用', 503)
    const finance = new FinanceSearchService(repository)
    const principal = dependencies.financePrincipal(req)
    if (method === 'ops.finance.detail') return invokeOpsDomain(() => finance.detail(principal, {
      workspaceId: requiredStringValue(params, 'workspaceId', 'target_workspace_id'),
      kind: requiredStringValue(params, 'kind') as FinanceRecordKind,
      id: requiredStringValue(params, 'recordId', 'record_id'),
      ...(optionalStringValue(params, 'expectedVersion', 'expected_version') ? { expectedVersion: optionalStringValue(params, 'expectedVersion', 'expected_version') } : {}),
      ...(optionalStringValue(params, 'snapshotAt', 'snapshot_at') ? { snapshotAt: optionalStringValue(params, 'snapshotAt', 'snapshot_at') } : {}),
    }))
    const query: Partial<FinanceSearchQuery> & { limit?: number } = {
      ...(stringArrayValue(params, 'workspaceIds', 'workspace_ids_json') ? { workspaceIds: stringArrayValue(params, 'workspaceIds', 'workspace_ids_json') } : {}),
      ...(stringArrayValue(params, 'kinds', 'kinds_json') ? { kinds: stringArrayValue(params, 'kinds', 'kinds_json') as FinanceRecordKind[] } : {}),
      ...(stringArrayValue(params, 'statuses', 'statuses_json') ? { statuses: stringArrayValue(params, 'statuses', 'statuses_json') } : {}),
      ...(optionalStringValue(params, 'text') ? { text: optionalStringValue(params, 'text') } : {}),
      ...(optionalStringValue(params, 'fromAt', 'from_at') ? { fromAt: optionalStringValue(params, 'fromAt', 'from_at') } : {}),
      ...(optionalStringValue(params, 'toAt', 'to_at') ? { toAt: optionalStringValue(params, 'toAt', 'to_at') } : {}),
      ...(optionalStringValue(params, 'cursor') ? { cursor: optionalStringValue(params, 'cursor') } : {}),
      ...(optionalStringValue(params, 'snapshotAt', 'snapshot_at') ? { snapshotAt: optionalStringValue(params, 'snapshotAt', 'snapshot_at') } : {}),
      limit: optionalNumberValue(params, 'limit') ?? 50,
    }
    return method === 'ops.finance.search'
      ? invokeOpsDomain(() => finance.search(principal, query))
      : invokeOpsDomain(() => finance.exportCsv(principal, query))
  }
  if (method === 'ops.audit.platform.list') {
    const repository = dependencies.auditCenter
    if (!repository || !dependencies.listWorkspaceIds) throw new DomainError('AUDIT_CENTER_REPOSITORY_UNAVAILABLE', '平台审计聚合需要审计和工作区目录仓储', 503)
    dependencies.requirePlatformReadRole(req)
    const platformAudit = new AuditCenterService(repository)
    const workspaceIds = await dependencies.listWorkspaceIds()
    return invokeOpsDomain(() => platformAudit.listPlatform(dependencies.auditCenterPrincipal(req, workspaceId), params, workspaceIds))
  }
  if (method === 'ops.audit.list' || method === 'ops.audit.export') {
    const repository = dependencies.auditCenter
    if (!repository) throw new DomainError('AUDIT_CENTER_REPOSITORY_UNAVAILABLE', '审计中心仓储未配置', 503)
    const service = new AuditCenterService(repository)
    const sources = stringArrayValue(params, 'sources', 'sources_json')
    const query = {
      workspaceId,
      ...(optionalStringValue(params, 'text') ? { text: optionalStringValue(params, 'text') } : {}),
      ...(sources ? { sources: sources as AuditSource[] } : {}),
      ...(optionalStringValue(params, 'actorId', 'actor_id') ? { actorId: optionalStringValue(params, 'actorId', 'actor_id') } : {}),
      ...(optionalStringValue(params, 'action') ? { action: optionalStringValue(params, 'action') } : {}),
      ...(optionalStringValue(params, 'resourceType', 'resource_type') ? { resourceType: optionalStringValue(params, 'resourceType', 'resource_type') } : {}),
      ...(optionalStringValue(params, 'fromAt', 'from_at') ? { fromAt: optionalStringValue(params, 'fromAt', 'from_at') } : {}),
      ...(optionalStringValue(params, 'toAt', 'to_at') ? { toAt: optionalStringValue(params, 'toAt', 'to_at') } : {}),
      ...(optionalStringValue(params, 'cursor') ? { cursor: optionalStringValue(params, 'cursor') } : {}),
      limit: optionalNumberValue(params, 'limit') ?? 50,
    }
    const principal = dependencies.auditCenterPrincipal(req, workspaceId)
    return method === 'ops.audit.list'
      ? invokeOpsDomain(() => service.list(principal, query))
      : invokeOpsDomain(() => service.exportCsv(principal, query))
  }
  if (method === 'ops.audit.detail') {
    const repository = dependencies.auditCenter
    if (!repository) throw new DomainError('AUDIT_CENTER_REPOSITORY_UNAVAILABLE', '审计中心仓储未配置', 503)
    const service = new AuditCenterService(repository)
    return invokeOpsDomain(() => service.detail(dependencies.auditCenterPrincipal(req, workspaceId), {
      workspaceId,
      source: requiredStringValue(params, 'source') as AuditSource,
      id: requiredStringValue(params, 'id', 'event_id'),
    }))
  }
  throw new Error(`Unsupported finance or audit MCP method: ${method}`)
}
