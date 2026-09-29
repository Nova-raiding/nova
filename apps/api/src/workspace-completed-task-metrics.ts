type VerifiedPublishReceipt = {
  taskId: string
  state: string
  remoteState?: string
  remoteObservedAt?: string
  remoteSimulated?: boolean
  remoteId?: string
  requestId?: string
  deliveryReconciliation?: unknown
}

/** Count distinct tasks with a verified, real publish receipt in the window. */
export function countVerifiedCompletedTasks(
  jobs: readonly VerifiedPublishReceipt[],
  inPeriod: (timestamp: string | undefined) => boolean,
): number {
  const completed = new Set<string>()
  for (const job of jobs) {
    if (job.state !== 'published' || job.remoteState !== 'published' || job.remoteSimulated === true
      || !job.remoteObservedAt || !(job.remoteId || job.requestId) || job.deliveryReconciliation
      || !inPeriod(job.remoteObservedAt)) continue
    completed.add(job.taskId)
  }
  return completed.size
}
