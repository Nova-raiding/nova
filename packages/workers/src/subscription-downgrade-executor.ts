import type { AppliedSubscriptionChange, CommercialExtensionsRepository } from '../../persistence/src/commercial-extensions-repository.js'

export interface SubscriptionDowngradeExecutionResult {
  scanned: number
  applied: number
  skipped: number
  failed: number
  applications: AppliedSubscriptionChange[]
  failures: Array<{ workspaceId: string; error: string }>
}

export async function executeScheduledSubscriptionDowngrades(input: {
  workspaceIds: readonly string[]
  repository: Pick<CommercialExtensionsRepository, 'applyDueSubscriptionChange'>
  at?: Date
}): Promise<SubscriptionDowngradeExecutionResult> {
  const workspaceIds = [...new Set(input.workspaceIds.map(value => value.trim()).filter(Boolean))]
  const at = (input.at ?? new Date()).toISOString()
  const result: SubscriptionDowngradeExecutionResult = { scanned: workspaceIds.length, applied: 0, skipped: 0, failed: 0, applications: [], failures: [] }

  for (const workspaceId of workspaceIds) {
    try {
      const application = await input.repository.applyDueSubscriptionChange({ workspaceId, at })
      if (!application) {
        result.skipped += 1
        continue
      }
      result.applied += 1
      result.applications.push(application)
    } catch (error) {
      result.failed += 1
      result.failures.push({ workspaceId, error: error instanceof Error ? error.message : 'subscription downgrade failed' })
    }
  }
  return result
}
