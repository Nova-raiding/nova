import type { MerchantService, Platform } from '../../../packages/application/src/service.js'

export function createWorkflowProjections(service: MerchantService, fixtureMode: boolean) {
  function workflowStoreScope(workspaceId: string, platform: Platform, accountId?: string, productId?: string) {
    const account = accountId ? service.listPlatformAccounts(workspaceId).find(item => item.id === accountId) : undefined
    const product = productId ? service.products.get(productId) : undefined
    return {
      workspace_id: workspaceId,
      platform,
      ...(accountId ? { account_id: accountId } : {}),
      ...(account?.storeAlias || product?.storeName ? { store_name: account?.storeAlias ?? product?.storeName } : {}),
      ...(productId ? { product_id: productId } : {}),
    }
  }

  function workflowStateLabel(state: string, kind: 'sync' | 'generation' | 'publish') {
    if (kind === 'publish' && ['unknown', 'reconciling'].includes(state)) return '发布结果待确认'
    if (['queued', 'pending'].includes(state)) return '排队中'
    if (['running', 'processing', 'submitting', 'submitted', 'executing'].includes(state)) return '处理中'
    if (['succeeded', 'published', 'completed'].includes(state)) return '已完成'
    if (['rejected', 'failed', 'dead_letter'].includes(state)) return '处理失败'
    return '需要查看状态'
  }

  function projectSyncWorkflow(workspaceId: string, job: import('../../../packages/application/src/service.js').SyncJob) {
    const retryable = job.failedItems.some(item => item.retryable)
    const active = job.state === 'queued' || job.state === 'running'
    return {
      kind: 'sync' as const,
      resource_id: job.id,
      scope: workflowStoreScope(workspaceId, job.platform, job.accountId),
      status: { internal_state: job.state, user_state: workflowStateLabel(job.state, 'sync'), terminal: !active, updated_at: job.updatedAt },
      progress: { known: false, completed: job.itemsUpserted + job.itemsFailed, total: null, label: '总量未知' },
      next_action: active
        ? { method: 'catalog.sync.get', label: '刷新同步状态', allowed: true }
        : retryable
          ? { method: 'sync.retry_failed', label: '重试失败项', allowed: true, reason: `有 ${job.failedItems.filter(item => item.retryable).length} 项失败项可以重试` }
          : { method: 'catalog.sync.get', label: '查看同步结果', allowed: true },
      recovery: { retryable, ...(retryable ? { retry_scope: '仅可重试的失败项' } : {}), resume_method: 'catalog.sync.get', reconciliation_required: false },
      evidence: { source: fixtureMode ? 'fixture' : 'official_api', simulated: fixtureMode },
    }
  }

  function projectGenerationWorkflow(workspaceId: string, job: import('../../../packages/application/src/service.js').GenerationJob) {
    const task = service.tasks.get(job.taskId)
    const active = job.state === 'queued' || job.state === 'running'
    const retryable = job.state === 'failed'
    return {
      kind: 'generation' as const,
      resource_id: job.id,
      scope: workflowStoreScope(workspaceId, task?.platform ?? 'taobao', task?.accountId, task?.productId),
      status: { internal_state: job.state, user_state: workflowStateLabel(job.state, 'generation'), terminal: !active, updated_at: job.updatedAt },
      progress: { known: false, completed: active ? 0 : job.state === 'succeeded' ? 1 : 0, total: 1, label: active ? '处理中' : undefined },
      next_action: active
        ? { method: 'generation.get', label: '刷新生成状态', allowed: true }
        : retryable
          ? { method: 'generation.get', label: '查看失败原因', allowed: true }
          : { method: 'generation.get', label: '查看生成结果', allowed: true },
      recovery: { retryable, ...(retryable ? { retry_scope: '当前生成任务' } : {}), resume_method: 'generation.get', reconciliation_required: false },
      evidence: { source: fixtureMode ? 'fixture' : 'official_api', simulated: fixtureMode },
    }
  }

  function projectPublishWorkflow(workspaceId: string, job: import('../../../packages/application/src/service.js').PublishJob) {
    const unknown = job.state === 'unknown' || job.state === 'reconciling' || job.remoteState === 'unknown'
    const terminal = !unknown && ['published', 'rejected', 'failed'].includes(job.remoteState ?? job.state)
    const state = unknown ? job.remoteState === 'unknown' ? 'unknown' : 'reconciling' : job.remoteState ?? job.state
    const task = service.tasks.get(job.taskId)
    return {
      kind: 'publish' as const,
      resource_id: job.id,
      scope: workflowStoreScope(workspaceId, job.platform, job.accountId ?? task?.accountId, task?.productId),
      status: { internal_state: state, user_state: workflowStateLabel(state, 'publish'), terminal, updated_at: job.remoteObservedAt ?? job.createdAt },
      progress: { known: false, completed: terminal ? 1 : 0, total: 1, label: unknown ? '结果未知' : undefined },
      next_action: unknown
        ? { method: 'publish.get', label: '查询发布状态', allowed: true, reason: '平台最终回执尚未确认，不能重复提交' }
        : terminal
          ? { method: 'publish.get', label: '查看发布结果', allowed: true }
          : { method: 'publish.get', label: '刷新发布状态', allowed: true },
      recovery: { retryable: false, resume_method: 'publish.get', reconciliation_required: unknown, ...(unknown ? { retry_scope: '人工对账' } : {}) },
      evidence: { source: fixtureMode ? 'fixture' : 'official_api', simulated: job.remoteSimulated === true || fixtureMode, ...(job.requestId ? { request_id: job.requestId } : {}) },
      // Read exit for the delivery-drift record. Until now it was written and
      // never read: an operator opening the job saw `reconciling` with no statement
      // of what actually happened. `task_state` is the *current* task pointer,
      // which diverges from the escalated snapshot once the reconciliation is
      // closed and the task is handed back for rework.
      ...(job.deliveryReconciliation ? {
        reconciliation: {
          ...job.deliveryReconciliation,
          settled: Boolean(job.operatorAcknowledgement),
          ...(job.operatorAcknowledgement ? { acknowledged_by: job.operatorAcknowledgement.actorId, acknowledged_at: job.operatorAcknowledgement.acknowledgedAt, acknowledgement_reason: job.operatorAcknowledgement.reason } : {}),
          ...(task?.state ? { task_state: task.state } : {}),
          // Only an operator decision closes this; nothing automatic can.
          close_method: 'ops.marketing.publish.acknowledge',
        },
      } : {}),
    }
  }

  function taskWorkflowProjections(workspaceId: string, taskId: string) {
    const workflows = [
      ...[...service.generationJobs.values()].filter(job => job.workspaceId === workspaceId && job.taskId === taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1).map(job => projectGenerationWorkflow(workspaceId, job)),
      ...[...service.publishJobs.values()].filter(job => job.workspaceId === workspaceId && job.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1).map(job => projectPublishWorkflow(workspaceId, job)),
    ]
    return workflows
  }

  return { workflowStoreScope, workflowStateLabel, projectSyncWorkflow, projectGenerationWorkflow, projectPublishWorkflow, taskWorkflowProjections }
}
