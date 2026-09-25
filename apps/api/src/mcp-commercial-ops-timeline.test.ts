import { describe, expect, it, vi } from 'vitest'
import { listCommercialContractRows } from './mcp-commercial-ops-timeline.js'

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
})
