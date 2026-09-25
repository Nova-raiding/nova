import type { UsageRepository, SubscriptionRepository } from '../../../packages/persistence/src/index.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { mapWithConcurrency } from './bounded-concurrency.js'

export type PlatformUserCommercialSummary = {
  planCode: string
  planName: string
  subscriptionStatus: string
  usedTasks: number
  includedTasks: number
  remainingTasks: number
  walletBalanceCny: string
}

/** Deterministic upper bound for the memory repository's platform scan. */
export function boundOpsUserWorkspaceScan(workspaceIds: readonly string[]): { workspaceIds: readonly string[]; scanTruncated: boolean } {
  const configured = process.env.OPS_USERS_SCAN_WORKSPACE_LIMIT?.trim()
  const parsed = configured ? Number(configured) : NaN
  const limit = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 500
  if (workspaceIds.length <= limit) return { workspaceIds, scanTruncated: false }
  return { workspaceIds: [...workspaceIds].sort().slice(0, limit), scanTruncated: true }
}

export async function loadPlatformUserCommercialSummaries(
  workspaceIds: readonly string[],
  dependencies: {
    usageRepository: Pick<UsageRepository, 'get'>
    subscriptionRepository: Pick<SubscriptionRepository, 'get'>
    currentWalletBalanceFen: (workspaceId: string) => Promise<number>
  },
): Promise<Map<string, PlatformUserCommercialSummary>> {
  const summaries = await mapWithConcurrency(workspaceIds, 8, async workspaceId => {
    const [usage, subscription, balanceFen] = await Promise.all([
      dependencies.usageRepository.get(workspaceId),
      dependencies.subscriptionRepository.get(workspaceId),
      dependencies.currentWalletBalanceFen(workspaceId),
    ])
    return [workspaceId, {
      planCode: subscription.planCode,
      planName: subscription.planName,
      subscriptionStatus: subscription.status,
      usedTasks: usage.usedTasks,
      includedTasks: usage.includedTasks,
      remainingTasks: usage.remainingTasks,
      walletBalanceCny: (balanceFen / 100).toFixed(2),
    }] as const
  })
  return new Map(summaries)
}

export async function loadPlatformWorkspaceEnterpriseNames(
  workspaceIds: readonly string[],
  dependencies: {
    listWorkspaceSummaries?: (query: { workspaceIds: readonly string[] }) => Promise<Array<{ workspaceId: string; enterpriseName: string }>>
    listAccounts: PasswordAuthRepository['listAccounts']
  },
): Promise<Map<string, string>> {
  const requested = new Set(workspaceIds.filter(Boolean))
  const names = new Map<string, string>()
  if (!requested.size) return names
  if (dependencies.listWorkspaceSummaries) {
    for (const summary of await dependencies.listWorkspaceSummaries({ workspaceIds: [...requested] })) {
      if (requested.has(summary.workspaceId) && summary.enterpriseName.trim()) names.set(summary.workspaceId, summary.enterpriseName.trim())
    }
  }
  if (names.size < requested.size) {
    for (const account of await dependencies.listAccounts()) {
      if (account.accountType !== 'merchant' || !account.enterpriseName?.trim()) continue
      for (const workspaceId of account.workspaceIds) {
        if (requested.has(workspaceId) && !names.has(workspaceId)) names.set(workspaceId, account.enterpriseName.trim())
      }
    }
  }
  return names
}
