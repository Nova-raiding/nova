import type { IncomingMessage } from 'node:http'
import { DomainError, type ContentVersion, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>
type ScopedContent = { version: ContentVersion; task: Task }
type ApprovalRules = Parameters<MerchantService['approveContent']>[2]

export interface McpContentVersionDependencies {
  service: MerchantService
  required: (params: JsonObject, name: string) => string
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  scopeContentVersion: (req: IncomingMessage, contentVersionId: string) => ScopedContent
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  mcpPagination: (params: JsonObject) => { limit: number; offset: number }
  persistExpiredDeliveryIfNeeded: (workspaceId: string, contentVersionId: string) => Promise<unknown>
  verifyExportedBundle: (workspaceId: string, contentVersionId: string, binaryBody: Uint8Array) => unknown
  maxMcpExportBytes: number
  rulesForTask: (workspaceId: string, task: Task) => Promise<ApprovalRules>
  persistSnapshot: (workspaceId: string, entityType: 'content_version' | 'task', entity: ContentVersion | Task, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
}

export async function handleMcpContentVersion(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpContentVersionDependencies): Promise<unknown> {
  const { service, required, scopeTask, scopeContentVersion, assertCanonicalTaskScopeForAction, mcpPagination, persistExpiredDeliveryIfNeeded, verifyExportedBundle, maxMcpExportBytes: MAX_MCP_EXPORT_BYTES, rulesForTask, persistSnapshot, persistEvent } = deps
  switch (method) {
    case 'content.versions': {
      const task = scopeTask(req, required(params, 'task_id'))
      const page = mcpPagination(params)
      return (params.limit !== undefined || params.offset !== undefined ? service.listContentVersionsPage(workspaceId, task.id, page) : service.listContentVersions(workspaceId, task.id))
    }
    case 'content.diff': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      const against = typeof params.against_version_id === 'string' ? params.against_version_id : undefined
      return (service.diffContentVersions(workspaceId, scoped.version.id, against))
    }
    case 'content.export': {
      const contentVersionId = typeof params.content_version_id === 'string' && params.content_version_id.trim() ? params.content_version_id.trim() : undefined
      const deliverableRef = typeof params.deliverable_ref === 'string' && params.deliverable_ref.trim() ? params.deliverable_ref.trim() : undefined
      if (Boolean(contentVersionId) === Boolean(deliverableRef)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '必须且只能指定 content_version_id 或 deliverable_ref 其中一个', 400)
      const scoped = contentVersionId ? scopeContentVersion(req, contentVersionId) : (() => {
        const version = service.resolveDeliverableReference(workspaceId, deliverableRef!)
        return { version, task: service.getTask(version.taskId) }
      })()
      await assertCanonicalTaskScopeForAction(scoped.task)
      const format = typeof params.format === 'string' ? params.format : 'bundle'
      if (!['manifest', 'json', 'markdown', 'bundle'].includes(format)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 manifest、json、markdown 或 bundle', 400)
      await persistExpiredDeliveryIfNeeded(workspaceId, scoped.version.id)
      const exported = service.exportContent(workspaceId, scoped.version.id, format as 'manifest' | 'json' | 'markdown' | 'bundle')
      const exportBytes = exported.binaryBody?.byteLength ?? Buffer.byteLength(exported.body, 'utf8')
      if (!exportBytes || exportBytes > MAX_MCP_EXPORT_BYTES) throw new DomainError('CONTENT_EXPORT_SIZE_LIMIT', '内容导出文件为空或超过 25MB 限制', 413)
      if (!exported.binaryBody) return (exported)
      const { binaryBody, ...textExport } = exported
      const bundleVerification = verifyExportedBundle(workspaceId, scoped.version.id, binaryBody)
      return ({ ...textExport, binary_base64: Buffer.from(binaryBody).toString('base64'), bundle_verification: bundleVerification })
    }
    case 'content.approve': {
      const taskId = required(params, 'task_id')
      const task = scopeTask(req, taskId)
      await assertCanonicalTaskScopeForAction(task)
      const approved = service.approveContent(taskId, required(params, 'content_version_id'), await rulesForTask(workspaceId, task), typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'content_version', approved.version, approved.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', approved.task, approved.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, approved.version.id, 'content.approved', approved.version.revision, { task_id: approved.task.id, content_version_id: approved.version.id, version: approved.version.version })
      return (approved)
    }
    case 'content.modify': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      await assertCanonicalTaskScopeForAction(scoped.task)
      let lockedFields: string[] | undefined
      if (typeof params.locked_fields_json === 'string') {
        try { const parsed = JSON.parse(params.locked_fields_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('locked_fields_json must be array'); lockedFields = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'locked_fields_json 必须是字符串数组', 400) }
      }
      const expectedRevision = typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? Number(params.expected_revision) : undefined
      const modified = typeof params.module_key === 'string' && params.module_key.trim()
        ? service.regenerateContentModule({ workspaceId, sourceVersionId: scoped.version.id, moduleKey: params.module_key, ...(lockedFields ? { lockedFields } : {}), reason: required(params, 'reason'), ...(expectedRevision !== undefined ? { expectedRevision } : {}) })
        : (() => {
          let changes: Partial<import('../../../packages/application/src/service.js').ContentVersion['body']>
          try {
            const parsed = JSON.parse(required(params, 'changes_json'))
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('changes_json must be object')
            changes = parsed
          } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'changes_json 必须是 JSON 对象', 400) }
          return service.modifyContentVersion({ workspaceId, sourceVersionId: scoped.version.id, changes, ...(lockedFields ? { lockedFields } : {}), reason: required(params, 'reason'), ...(expectedRevision !== undefined ? { expectedRevision } : {}) })
        })()
      await persistSnapshot(workspaceId, 'content_version', modified.version, modified.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', modified.task, modified.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, modified.version.id, 'content.version_modified', modified.version.revision, { task_id: modified.task.id, source_version_id: modified.source.id, content_version_id: modified.version.id, reason: modified.version.versionVector?.reason, locked_fields: modified.version.lockedFields ?? [], ...(typeof params.module_key === 'string' && params.module_key.trim() ? { regenerated_module: params.module_key.trim() } : {}) })
      return (modified)
    }
    case 'content.restore': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      await assertCanonicalTaskScopeForAction(scoped.task)
      const restored = service.restoreContentVersion(workspaceId, scoped.version.id, typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'content_version', restored.version, restored.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', restored.task, restored.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, restored.version.id, 'content.version_restored', restored.version.revision, { task_id: restored.task.id, source_version_id: restored.source.id, content_version_id: restored.version.id })
      return (restored)
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知内容版本 MCP 方法: ${method}`, 400)
  }
}
