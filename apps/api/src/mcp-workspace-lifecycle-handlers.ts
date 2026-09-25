import { DomainError } from '../../../packages/application/src/service.js'
import { WorkspaceDataExportService } from '../../../packages/application/src/workspace-data-export.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { DataDeletionScope, DataLifecycleRepository, OperationAudit } from '../../../packages/persistence/src/index.js'
import { WorkspaceDataExportIdempotencyConflictError, type WorkspaceDataExportRepository } from '../../../packages/persistence/src/workspace-data-export-repository.js'

export const WORKSPACE_LIFECYCLE_METHODS = new Set([
  'workspace.deactivate', 'workspace.activate', 'workspace.data.export.request',
  'workspace.data.export.get', 'workspace.data.delete.request',
])

type AuditInput = Omit<OperationAudit, 'id' | 'createdAt'>

export interface WorkspaceLifecycleDependencies {
  workspaceId: string
  params: Record<string, unknown>
  requireRole: (allowed: readonly string[]) => string
  required: (key: string) => string
  requiredOperationalReason: () => string
  getStatus: () => Promise<'active' | 'disabled'>
  setStatus: (status: 'active' | 'disabled') => Promise<void>
  persistEvent: (eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  nextEventSequence: () => number
  audit: (input: AuditInput) => Promise<void>
  exports: WorkspaceDataExportRepository
  deletion: DataLifecycleRepository
}

export async function handleWorkspaceLifecycleMethod(method: string, deps: WorkspaceLifecycleDependencies): Promise<unknown> {
  const { workspaceId, params } = deps
  if (method === 'workspace.deactivate') {
    const actorId = deps.requireRole(['workspace_owner'])
    const reason = deps.required('reason')
    const before = await deps.getStatus()
    if (before !== 'disabled') {
      await deps.setStatus('disabled')
      await deps.persistEvent('workspace.deactivated', deps.nextEventSequence(), { workspace_id: workspaceId, reason })
    }
    await deps.audit({ workspaceId, actorId, action: 'workspace.deactivate', resourceType: 'workspace', resourceId: workspaceId, before: { status: before }, after: { status: 'disabled', dataRetained: true }, reason })
    return { workspaceId, status: 'disabled', dataRetained: true, reason }
  }
  if (method === 'workspace.activate') {
    const actorId = deps.requireRole(['workspace_owner'])
    const reason = deps.required('reason').trim()
    const before = await deps.getStatus()
    if (before !== 'active') {
      await deps.setStatus('active')
      await deps.persistEvent('workspace.activated', deps.nextEventSequence(), { workspace_id: workspaceId, dataRetained: true, reason })
    }
    await deps.audit({ workspaceId, actorId, action: 'workspace.activate', resourceType: 'workspace', resourceId: workspaceId, before: { status: before }, after: { status: 'active', dataRetained: true }, reason })
    return { workspaceId, status: 'active', dataRetained: true, reason }
  }
  if (method === 'workspace.data.export.request') {
    const actorId = deps.requireRole(['workspace_owner', 'merchant_admin'])
    const reason = deps.requiredOperationalReason()
    const idempotencyKey = deps.required('idempotency_key')
    const exportService = new WorkspaceDataExportService(deps.exports)
    let request
    try {
      request = await exportService.request({ workspaceId, actorId, reason, idempotencyKey })
    } catch (error) {
      if (error instanceof WorkspaceDataExportIdempotencyConflictError || (error as { code?: string })?.code === 'WORKSPACE_DATA_EXPORT_IDEMPOTENCY_CONFLICT') {
        throw new DomainError('WORKSPACE_DATA_EXPORT_IDEMPOTENCY_CONFLICT', '数据导出幂等键已绑定到另一份申请，请换用新的幂等键', 409, { idempotency_key: idempotencyKey })
      }
      throw error
    }
    await deps.audit({ workspaceId, actorId, action: 'workspace.data.export.request', resourceType: 'workspace_data_export_request', resourceId: request.request_id, before: {}, after: request as unknown as Record<string, unknown>, reason })
    return request
  }
  if (method === 'workspace.data.export.get') {
    deps.requireRole(['workspace_owner', 'merchant_admin'])
    const requestId = deps.required('request_id')
    const request = await new WorkspaceDataExportService(deps.exports).get({ workspaceId, requestId })
    if (!request) throw new DomainError('WORKSPACE_DATA_EXPORT_NOT_FOUND', '数据导出申请不存在或不属于当前工作区', 404)
    return request
  }
  if (method === 'workspace.data.delete.request') {
    const actorId = deps.requireRole(['workspace_owner', 'merchant_admin'])
    const scope = deps.required('scope') as DataDeletionScope
    if (!['workspace', 'assets', 'business'].includes(scope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '删除范围无效', 400)
    const reason = deps.requiredOperationalReason()
    const gracePeriodDays = Number(process.env.DELETION_REQUEST_GRACE_DAYS ?? 7)
    if (!Number.isInteger(gracePeriodDays) || gracePeriodDays < 7 || gracePeriodDays > 30) throw new DomainError('DATA_LIFECYCLE_NOT_CONFIGURED', '生产删除宽限期未配置为 7 到 30 天', 503)
    let request
    try {
      request = await deps.deletion.request({ workspaceId, scope, reason, requestedBy: actorId, gracePeriodDays, idempotencyKey: deps.required('idempotency_key') })
    } catch (error) {
      if ((error as { code?: string })?.code === 'DATA_DELETION_IDEMPOTENCY_CONFLICT' || String(error).includes('DATA_DELETION_IDEMPOTENCY_CONFLICT')) throw new DomainError('DATA_DELETION_IDEMPOTENCY_CONFLICT', '删除幂等键已绑定到另一份申请，请换用新的幂等键', 409, { idempotency_key: deps.required('idempotency_key') })
      throw error
    }
    await deps.audit({ workspaceId, actorId, action: 'data.delete.request', resourceType: 'data_deletion_request', resourceId: request.id, before: {}, after: request as unknown as Record<string, unknown>, reason: request.reason })
    return { ...request, execution: 'pending_external_approval', message: '删除申请已登记；宽限期和双人审批完成前不会删除数据。' }
  }
  throw new Error(`Unsupported workspace lifecycle method: ${method}`)
}
