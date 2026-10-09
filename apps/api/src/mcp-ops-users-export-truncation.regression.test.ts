import { describe, expect, it, vi } from 'vitest'
import { handleMcpOpsUsersMethod } from './mcp-ops-users-handlers.js'

function member(index: number) {
  return {
    id: `member-${index}`, workspaceId: 'ws-export', externalSubject: `user-${index}`,
    displayName: `User ${index}`, role: 'operator' as const, status: 'active' as const,
    invitedBy: 'fixture', revision: 1, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  }
}

async function exportUsers(input: { requestedLimit: number; matchedCount: number; format: 'csv' | 'json' }) {
  const items = Array.from({ length: Math.min(input.requestedLimit, input.matchedCount) }, (_, index) => member(index))
  const members = {
    searchWindow: vi.fn(async () => ({ items, itemsFrom: 0, total: input.matchedCount, identityCount: input.matchedCount, workspaceCount: 1 })),
  }
  const req = {} as never
  const result = await handleMcpOpsUsersMethod('ops.users.export', { limit: String(input.requestedLimit), format: input.format }, req, {
    requirePlatformReadRole: vi.fn(),
    listWorkspaceIds: async () => ['ws-export'],
    knownWorkspaces: new Set(['ws-export']),
    members: members as never,
    memoryMembers: {} as never,
    memoryIdentities: {} as never,
    memoryOperations: {} as never,
    passwordAuthRepository: { listAccounts: async () => [] } as never,
    loadPlatformWorkspaceEnterpriseNames: async () => new Map([['ws-export', 'Example']]),
    loadPlatformUserCommercialSummaries: async () => new Map(),
    getWorkspaceStatus: async () => 'active',
    boundOpsUserWorkspaceScan: () => ({ workspaceIds: ['ws-export'], scanTruncated: false }),
    mapIdentityLifecycleError: (error: unknown): never => { throw error },
  }) as { truncated: boolean; count: number }
  return { result, searchWindow: members.searchWindow }
}

describe('ops.users.export truncation metadata', () => {
  it('does not report truncation when exact matched total equals the returned limit', async () => {
    for (const format of ['csv', 'json'] as const) {
      const { result } = await exportUsers({ requestedLimit: 2, matchedCount: 2, format })
      expect(result).toMatchObject({ count: 2, truncated: false })
    }
  })

  it('reports truncation only when the authoritative matched total exceeds returned rows', async () => {
    const { result, searchWindow } = await exportUsers({ requestedLimit: 2, matchedCount: 3, format: 'json' })
    expect(result).toMatchObject({ count: 2, truncated: true })
    expect(searchWindow).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 2 }))
  })
})
