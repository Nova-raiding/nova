import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'

type Params = Record<string, unknown>
export type ManualPublishMethod = 'ops.marketing.publish.manual-evidence.record' | 'publish.manual.get' | 'publish.manual.list'
export interface ManualPublishMcpDependencies {
  req: IncomingMessage
  workspaceId: string
  params: Params
  result: (value: unknown) => void
  required: (params: Params, key: string) => string
  requireOperationsRole: (req: IncomingMessage, allowed: readonly string[]) => string
  service: Pick<MerchantService, 'recordManualPublish' | 'listManualPublishRecords' | 'getTask'>
  persistSnapshot: (workspaceId: string, entityType: 'manual_publish_record', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  enforceTaskBrandAccess: (req: IncomingMessage, task: { workspaceId: string; brandId?: string }, minimumRole: 'viewer') => Promise<unknown>
  mcpPagination: (params: Params) => { limit: number; offset: number }
}

export async function handleManualPublishMcpMethod(method: ManualPublishMethod, deps: ManualPublishMcpDependencies): Promise<void> {
  const { req, workspaceId, params, result, required, requireOperationsRole, service, persistSnapshot, recordOperationAudit, enforceTaskBrandAccess, mcpPagination } = deps
  switch (method) {
    case 'ops.marketing.publish.manual-evidence.record': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      const targetWorkspaceId = required(params, 'target_workspace_id')
      let evidenceAssetIds: string[]
      let differences: unknown[]
      try {
        const parsed = JSON.parse(required(params, 'evidence_refs_json'))
        if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid evidence refs')
        evidenceAssetIds = [...new Set(parsed.map(value => value.trim()))]
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'evidence_refs_json 必须是字符串数组', 400) }
      try {
        const parsed = typeof params.differences_json === 'string' ? JSON.parse(params.differences_json) : []
        if (!Array.isArray(parsed)) throw new Error('invalid differences')
        differences = parsed
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'differences_json 必须是数组', 400) }
      const expectedRevision = Number(required(params, 'expected_revision'))
      if (expectedRevision !== 1) throw new DomainError('MANUAL_PUBLISH_REVISION_CONFLICT', '人工发布记录版本已变化，请刷新后重试', 409)
      const state = required(params, 'status') as import('../../../packages/application/src/service.js').ManualPublishState
      if (!['manual_publish_in_progress', 'manual_publish_reported', 'manual_review_required'].includes(state)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '人工发布状态无效', 400)
      const record = service.recordManualPublish({
        workspaceId: targetWorkspaceId,
        taskId: required(params, 'task_id'),
        contentVersionId: required(params, 'content_version_id'),
        platform: required(params, 'platform') as Platform,
        accountId: required(params, 'account_id'),
        deliveryBundleHash: required(params, 'delivery_bundle_hash'),
        state,
        actorId,
        publisherId: actorId,
        operatedAt: required(params, 'occurred_at'),
        ...(typeof params.reviewer_id === 'string' && params.reviewer_id.trim() ? { reviewerId: params.reviewer_id.trim(), reviewedAt: new Date().toISOString() } : {}),
        ...(typeof params.remote_content_id === 'string' ? { platformContentId: params.remote_content_id } : {}),
        ...(typeof params.public_url === 'string' ? { publicUrl: params.public_url } : {}),
        ...(typeof params.platform_display_status === 'string' ? { platformDisplayStatus: params.platform_display_status } : {}),
        evidenceAssetIds,
        ...(differences.length ? { differenceNote: JSON.stringify(differences) } : state === 'manual_review_required' ? { differenceNote: required(params, 'reason') } : {}),
        idempotencyKey: required(params, 'idempotency_key'),
      })
      await persistSnapshot(targetWorkspaceId, 'manual_publish_record', record, record as unknown as Record<string, unknown>)
      await recordOperationAudit({ workspaceId: targetWorkspaceId, actorId, action: 'ops.marketing.publish.manual-evidence.record', resourceType: 'manual_publish_record', resourceId: record.id, before: {}, after: record as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result(record)
    }
    case 'publish.manual.get': {
      const recordId = required(params, 'manual_publish_report_id')
      const record = service.listManualPublishRecords(workspaceId).find(item => item.id === recordId)
      if (!record) throw new DomainError('MANUAL_PUBLISH_RECORD_NOT_FOUND', '人工发布记录不存在', 404)
      await enforceTaskBrandAccess(req, service.getTask(record.taskId), 'viewer')
      return result(record)
    }
    case 'publish.manual.list': {
      const taskId = typeof params.task_id === 'string' && params.task_id.trim() ? params.task_id.trim() : undefined
      const contentVersionId = typeof params.content_version_id === 'string' && params.content_version_id.trim() ? params.content_version_id.trim() : undefined
      const { limit, offset } = mcpPagination(params)
      const visible: import('../../../packages/application/src/service.js').ManualPublishRecord[] = []
      for (const record of service.listManualPublishRecords(workspaceId, { ...(taskId ? { taskId } : {}), ...(contentVersionId ? { contentVersionId } : {}) })) {
        try {
          await enforceTaskBrandAccess(req, service.getTask(record.taskId), 'viewer')
          visible.push(record)
        } catch (error) {
          if (error instanceof DomainError) continue
          throw error
        }
      }
      return result({ items: visible.slice(offset, offset + limit), total: visible.length, limit, offset })
    }
    default: return
  }
}
