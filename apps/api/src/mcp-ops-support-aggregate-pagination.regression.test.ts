import { describe, expect, it, vi } from 'vitest'
import { handleMcpOpsSupport } from './mcp-ops-support-handlers.js'
import type { SupportRepository } from '../../../packages/persistence/src/support-repository.js'

describe('platform support aggregate pagination warning', () => {
  it('marks grouped counts incomplete when any workspace has another ticket page', async () => {
    const ticketId = 'b59f4b4e-0f91-4dec-8daa-40d33ff84076'
    const repository = {
      async list() {
        return {
          items: [{
            id: ticketId, workspaceId: 'ws-a', ticketNumber: 'SUP-1', subject: '支付异常', description: '',
            status: 'open', priority: 'urgent', customerId: 'customer-1', customerName: '客户', tags: [],
            revision: 1, createdBy: 'support', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
            sla: { state: 'on_track', dueAt: '2026-10-10T00:00:00.000Z' },
          }],
          nextCursor: { createdAt: '2026-10-09T00:00:00.000Z', id: ticketId },
        }
      },
    } as unknown as SupportRepository
    const request = { headers: {} } as never
    const result = await handleMcpOpsSupport('ops.support.tickets.list', { platform_scope: 'platform', limit: '50' }, request, 'platform', {
      persistence: { support: repository, listWorkspaceIds: async () => ['ws-a'] },
      memorySupportSlaReporting: {} as never,
      knownWorkspaces: new Set(),
      generateSupportSlaMonthlyReport: vi.fn(),
      buildWorkspaceSupportSlaMonthlyReport: vi.fn(),
      verifiedApprovalActor: vi.fn(),
      requestActor: () => 'platform-operator',
      isPlatformOperations: () => true,
      requirePlatformReadRole: () => undefined,
      supportContext: (_req, workspaceId) => ({ actorId: 'platform-operator', role: 'platform_ops', workspaceId, permissions: ['support.ticket.read'] }),
      invokeOpsDomain: operation => operation(),
    })

    expect(result).toMatchObject({ aggregate: true, scanTruncated: true, items: [{ count: 1, status: 'open', priority: 'urgent' }] })
  })
})
