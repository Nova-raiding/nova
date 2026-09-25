import { randomUUID } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { runFencedSinglePublish, PublishCommitStatusUnknownError } from './publish-fenced-orchestrator.js'
import type { TransactionalInteractiveConfirmationTicketRepository } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'
import type { PublishBatch, PublishMcpContext } from './server.js'

export type PublishMcpMethod = 'publish.prepare' | 'publish.batch.prepare' | 'publish.batch.confirm' | 'publish.batch.get' | 'publish.batch.pause' | 'publish.batch.resume' | 'publish.batch.retry_failed' | 'publish.confirm' | 'publish.get'

export async function handlePublishMcpMethod(method: PublishMcpMethod, context: PublishMcpContext): Promise<void> {
  const { req, workspaceId, params, result, required, scopeTask, assertCanonicalTaskScopeForAction,
    requireEnabledPlatform, requireCurrentPlatformMapping, isProduction, fixtureMode,
    requireCurrentPublishReview, service, persistSnapshotsAndEvent, enforceTaskBrandAccess,
    persistSnapshot, persistEvent, publishBatches, persistedPublishBatches,
    assertUniqueBatchTaskIds, resolveTaskPublishAccount, assertPublishIdempotency,
    hydrateDurableIdempotentJob, publishAuthorizationSnapshot,
    requirePublishAuthorizationSnapshot, consumePublishConfirmationTicket,
    reservePublishConfirmationTicket, reserveDistributedJobSlot, releaseDistributedJobSlot,
    connectorRuntime, persistPublishJobWithBatch, scheduleFixturePublishObservation,
    jobWithQueueMetadata, batchStateFromItems, savePublishBatch, refreshPublishBatch,
    requireOperationsRole, recordOperationAudit, header, platformWriteReady,
    persistence, withCommercialWorkerSnapshot, publishEventPayload,
    projectPublishWorkflow } = context
  switch (method) {
    case 'publish.prepare': {
      const taskId = required(params, 'task_id')
      const task = scopeTask(req, taskId)
      const canonicalProof = await assertCanonicalTaskScopeForAction(task)
      await requireEnabledPlatform(workspaceId, task.platform)
      const mappingPreflight = await requireCurrentPlatformMapping(task)
      if ((isProduction() || fixtureMode) && !task.accountId) throw new DomainError('STORE_SELECTION_REQUIRED', '发布前必须明确选择商品所属店铺', 409)
      const currentRuleReview = await requireCurrentPublishReview(workspaceId, task)
      const taskBeforePrepare = structuredClone(task)
      const preview = service.preparePublish(taskId)
      if (canonicalProof?.canonicalReadRevision && preview.task.pendingPublish) preview.task.pendingPublish.canonicalReadRevision = canonicalProof.canonicalReadRevision
      try {
        await persistSnapshotsAndEvent({ workspaceId, snapshots: [{ entityType: 'task', entityId: preview.task.id, entityVersion: preview.task.version, payload: preview.task as unknown as Record<string, unknown> }], aggregateId: preview.task.id, eventType: 'publish.prepared', sequence: preview.task.version, eventPayload: { task_id: preview.task.id, content_version_id: preview.version.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, payload_hash: preview.payloadHash, selection_hash: preview.selectionHash, selected_count: preview.visualPreview.count, image_mode: preview.visualPreview.imageMode } })
      } catch (error) {
        service.tasks.set(task.id, taskBeforePrepare)
        throw error
      }
      return result({ ...preview, currentRuleReview, ...(mappingPreflight ? { mappingPreflight: { publishable: true, confirmationValid: true, mappedPayloadHash: mappingPreflight.mappedPayloadHash } } : {}) })
    }
    case 'publish.batch.prepare': {
      const rawTaskIds = required(params, 'task_ids_json')
      let taskIds: string[]
      try {
        const parsed = JSON.parse(rawTaskIds)
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => typeof item !== 'string' || !item.trim()) || new Set(parsed).size !== parsed.length) throw new Error('invalid')
        taskIds = parsed.map(item => String(item).trim())
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'task_ids_json 必须是 1 至 50 个不重复任务 ID 的 JSON 数组', 400) }
      const taskRefs: Array<{ task: ReturnType<typeof service.getTask>; before: ReturnType<typeof structuredClone> }> = []
      const batchId = 'batch_' + randomUUID()
      for (const taskId of taskIds) {
        const task = scopeTask(req, taskId)
        await enforceTaskBrandAccess(req, task, 'publisher')
        await assertCanonicalTaskScopeForAction(task)
        await requireEnabledPlatform(workspaceId, task.platform)
        await requireCurrentPlatformMapping(task)
        if ((isProduction() || fixtureMode) && !task.accountId) throw new DomainError('STORE_SELECTION_REQUIRED', `任务 ${taskId} 未绑定店铺`, 409)
        await requireCurrentPublishReview(workspaceId, task)
        taskRefs.push({ task, before: structuredClone(task) })
      }
      let previews: Array<ReturnType<typeof service.preparePublish>>
      try {
        previews = taskRefs.map(({ task }) => service.preparePublish(task.id))
      } catch (error) {
        // preparePublish updates only the task pointer/state. Restore every
        // task before returning so a failed batch leaves no partial prepared
        // children in memory or in the next persistence transaction.
        for (const { task, before } of taskRefs) {
          for (const key of Object.keys(task)) delete (task as unknown as Record<string, unknown>)[key]
          Object.assign(task, before)
        }
        throw error
      }
      for (const preview of previews) {
        const canonicalProof = await assertCanonicalTaskScopeForAction(preview.task)
        if (canonicalProof?.canonicalReadRevision && preview.task.pendingPublish) preview.task.pendingPublish.canonicalReadRevision = canonicalProof.canonicalReadRevision
        await persistSnapshot(workspaceId, 'task', preview.task, preview.task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, preview.task.id, 'publish.prepared', preview.task.version, { task_id: preview.task.id, content_version_id: preview.version.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, payload_hash: preview.payloadHash, selection_hash: preview.selectionHash, selected_count: preview.visualPreview.count, image_mode: preview.visualPreview.imageMode, batch: true })
      }
      const timestamp = new Date().toISOString()
      const batch: PublishBatch = {
        id: batchId,
        workspaceId,
        state: 'prepared',
        items: previews.map(preview => ({ taskId: preview.task.id, platform: preview.task.platform, ...(preview.task.accountId ? { accountId: preview.task.accountId } : {}), contentVersionId: preview.version.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, state: 'prepared' as const })),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
      }
      publishBatches.set(batch.id, batch)
      await persistSnapshot(workspaceId, 'publish_batch', batch, batch as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, batch.id, 'publish.batch.prepared', batch.revision, { batch_id: batch.id, item_count: batch.items.length })
      persistedPublishBatches.set(batch.id, structuredClone(batch))
      return result({ isBatch: true, batchId, batch, count: previews.length, items: previews, confirmationRequiredPerItem: true, executionMode: 'confirm_each_item' })
    }
    case 'publish.batch.confirm': {
      const requestedBatchId = required(params, 'batch_id')
      let batch = publishBatches.get(requestedBatchId)
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (batch?.state === 'paused') throw new DomainError('PUBLISH_BATCH_PAUSED', '该批次已暂停，请先恢复后再确认或重试', 409)
      let confirmations: Array<Record<string, unknown>>
      try {
        const parsed = JSON.parse(required(params, 'confirmations_json'))
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => !item || typeof item !== 'object')) throw new Error('invalid')
        confirmations = parsed as Array<Record<string, unknown>>
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'confirmations_json 必须是 1 至 50 个确认对象的 JSON 数组', 400) }
      assertUniqueBatchTaskIds(confirmations)
      const items: Array<Record<string, unknown>> = []
      for (const confirmation of confirmations) {
        const taskId = typeof confirmation.task_id === 'string' ? confirmation.task_id.trim() : ''
        const itemKey = typeof confirmation.idempotency_key === 'string' ? confirmation.idempotency_key.trim() : ''
        try {
          if (!taskId || !itemKey) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '每个批量发布项都必须有 task_id 和 idempotency_key', 400)
          const task = scopeTask(req, taskId)
          await enforceTaskBrandAccess(req, task, 'publisher')
          await requireEnabledPlatform(workspaceId, task.platform)
          if (batch) {
            const batchItem = batch.items.find(item => item.taskId === taskId)
            if (!batchItem) throw new DomainError('PUBLISH_BATCH_ITEM_NOT_FOUND', `任务 ${taskId} 不属于该批次`, 400)
            if (['published', 'submitted', 'queued'].includes(batchItem.state)) throw new DomainError('PUBLISH_BATCH_ITEM_ALREADY_QUEUED', `任务 ${taskId} 已经排队`, 409)
          }
          const contentVersionId = typeof confirmation.content_version_id === 'string' ? confirmation.content_version_id : ''
          const confirmationHash = typeof confirmation.confirmation_hash === 'string' ? confirmation.confirmation_hash : ''
          const remoteSnapshotHash = typeof confirmation.remote_snapshot_hash === 'string' ? confirmation.remote_snapshot_hash : ''
          if (!contentVersionId || !confirmationHash || !remoteSnapshotHash) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 缺少新鲜确认哈希`, 400)
          const accountId = resolveTaskPublishAccount(task, typeof confirmation.account_id === 'string' ? confirmation.account_id : undefined)
          if ((isProduction() || fixtureMode) && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `任务 ${taskId} 未绑定店铺`, 400)
          if (isProduction() || fixtureMode) service.getActionablePlatformAccount(workspaceId, accountId!, task.platform)
          if (!task.contentVersionId || task.contentVersionId !== contentVersionId) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 内容版本已变化`, 400)
          assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey })
          let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          if (!existing) await hydrateDurableIdempotentJob(workspaceId, 'publish_job', itemKey)
          existing = existing ?? [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          const authorizationSnapshot = existing ? undefined : requirePublishAuthorizationSnapshot(publishAuthorizationSnapshot(req, workspaceId, task))
          if (!existing) await consumePublishConfirmationTicket(req, workspaceId, { workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, params: confirmation })
          const reservationId = `publish:${itemKey}`
          let reserved = false
          try {
            reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
            const job = service.confirmPublish({ workspaceId, taskId, batchId: batch.id, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey, ...(accountId ? { accountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform), ...(authorizationSnapshot ? { authorizationSnapshot } : {}), deferCommit: true })
            await persistPublishJobWithBatch({ batch, task, job, itemState: 'queued' })
            scheduleFixturePublishObservation(job)
            items.push({ task_id: taskId, state: 'queued', job: jobWithQueueMetadata(job, workspaceId, 'publish') })
          } catch (error) {
            if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
            throw error
          }
        } catch (error) {
          if (!batch && taskId) batch = { id: `batch_${randomUUID()}`, workspaceId, state: 'prepared', items: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 }
          if (batch && taskId) {
            const batchItem = batch.items.find(item => item.taskId === taskId)
            if (batchItem) Object.assign(batchItem, { state: 'failed' as const, error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'BATCH_ITEM_FAILED', message: error instanceof Error ? error.message : '批量项目失败' } })
          }
          items.push({ task_id: taskId || null, state: 'failed', error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'BATCH_ITEM_FAILED', message: error instanceof Error ? error.message : '批量项目失败' } })
        }
      }
      if (!batch) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '批量确认未产生有效项目', 400)
      batch.state = batchStateFromItems(batch.items)
      await savePublishBatch(batch, 'publish.batch.confirmed')
      return result({ batch: true, batchId: batch.id, batchState: batch.state, count: items.length, succeeded: items.filter(item => item.state === 'queued').length, failed: items.filter(item => item.state === 'failed').length, items, atomic: false, retryFailedItems: true })
    }
    case 'publish.batch.get': {
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      await refreshPublishBatch(batch)
      return result(batch)
    }
    case 'publish.batch.pause': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (['completed', 'failed'].includes(batch.state)) throw new DomainError('PUBLISH_BATCH_TERMINAL', '终态批次不能暂停', 409)
      const reason = required(params, 'reason')
      batch.state = 'paused'
      batch.pauseReason = reason
      for (const item of batch.items) if (item.state === 'prepared' || item.state === 'failed') {
        item.pausedFrom = item.state
        item.state = 'paused'
      }
      await savePublishBatch(batch, 'publish.batch.paused')
      await recordOperationAudit({ workspaceId, actorId, action: 'publish.batch.pause', resourceType: 'publish_batch', resourceId: batch.id, before: { state: 'active' }, after: { state: batch.state, pauseReason: reason, revision: batch.revision }, reason })
      return result({ ...batch, alreadyQueuedContinue: batch.items.some(item => item.state === 'queued' || item.state === 'submitted') })
    }
    case 'publish.batch.resume': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (batch.state !== 'paused') return result(batch)
      const previousState = batch.state
      for (const item of batch.items) if (item.state === 'paused') {
        // Restore the pre-pause state. Prepared work must remain confirmable;
        // turning every paused item into a failure forces needless retries.
        item.state = item.pausedFrom ?? 'failed'
        delete item.pausedFrom
      }
      batch.pauseReason = undefined
      batch.state = batchStateFromItems(batch.items)
      await savePublishBatch(batch, 'publish.batch.resumed')
      await recordOperationAudit({ workspaceId, actorId, action: 'publish.batch.resume', resourceType: 'publish_batch', resourceId: batch.id, before: { state: previousState }, after: { state: batch.state, revision: batch.revision }, reason: '运营台恢复批量发布' })
      return result(batch)
    }
    case 'publish.batch.retry_failed': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (batch.state === 'paused') throw new DomainError('PUBLISH_BATCH_PAUSED', '该批次已暂停，请先恢复后再重试', 409)
      let confirmations: Array<Record<string, unknown>>
      try {
        const parsed = JSON.parse(required(params, 'confirmations_json'))
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => !item || typeof item !== 'object')) throw new Error('invalid')
        confirmations = parsed as Array<Record<string, unknown>>
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'confirmations_json 必须是 1 至 50 个确认对象的 JSON 数组', 400) }
      assertUniqueBatchTaskIds(confirmations)
      const failedTaskIds = new Set(batch.items.filter(item => item.state === 'failed' || item.state === 'rejected' || item.state === 'unknown').map(item => item.taskId))
      const submittedTaskIds = confirmations.filter(item => typeof item.task_id === 'string').map(item => String(item.task_id))
      const invalid = submittedTaskIds.filter(taskId => !failedTaskIds.has(taskId))
      if (invalid.length) throw new DomainError('PUBLISH_BATCH_RETRY_SCOPE_INVALID', `只能重试失败项: ${invalid.join(', ')}`, 400)
      const items: Array<Record<string, unknown>> = []
      for (const confirmation of confirmations) {
        const taskId = typeof confirmation.task_id === 'string' ? confirmation.task_id.trim() : ''
        const itemKey = typeof confirmation.idempotency_key === 'string' ? confirmation.idempotency_key.trim() : ''
        try {
          if (!taskId || !itemKey) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '每个重试项都必须有 task_id 和新的 idempotency_key', 400)
          const task = scopeTask(req, taskId)
          await enforceTaskBrandAccess(req, task, 'publisher')
          const batchItem = batch.items.find(item => item.taskId === taskId)
          if (!batchItem || !failedTaskIds.has(taskId)) throw new DomainError('PUBLISH_BATCH_RETRY_SCOPE_INVALID', `任务 ${taskId} 不是失败项`, 400)
          const contentVersionId = typeof confirmation.content_version_id === 'string' ? confirmation.content_version_id : ''
          const confirmationHash = typeof confirmation.confirmation_hash === 'string' ? confirmation.confirmation_hash : ''
          const remoteSnapshotHash = typeof confirmation.remote_snapshot_hash === 'string' ? confirmation.remote_snapshot_hash : ''
          if (!contentVersionId || !confirmationHash || !remoteSnapshotHash) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 缺少新的确认哈希`, 400)
          const accountId = resolveTaskPublishAccount(task, typeof confirmation.account_id === 'string' ? confirmation.account_id : undefined)
          await requireEnabledPlatform(workspaceId, task.platform)
          if ((isProduction() || fixtureMode) && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `任务 ${taskId} 未绑定店铺`, 400)
          if (isProduction() || fixtureMode) service.getActionablePlatformAccount(workspaceId, accountId!, task.platform)
          if (!task.contentVersionId || task.contentVersionId !== contentVersionId) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 内容版本已变化`, 400)
          assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey })
          let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          if (!existing) await hydrateDurableIdempotentJob(workspaceId, 'publish_job', itemKey)
          existing = existing ?? [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          const authorizationSnapshot = existing ? undefined : requirePublishAuthorizationSnapshot(publishAuthorizationSnapshot(req, workspaceId, task))
          if (!existing) await consumePublishConfirmationTicket(req, workspaceId, { workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, params: confirmation })
          const reservationId = `publish:${itemKey}`
          let reserved = false
          try {
            reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
            const job = service.confirmPublish({ workspaceId, taskId, batchId: batch.id, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey, ...(accountId ? { accountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform), ...(authorizationSnapshot ? { authorizationSnapshot } : {}), deferCommit: true })
            await persistPublishJobWithBatch({ batch, task, job, itemState: 'queued' })
            scheduleFixturePublishObservation(job)
            items.push({ task_id: taskId, state: 'queued', job: jobWithQueueMetadata(job, workspaceId, 'publish') })
          } catch (error) {
            if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
            throw error
          }
        } catch (error) {
          const failure = error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'BATCH_RETRY_FAILED', message: error instanceof Error ? error.message : '批量重试失败' }
          const batchItem = batch.items.find(item => item.taskId === taskId)
          if (batchItem) Object.assign(batchItem, { state: 'failed' as const, error: failure })
          items.push({ task_id: taskId || null, state: 'failed', error: failure })
        }
      }
      batch.state = batchStateFromItems(batch.items)
      await savePublishBatch(batch, 'publish.batch.retried')
      await recordOperationAudit({ workspaceId, actorId, action: 'publish.batch.retry_failed', resourceType: 'publish_batch', resourceId: batch.id, before: { state: 'failed_or_partial' }, after: { state: batch.state, succeeded: items.filter(item => item.state === 'queued').length, failed: items.filter(item => item.state === 'failed').length, revision: batch.revision }, reason: '运营台重试批量发布失败项' })
      return result({ batch: true, batchId: batch.id, batchState: batch.state, count: items.length, succeeded: items.filter(item => item.state === 'queued').length, failed: items.filter(item => item.state === 'failed').length, items, retry: true, atomic: false })
    }
    case 'publish.confirm': {
      const key = header(req, 'idempotency-key')?.trim()
      if (!key) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '发布确认必须携带 Idempotency-Key', 400)
      const taskId = required(params, 'task_id')
      const task = scopeTask(req, taskId)
      await requireEnabledPlatform(workspaceId, task.platform)
      await requireCurrentPlatformMapping(task)
      const contentVersionId = required(params, 'content_version_id')
      const confirmationHash = required(params, 'confirmation_hash')
      const remoteSnapshotHash = required(params, 'remote_snapshot_hash')
      if (!task.contentVersionId || task.contentVersionId !== contentVersionId) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, '缺少有效的一次性发布确认 token', 400)
      if (isProduction() && !((typeof params.account_id === 'string' && params.account_id.trim()) || task.accountId)) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产发布必须绑定已授权平台账号', 400)
      const publishAccountId = resolveTaskPublishAccount(task, typeof params.account_id === 'string' ? params.account_id : undefined)
      if (isProduction() || fixtureMode) service.getActionablePlatformAccount(workspaceId, publishAccountId!, task.platform)
      if (isProduction() && !platformWriteReady(task.platform)) throw new DomainError('PLATFORM_WRITE_NOT_READY', '平台尚未完成生产写入能力验证，当前不会创建发布任务', 503)
      assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key })
      let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
      if (!existing) {
        await hydrateDurableIdempotentJob(workspaceId, 'publish_job', key)
        existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
      }
      const authorizationSnapshot = existing ? undefined : requirePublishAuthorizationSnapshot(publishAuthorizationSnapshot(req, workspaceId, task))
      const publishInput = { workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, params }
      const fencedTicket = existing ? undefined : await reservePublishConfirmationTicket(req, workspaceId, publishInput)
      if (!existing && !fencedTicket) await consumePublishConfirmationTicket(req, workspaceId, publishInput)
      const reservationId = `publish:${key}`
      let reserved = false
      try {
        const job = service.confirmPublish({ workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key, ...(publishAccountId ? { accountId: publishAccountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform), authorizationSnapshot, deferCommit: true })
        const currentTask = existing ? service.getTask(taskId) : { ...task, state: 'publishing' as const, version: task.version + 1 }
        const snapshots: Array<{ entityType: 'task' | 'publish_job'; entityId: string; entityVersion: number; payload: Record<string, unknown> }> = [
          { entityType: 'task' as const, entityId: currentTask.id, entityVersion: currentTask.version, payload: currentTask as unknown as Record<string, unknown> },
          { entityType: 'publish_job' as const, entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown> },
        ]
        if (fencedTicket && persistence.persistPublishTransaction) {
          await runFencedSinglePublish({
            ticketRepository: persistence.interactiveConfirmationTickets as TransactionalInteractiveConfirmationTicketRepository,
            ticket: fencedTicket.ticket,
            reservation: fencedTicket.reservation,
            consumedOperationId: job.id,
            slot: {
              reserve: async () => { reserved = await reserveDistributedJobSlot(workspaceId, reservationId) },
              release: async () => { if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId); reserved = false },
            },
            persist: async ({ finalizeInTransaction }) => {
              await persistence.persistPublishTransaction!({ workspaceId, snapshots, aggregateId: job.id, eventType: 'publish.requested', sequence: 1, eventPayload: await withCommercialWorkerSnapshot(workspaceId, 'publish.requested', publishEventPayload(job)), finalizeTicketInTransaction: finalizeInTransaction })
              return { status: 'committed' as const, value: job }
            },
          })
        } else {
          reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
          await persistSnapshotsAndEvent({ workspaceId, snapshots, aggregateId: job.id, eventType: 'publish.requested', sequence: 1, eventPayload: publishEventPayload(job) })
        }
        service.commitPublishConfirmation(job)
        scheduleFixturePublishObservation(job)
        return result(jobWithQueueMetadata(job, workspaceId, 'publish'))
      } catch (error) {
        if (!(error instanceof PublishCommitStatusUnknownError)) {
          if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
        }
        throw error
      }
    }
    case 'publish.get': {
      const job = service.getPublishJob(required(params, 'publish_job_id'))
      if (job.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该发布任务', 403)
      await enforceTaskBrandAccess(req, service.getTask(job.taskId), 'viewer')
      return result({ ...jobWithQueueMetadata(job, workspaceId, 'publish'), workflow: projectPublishWorkflow(workspaceId, job) })
    }
    default: return
  }
}
