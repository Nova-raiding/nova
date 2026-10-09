import { describe, expect, it, vi } from 'vitest'
import { handleOpsOverviewMcpMethod, type OpsOverviewDependencies } from './mcp-ops-overview-handlers.js'

type StoreDirectoryEntry = ReturnType<OpsOverviewDependencies['workspaceStoreDirectory']>[number]
type StoreDirectoryFixtureEntry = StoreDirectoryEntry & { workspaceId: string }
const workspaceIds = Array.from({ length: 5 }, (_, index) => `private-workspace-${index + 1}`)

const stores: StoreDirectoryFixtureEntry[] = Array.from({ length: 5 }, (_, index): StoreDirectoryFixtureEntry => ({
  workspaceId: workspaceIds[index]!,
  platform: 'taobao' as const,
  accountId: `private-account-${index + 1}`,
  label: `private store ${index + 1}`,
  state: 'connected',
  dataMode: 'official_api',
  readable: true,
  writeEnabled: false,
  authorization: {
    state: 'connected',
    reauthorizationRequired: false,
    grantedScopes: [],
    scopeState: 'unknown',
    lastKnownAccessTokenExpiresAt: null,
    lastKnownExpiryState: 'unknown',
    renewalMode: 'unknown',
    refreshSupported: null,
    lastAuthorizedAt: null,
    metadataObservedAt: null,
    metadataFreshness: 'unknown',
    stateChangedAt: null,
    revokedAt: null,
  },
  sync: {
    latestState: null,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    lastUsableAt: null,
    failedItems: 0,
  },
  revision: 1,
}))

function dependencies(): OpsOverviewDependencies {
  return {
    persistence: () => ({ listWorkspaceIds: async () => workspaceIds } as never),
    brandUnits: () => ({} as never),
    service: {} as never,
    knownWorkspaces: () => [],
    principalWorkspaces: () => [],
    requiresStrictAuth: () => true,
    isPlatformOperations: () => true,
    requireOperationsRole: () => 'operator',
    requirePlatformReadRole: vi.fn(() => 'operator'),
    required: () => '',
    header: () => undefined,
    workspaceStoreDirectory: (workspaceId) => {
      const index = workspaceIds.indexOf(workspaceId)
      return index < 0 ? [] : [stores[index]!]
    },
    platformLabels: { taobao: '淘宝' } as never,
    supportedPlatforms: ['taobao'],
    loadPlatformWorkspaceEnterpriseNames: async () => new Map(),
    workspaceSummary: async () => ({ workspaceId: '', enterpriseName: '', status: 'active', planName: '', monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: 'active', memberCount: 0 }),
    activeMerchantWorkspaceIds: async () => new Set(),
    persistSnapshot: async () => undefined,
    persistEvent: async () => undefined,
    recordOperationAudit: async () => undefined,
    manualPlatformOperations: () => false,
    hydrateWorkspace: async () => undefined,
    importManualProducts: async () => undefined,
  }
}

describe('ops.stores.list redacted aggregate counts', () => {
  it('returns the represented store count without exposing workspace or account identities', async () => {
    const deps = dependencies()
    const result = await handleOpsOverviewMcpMethod(
      'ops.stores.list', { platform_scope: 'platform' }, 'request-workspace', {} as never, deps,
    ) as { items: Array<Record<string, unknown>>; total: number; aggregate: boolean }

    expect(deps.requirePlatformReadRole).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ aggregate: true, total: 1, items: [{ count: 5, label: '5 个淘宝店铺', aggregate: true }] })
    expect(JSON.stringify(result)).not.toContain('private-workspace-')
    expect(JSON.stringify(result)).not.toContain('private-account-')
  })
})
