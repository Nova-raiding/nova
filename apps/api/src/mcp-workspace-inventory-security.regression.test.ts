import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { handleOpsOverviewMcpMethod, platformOverviewWorkspaceIds, type OpsOverviewDependencies } from './mcp-ops-overview-handlers.js'

describe('platform workspace inventory trust boundary', () => {
  it('does not register a workspace supplied to an MCP request before its authorization gates', async () => {
    const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/isPlatformWideUserGovernance[\s\S]{0,240}knownWorkspaces\.add\(params\.workspace_id/u)
  })

  it('fans out platform summaries only to the authoritative directory when available', () => {
    expect(platformOverviewWorkspaceIds({
      isPlatformOperations: true,
      authoritativeWorkspaceIds: [' ws_authoritative ', 'ws_authoritative'],
      knownWorkspaceIds: ['ws_authoritative', 'ws_untrusted_request_input'],
    })).toEqual(['ws_authoritative'])
    expect(platformOverviewWorkspaceIds({
      isPlatformOperations: false,
      authoritativeWorkspaceIds: ['ws_authoritative'],
      knownWorkspaceIds: ['ws_untrusted_request_input'],
    })).toEqual([])
  })

  it('does not fall back to the request workspace when the authoritative platform directory is empty', async () => {
    const loadNames = vi.fn(async () => new Map())
    const summarize = vi.fn(async (workspaceId: string) => ({
      workspaceId, enterpriseName: '', status: 'active' as const, planName: '',
      monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: '', memberCount: 0,
    }))
    const dependencies = {
      persistence: () => ({ listWorkspaceIds: async () => [] } as never),
      knownWorkspaces: () => ['ws_from_denied_request'],
      principalWorkspaces: () => ['ws_request_header'],
      requiresStrictAuth: () => true,
      isPlatformOperations: () => true,
      requireOperationsRole: () => 'platform_ops',
      loadPlatformWorkspaceEnterpriseNames: loadNames,
      workspaceSummary: summarize,
    } as unknown as OpsOverviewDependencies
    const result = await handleOpsOverviewMcpMethod(
      'ops.workspaces.list', { query: 'needle', limit: '20', offset: '0' }, 'ws_request_header', {} as never, dependencies,
    ) as { items: unknown[]; total: number }
    expect(result).toEqual({ items: [], total: 0, offset: 0, limit: 20, hasMore: false })
    expect(loadNames).toHaveBeenCalledWith([])
    expect(summarize).not.toHaveBeenCalled()
  })
})
