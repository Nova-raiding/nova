import { describe, expect, it, vi } from 'vitest'
import { commercialOpsTimeline, listCommercialContractRows, listCommercialContractRowsWithStatus, paginateCommercialTimeline } from './mcp-commercial-ops-timeline.js'

describe('paginateCommercialTimeline', () => {
  const events = [
    { id: 'event-c', occurred_at: '2026-10-09T12:00:00.000Z' },
    { id: 'event-b', occurred_at: '2026-10-09T12:00:00.000Z' },
    { id: 'event-a', occurred_at: '2026-10-08T12:00:00.000Z' },
  ]

  it('uses a stable descending timestamp/id order across cursor pages', () => {
    const input = { workspaceId: 'ws-1', status: '', limit: 2 }
    const first = paginateCommercialTimeline(events, input)
    expect(first.items.map(event => event.id)).toEqual(['event-c', 'event-b'])
    expect(first).toMatchObject({ total: 3, truncated: true })
    const second = paginateCommercialTimeline(events, { ...input, cursor: first.nextCursor! })
    expect(second.items.map(event => event.id)).toEqual(['event-a'])
    expect(second).toMatchObject({ total: 3, truncated: false, nextCursor: null })
  })

  it('rejects cursors replayed under a different workspace or filter', () => {
    const input = { workspaceId: 'ws-1', fromAt: '2026-10-01T00:00:00.000Z', status: '', limit: 1 }
    const first = paginateCommercialTimeline(events, input)
    expect(() => paginateCommercialTimeline(events, { ...input, workspaceId: 'ws-2', cursor: first.nextCursor })).toThrow('分页游标无效')
    expect(() => paginateCommercialTimeline(events, { ...input, status: 'paid', cursor: first.nextCursor })).toThrow('分页游标无效')
  })
})

describe('listCommercialContractRows', () => {
  it('uses supported cursor pages while preserving the 500-row timeline bound', async () => {
    const rows = Array.from({ length: 650 }, (_, index) => ({
      id: `order-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, -index)).toISOString(),
    }))
    const list = vi.fn(async (options: { limit: number; cursor?: { createdAt: string; id: string } }) => {
      const start = options.cursor ? Number(options.cursor.id.slice('order-'.length)) + 1 : 0
      const items = rows.slice(start, start + options.limit)
      return { items, hasMore: start + items.length < rows.length }
    })

    const result = await listCommercialContractRows(list)

    expect(result).toHaveLength(500)
    expect(result.map(row => row.id)).toEqual(rows.slice(0, 500).map(row => row.id))
    expect(list.mock.calls.map(([options]) => options.limit)).toEqual([200, 200, 100])
    expect(list.mock.calls[1]?.[0].cursor).toEqual({ createdAt: rows[199]?.createdAt, id: 'order-199' })
    expect(list.mock.calls[2]?.[0].cursor).toEqual({ createdAt: rows[399]?.createdAt, id: 'order-399' })
  })

  it('stops when a page is empty even if the repository reports more rows', async () => {
    const list = vi.fn(async () => ({ items: [], hasMore: true }))

    await expect(listCommercialContractRows(list)).resolves.toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reports when the bounded source scan still has rows beyond its cap', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ id: `row-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, -index)).toISOString() }))
    const page = await listCommercialContractRowsWithStatus(async ({ limit, cursor }) => {
      const offset = cursor ? Number(cursor.id.slice('row-'.length)) + 1 : 0
      const items = rows.slice(offset, offset + limit)
      return { items, hasMore: offset + items.length < rows.length }
    }, 500)
    expect(page.items).toHaveLength(500)
    expect(page.truncated).toBe(true)
  })
})

describe('commercialOpsTimeline pages', () => {
  it('returns a scoped continuation cursor over the merged event ordering', async () => {
    const orderRows = [
      { id: 'order-1', createdAt: '2026-10-09T12:00:00.000Z', status: 'paid', idempotencyKey: 'idem-1', skuCode: 'basic', paidAt: null },
      { id: 'order-2', createdAt: '2026-10-08T12:00:00.000Z', status: 'paid', idempotencyKey: 'idem-2', skuCode: 'basic', paidAt: null },
    ]
    const dependencies = {
      persistence: {
        commercialContracts: {
          listOrders: async () => ({ items: orderRows, hasMore: false }),
          listEntitlementSnapshots: async () => ({ items: [], hasMore: false }),
        },
        creativePoints: { listStatement: async () => ({ items: [] }) },
        modelUsage: { listForStatement: async () => [] },
        serviceFulfillment: { listAllocations: async () => [] },
        operations: { list: async () => [] },
      },
      fallbackOperations: { list: async () => [] },
      required: (_params: Record<string, unknown>, key: string) => String(_params[key] ?? ''),
    } as never
    const first = await commercialOpsTimeline({ target_workspace_id: 'ws-1', limit: '1' }, dependencies)
    expect(first).toMatchObject({ total: 2, truncated: true, items: [{ id: 'order:order-1' }] })
    expect(typeof first.next_cursor).toBe('string')
    const second = await commercialOpsTimeline({ target_workspace_id: 'ws-1', limit: '1', cursor: first.next_cursor }, dependencies)
    expect(second).toMatchObject({ total: 2, truncated: false, items: [{ id: 'order:order-2' }], next_cursor: null })
    await expect(commercialOpsTimeline({ target_workspace_id: 'ws-2', limit: '1', cursor: first.next_cursor }, dependencies)).rejects.toThrow('分页游标无效')
  })
})
