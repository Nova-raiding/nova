import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { canonicalBackfillConflictQueueFailure, canonicalBackfillRunCanRetry } from '../../../packages/application/src/canonical-backfill-queue.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'
import { CanonicalBackfillConflictRevisionConflictError, type CanonicalBackfillConflictRepository } from '../../../packages/persistence/src/canonical-backfill-conflict-repository.js'
import { CanonicalBackfillRemediationError, type PostgresCanonicalBackfillRemediationRepository } from '../../../packages/persistence/src/canonical-backfill-remediation-repository.js'
import type { CanonicalBackfillRunRepository } from '../../../packages/persistence/src/canonical-backfill-run-repository.js'
import type { CanonicalBackfillResult } from '../../../packages/persistence/src/canonical-product-backfill.js'
import { aliasValue, optionalNumberValue, optionalStringValue, requiredStringValue } from './ops-params.js'

type BackfillPersistence = {
  mode: string
  canonicalBackfillRuns?: CanonicalBackfillRunRepository
  canonicalBackfillConflicts?: CanonicalBackfillConflictRepository
  canonicalBackfillRemediation?: PostgresCanonicalBackfillRemediationRepository
  executeCanonicalBackfill?: (input: { workspaceId: string; dryRun?: boolean; afterProductId?: string; limit?: number }) => Promise<CanonicalBackfillResult>
}

export interface McpCanonicalBackfillDependencies {
  persistenceReady: Promise<unknown>
  getPersistence: () => BackfillPersistence
  requireOperationsRole: (req: IncomingMessage, allowed: readonly string[]) => string
  requestActor: (req: IncomingMessage) => string
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

export async function handleMcpCanonicalBackfill(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, deps: McpCanonicalBackfillDependencies): Promise<unknown> {
  const { persistenceReady, getPersistence, requireOperationsRole, requestActor, recordOperationAudit } = deps
  switch (method) {
    case 'ops.canonical.backfill.create':
    case 'ops.canonical.backfill.get':
    case 'ops.canonical.backfill.pause':
    case 'ops.canonical.backfill.resume':
    case 'ops.canonical.backfill.run':
    case 'ops.canonical.backfill.conflicts.list':
    case 'ops.canonical.backfill.conflict.claim':
    case 'ops.canonical.backfill.conflict.resolve': {
      requireOperationsRole(req, ['platform_ops'])
      await persistenceReady
      const persistence = getPersistence()
      const repository = persistence.canonicalBackfillRuns
      if (!repository || persistence.mode !== 'postgres') throw new DomainError('CANONICAL_BACKFILL_REPOSITORY_UNAVAILABLE', 'canonical backfill 批次控制仅在 PostgreSQL 持久化模式可用', 503)
      const conflictRepository = persistence.canonicalBackfillConflicts
      const actorId = requestActor(req)
      if (method === 'ops.canonical.backfill.create') {
        const run = await repository.create({ workspaceId, dryRun: aliasValue(params, 'dryRun', 'dry_run') === true || aliasValue(params, 'dryRun', 'dry_run') === 'true', ...(optionalNumberValue(params, 'batchLimit', 'batch_limit') === undefined ? {} : { batchLimit: optionalNumberValue(params, 'batchLimit', 'batch_limit') }), createdBy: actorId, reason: requiredStringValue(params, 'reason') })
        await recordOperationAudit({ workspaceId, actorId, action: 'canonical.backfill.create', resourceType: 'canonical_backfill_run', resourceId: run.id, before: {}, after: run as unknown as Record<string, unknown>, reason: run.reason })
        return (run)
      }
      const runId = optionalStringValue(params, 'runId', 'run_id')
      if (method === 'ops.canonical.backfill.conflicts.list') {
        if (!conflictRepository) throw new DomainError('CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE', 'canonical backfill 冲突队列未配置', 503)
        return (await conflictRepository.list({ workspaceId, ...(runId ? { runId } : {}), ...(optionalStringValue(params, 'status') ? { status: optionalStringValue(params, 'status') as 'open' | 'claimed' | 'resolved' | 'dismissed' } : {}), ...(optionalNumberValue(params, 'limit') === undefined ? {} : { limit: optionalNumberValue(params, 'limit') }) }))
      }
      if (method === 'ops.canonical.backfill.conflict.claim' || method === 'ops.canonical.backfill.conflict.resolve') {
        const conflictId = requiredStringValue(params, 'conflictId', 'conflict_id')
        const expectedRevision = optionalNumberValue(params, 'expectedRevision', 'expected_revision')
        if (expectedRevision === undefined || expectedRevision < 1) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是正整数', 400)
        const action = method.endsWith('.claim') ? 'claim' : 'resolve'
        const reason = requiredStringValue(params, 'reason')
        if (!conflictRepository) throw new DomainError('CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE', 'canonical backfill 冲突队列未配置', 503)
        let conflict
        try {
          const status = requiredStringValue(params, 'status') as 'resolved' | 'dismissed'
          if (action === 'resolve' && status === 'resolved') {
            if (!persistence.canonicalBackfillRemediation) throw new DomainError('CANONICAL_BACKFILL_REMEDIATION_UNAVAILABLE', 'canonical backfill 商品事实修复未配置', 503)
            if (optionalStringValue(params, 'remediationType', 'remediation_type') !== 'set_legacy_brand') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'resolved 仅支持 set_legacy_brand 修复类型', 400)
            const expectedProductVersion = optionalNumberValue(params, 'expectedProductVersion', 'expected_product_version')
            if (expectedProductVersion === undefined || expectedProductVersion < 1) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'resolved 必须提供 expected_product_version', 400)
            conflict = await persistence.canonicalBackfillRemediation.setLegacyBrand({
              workspaceId, conflictId, expectedConflictRevision: expectedRevision, expectedProductVersion,
              brandId: requiredStringValue(params, 'brandId', 'brand_id'), actorId, reason,
              resolutionNote: requiredStringValue(params, 'resolutionNote', 'resolution_note'),
              ...(optionalStringValue(params, 'reference') ? { reference: optionalStringValue(params, 'reference') } : {}),
            })
          } else {
            conflict = action === 'claim'
            ? await conflictRepository.claim({ workspaceId, id: conflictId, expectedRevision, assigneeId: actorId })
            : await conflictRepository.resolve({ workspaceId, id: conflictId, expectedRevision, status, assigneeId: actorId, resolutionNote: requiredStringValue(params, 'resolutionNote', 'resolution_note') })
          }
        } catch (error) {
          if (error instanceof CanonicalBackfillConflictRevisionConflictError) throw new DomainError('CANONICAL_BACKFILL_CONFLICT_REVISION_CONFLICT', 'canonical backfill 冲突已被其他操作更新，请刷新后重试', 409, { conflict_id: conflictId, expected_revision: expectedRevision })
          if (error instanceof Error && error.message === 'CANONICAL_BACKFILL_CONFLICT_NOT_FOUND') throw new DomainError('CANONICAL_BACKFILL_CONFLICT_NOT_FOUND', 'canonical backfill 冲突不存在或不属于当前工作区', 404, { conflict_id: conflictId })
          if (error instanceof Error && error.message === 'CANONICAL_BACKFILL_CONFLICT_STATE_INVALID') throw new DomainError('CANONICAL_BACKFILL_CONFLICT_STATE_INVALID', 'canonical backfill 冲突当前状态不允许执行该操作', 409, { conflict_id: conflictId, expected_revision: expectedRevision })
          if (error instanceof CanonicalBackfillRemediationError) {
            const status = new Set(['CANONICAL_BACKFILL_CONFLICT_REVISION_CONFLICT', 'CANONICAL_BACKFILL_SOURCE_VERSION_CONFLICT', 'CANONICAL_BACKFILL_CONFLICT_STATE_INVALID', 'CANONICAL_BACKFILL_SOURCE_ALREADY_BRANDED']).has(error.code) ? 409 : 422
            throw new DomainError(error.code, 'canonical backfill 商品事实修复未通过安全校验', status, { conflict_id: conflictId, expected_revision: expectedRevision })
          }
          throw error
        }
        await recordOperationAudit({ workspaceId, actorId, action: `canonical.backfill.conflict.${action}`, resourceType: 'canonical_backfill_conflict', resourceId: conflict.id, before: { conflict_id: conflictId, revision: expectedRevision }, after: { ...conflict as unknown as Record<string, unknown>, audit_reason: reason, expected_revision: expectedRevision }, reason })
        return (conflict)
      }
      if (!runId) throw new DomainError('CANONICAL_BACKFILL_RUN_ID_REQUIRED', 'canonical backfill 批次 ID 必填', 400)
      const current = await repository.get({ workspaceId, id: runId })
      if (!current) throw new DomainError('CANONICAL_BACKFILL_RUN_NOT_FOUND', 'canonical backfill 批次不存在', 404)
      if (method === 'ops.canonical.backfill.get') return (current)
      if (method === 'ops.canonical.backfill.run') {
        const retryableFailure = current.status === 'failed' && canonicalBackfillRunCanRetry(current.lastResult)
        if (!['planned', 'running'].includes(current.status) && !retryableFailure) throw new DomainError('CANONICAL_BACKFILL_RUN_STATE_INVALID', `当前状态 ${current.status} 不允许执行批次`, 409, { status: current.status, next_action: current.status === 'failed' ? '人工复核冲突后重新创建批次' : null })
        const executor = persistence.executeCanonicalBackfill
        if (!executor) throw new DomainError('CANONICAL_BACKFILL_EXECUTOR_UNAVAILABLE', 'canonical backfill 执行器未配置', 503)
        const claimed = current.status === 'running' ? current : await repository.update({ id: current.id, workspaceId, expectedRevision: optionalNumberValue(params, 'expectedRevision', 'expected_revision') ?? 0, status: 'running' })
        try {
          const batch = await executor({ workspaceId, dryRun: claimed.dryRun, ...(claimed.cursorProductId ? { afterProductId: claimed.cursorProductId } : {}), ...(claimed.batchLimit ? { limit: claimed.batchLimit } : {}) })
          const conflictQueueFailure = canonicalBackfillConflictQueueFailure({ conflictCount: batch.conflicts.length, configured: Boolean(conflictRepository) })
          if (conflictQueueFailure) throw new DomainError(conflictQueueFailure.code, conflictQueueFailure.code === 'CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE' ? 'canonical backfill 发现冲突但人工队列未配置，已阻断批次执行' : 'canonical backfill 冲突数量无效，已阻断批次执行', conflictQueueFailure.status, conflictQueueFailure.details)
          if (batch.conflicts.length) await conflictRepository!.enqueue({ workspaceId, runId: claimed.id, conflicts: batch.conflicts })
          const terminal = batch.conflicts.length > 0 ? 'failed' : batch.nextProductId ? 'running' : 'completed'
          const updated = await repository.update({ id: claimed.id, workspaceId, expectedRevision: claimed.revision, status: terminal, ...(batch.nextProductId ? { cursorProductId: batch.nextProductId } : {}), lastResult: { dryRun: batch.dryRun, creates: batch.creates.length, unchanged: batch.unchanged.length, conflicts: batch.conflicts, insertedIds: batch.insertedIds } })
          await recordOperationAudit({ workspaceId, actorId, action: `canonical.backfill.${terminal}`, resourceType: 'canonical_backfill_run', resourceId: updated.id, before: claimed as unknown as Record<string, unknown>, after: updated as unknown as Record<string, unknown>, reason: terminal === 'failed' ? '批次发现需人工处理的 canonical 冲突' : '执行一个有界 canonical backfill 批次' })
          return ({ run: updated, batch })
        } catch (error) {
          const failed = await repository.update({ id: claimed.id, workspaceId, expectedRevision: claimed.revision, status: 'failed', lastResult: { error: error instanceof Error ? error.message : String(error) } }).catch(() => undefined)
          if (failed) await recordOperationAudit({ workspaceId, actorId, action: 'canonical.backfill.failed', resourceType: 'canonical_backfill_run', resourceId: failed.id, before: claimed as unknown as Record<string, unknown>, after: failed as unknown as Record<string, unknown>, reason: 'canonical backfill 批次执行异常' })
          throw error
        }
      }
      const nextStatus = method === 'ops.canonical.backfill.pause' ? 'paused' : 'running'
      const allowed = method === 'ops.canonical.backfill.pause' ? ['planned', 'running'] : ['paused']
      if (!allowed.includes(current.status)) throw new DomainError('CANONICAL_BACKFILL_RUN_STATE_INVALID', `当前状态 ${current.status} 不允许执行${nextStatus === 'paused' ? '暂停' : '继续'}`, 409, { status: current.status, next_action: current.status === 'failed' ? '人工复核冲突后重新创建批次' : null })
      const updated = await repository.update({ id: current.id, workspaceId, expectedRevision: optionalNumberValue(params, 'expectedRevision', 'expected_revision') ?? 0, status: nextStatus })
      const reason = requiredStringValue(params, 'reason')
      await recordOperationAudit({ workspaceId, actorId, action: `canonical.backfill.${nextStatus}`, resourceType: 'canonical_backfill_run', resourceId: updated.id, before: current as unknown as Record<string, unknown>, after: updated as unknown as Record<string, unknown>, reason })
      return (updated)
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知 canonical backfill MCP 方法: ${method}`, 400)
  }
}
