import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleMcpTaskReadFeedback } from './mcp-task-read-feedback-handlers.js'

describe('task.history date filters', () => {
  it('normalizes offset bounds consistently for memory and PostgreSQL paths', async () => {
    const included = { id: 'task_included', workspaceId: 'ws_task_dates', productId: 'prod_fixture_1', platform: 'taobao', state: 'draft', createdAt: '2026-09-30T22:30:00.000Z' }
    const boundary = { id: 'task_boundary', workspaceId: 'ws_task_dates', productId: 'prod_fixture_1', platform: 'taobao', state: 'draft', createdAt: '2026-09-30T22:00:00.000Z' }
    const excluded = { id: 'task_excluded', workspaceId: 'ws_task_dates', productId: 'prod_fixture_1', platform: 'taobao', state: 'draft', createdAt: '2026-10-01T00:30:00.000Z' }
    const tasks = [included, boundary, excluded]
    const service = { listTasks: vi.fn((_workspaceId: string, filters: { dateFrom?: string; dateTo?: string }) => tasks.filter(task => (!filters.dateFrom || task.createdAt >= filters.dateFrom) && (!filters.dateTo || task.createdAt <= filters.dateTo))) }
    const businessPage = vi.fn(async (_workspaceId: string, input: Record<string, unknown>) => ({
      items: tasks.filter(task => (!input.dateFrom || Date.parse(task.createdAt) >= Date.parse(String(input.dateFrom))) && (!input.dateTo || Date.parse(task.createdAt) <= Date.parse(String(input.dateTo)))), total: 2, limit: 50, offset: 0,
    }))
    const deps = {
      service,
      business: { listTasksPage: businessPage },
      mcpPagination: () => ({ limit: 50, offset: 0 }),
      accessibleTaskBrandIds: async () => undefined,
      filterByTaskBrandAccess: async (_req: IncomingMessage, _workspaceId: string, tasks: unknown[]) => tasks,
      taskWorkflowProjections: () => [],
    } as any
    const request = {} as IncomingMessage
    const params = { date_from: '2026-10-01T00:00:00+02:00', date_to: '2026-10-01T01:00:00+02:00' }

    const durable = await handleMcpTaskReadFeedback('task.history', params, request, 'ws_task_dates', deps) as { items: Array<{ id: string }> }
    expect(businessPage).toHaveBeenCalledWith('ws_task_dates', expect.objectContaining({ dateFrom: '2026-09-30T22:00:00.000Z', dateTo: '2026-09-30T23:00:00.000Z' }))
    expect(durable.items.map(task => task.id)).toEqual([included.id, boundary.id])

    const memory = await handleMcpTaskReadFeedback('task.history', params, request, 'ws_task_dates', { ...deps, business: undefined }) as { items: Array<{ id: string }> }
    expect(memory.items.map(task => task.id)).toEqual([included.id, boundary.id])
  })

  it('rejects malformed and reversed date bounds', async () => {
    const service = { listTasks: vi.fn(() => []) }
    const deps = {
      service,
      mcpPagination: () => ({ limit: 50, offset: 0 }),
      accessibleTaskBrandIds: async () => undefined,
      filterByTaskBrandAccess: async (_req: IncomingMessage, _workspaceId: string, tasks: unknown[]) => tasks,
      taskWorkflowProjections: () => [],
    } as any
    const request = {} as IncomingMessage
    await expect(handleMcpTaskReadFeedback('task.history', { date_from: '2026-10-02T00:00:00Z', date_to: '2026-10-01T00:00:00Z' }, request, 'ws_task_dates', deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(handleMcpTaskReadFeedback('task.history', { date_to: '2026-10-01T00:00:00' }, request, 'ws_task_dates', deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
  })
})
