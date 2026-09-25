import type { MerchantService } from '../../../packages/application/src/service.js'
import { contextEnvelopeHash } from '../../../packages/persistence/src/context-snapshot-repository.js'

export function createTaskWorkflowUtils(service: MerchantService) {
  function jobWithQueueMetadata<T extends { id: string }>(job: T, workspaceId: string, type: 'generation' | 'publish') {
    return { ...job, ...service.getJobQueueMetadata(workspaceId, { type, jobId: job.id }) }
  }

  return { jobWithQueueMetadata }
}

export function prioritizeQueueAssets<T extends { id: string }>(assets: readonly T[], priorityAssetIds: readonly string[], limit: number): T[] {
  const priority = new Map(priorityAssetIds.map((id, index) => [id, index]))
  return [...assets].sort((left, right) => {
    const leftPriority = priority.get(left.id)
    const rightPriority = priority.get(right.id)
    if (leftPriority === undefined) return rightPriority === undefined ? 0 : 1
    if (rightPriority === undefined) return -1
    return leftPriority - rightPriority
  }).slice(0, limit)
}

export function taskContextLinkId(taskId: string, envelope: Record<string, unknown>) {
  return `context_link_${taskId}_${contextEnvelopeHash(envelope).slice(0, 16)}`
}
