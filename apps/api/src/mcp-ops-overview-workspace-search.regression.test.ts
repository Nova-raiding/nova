import { describe, expect, it } from 'vitest'
import { handleOpsOverviewMcpMethod, type OpsOverviewDependencies } from './mcp-ops-overview-handlers.js'

const enterprise = {
  workspaceId: 'ws_enterprise_1',
  enterpriseName: '青禾跨境商贸',
  status: 'active' as const,
  planName: 'Enterprise',
  monthlyPriceCny: 0,
  usedTasks: 0,
  includedTasks: 100,
  subscriptionStatus: 'active',
  memberCount: 2,
}

function dependencies(): OpsOverviewDependencies {
  return {
    persistence: () => ({ listWorkspaceIds: async () => [enterprise.workspaceId] } as never),
    brandUnits: () => ({} as never),
    service: {} as never,
    knownWorkspaces: () => [],
    principalWorkspaces: () => [],
    requiresStrictAuth: () => true,
    isPlatformOperations: () => true,
    requireOperationsRole: () => 'operator',
    requirePlatformReadRole: () => 'operator',
    required: () => '',
    header: () => undefined,
    workspaceStoreDirectory: () => [],
    platformLabels: {} as never,
    supportedPlatforms: [],
    loadPlatformWorkspaceEnterpriseNames: async () => new Map([[enterprise.workspaceId, enterprise.enterpriseName]]),
    workspaceSummary: async () => enterprise,
    activeMerchantWorkspaceIds: async () => new Set([enterprise.workspaceId]),
    persistSnapshot: async () => undefined,
    persistEvent: async () => undefined,
    recordOperationAudit: async () => undefined,
    manualPlatformOperations: () => false,
    hydrateWorkspace: async () => undefined,
    importManualProducts: async () => undefined,
  }
}

describe('ops.workspaces.list fallback enterprise search', () => {
  it('matches enterprise names when the workspace directory adapter is unavailable', async () => {
    const result = await handleOpsOverviewMcpMethod(
      'ops.workspaces.list', { query: '跨境商贸', offset: '0', limit: '20' }, 'ws_request', {} as never, dependencies(),
    )

    expect(result).toMatchObject({ items: [{ workspaceId: enterprise.workspaceId, enterpriseName: enterprise.enterpriseName }], total: 1 })
  })

  it('does not match an unrelated enterprise name in the same fallback path', async () => {
    const result = await handleOpsOverviewMcpMethod(
      'ops.workspaces.list', { query: '不存在的企业', offset: '0', limit: '20' }, 'ws_request', {} as never, dependencies(),
    )

    expect(result).toMatchObject({ items: [], total: 0 })
  })
})
