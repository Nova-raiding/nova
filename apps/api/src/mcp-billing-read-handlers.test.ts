import { describe, expect, it } from 'vitest'
import { listRechargeOrders, type RechargeOrderView, type RechargeState } from './mcp-billing-read-handlers.js'

function order(id: string, createdAt: string, state: RechargeState = 'paid', actor = 'actor-a'): RechargeOrderView {
  return { id, workspaceId: 'ws-a', state, createdAt, createdByActorId: actor }
}

describe('billing.recharge.list cursor paging', () => {
  it('returns every matching order in stable pages and binds cursors to workspace, scope, actor, and filter', async () => {
    const rows = [
      order('recharge_c', '2026-08-28T01:00:00.000Z'),
      order('recharge_b', '2026-08-28T01:00:00.000Z'),
      order('recharge_a', '2026-08-28T01:00:00.000Z'),
      order('recharge_old', '2026-08-27T01:00:00.000Z'),
      order('recharge_pending', '2026-08-26T01:00:00.000Z', 'pending'),
      order('recharge_other_actor', '2026-08-25T01:00:00.000Z', 'paid', 'actor-b'),
    ]
    const run = (cursor?: string, input: { workspaceId?: string; actorId?: string; states?: string } = {}) => listRechargeOrders({
      workspaceId: input.workspaceId ?? 'ws-a',
      params: { states: input.states ?? 'paid', limit: '2', ...(cursor ? { cursor } : {}) },
      scope: 'mine',
      actorId: input.actorId ?? 'actor-a',
      memoryOrders: rows,
      project: row => ({ id: row.id }),
    })

    const first = await run()
    const second = await run(first.next_cursor ?? undefined)
    expect(first.orders).toEqual([{ id: 'recharge_c' }, { id: 'recharge_b' }])
    expect(second.orders).toEqual([{ id: 'recharge_a' }, { id: 'recharge_old' }])
    expect(new Set([...first.orders, ...second.orders].map(value => (value as { id: string }).id))).toEqual(new Set(['recharge_c', 'recharge_b', 'recharge_a', 'recharge_old']))
    expect(first).toMatchObject({ returned: 2, total: 4 })
    expect(first.next_cursor).toBeTruthy()
    expect(second.next_cursor).toBeNull()
  })

  it('rejects a cursor reused under another tenant or state filter', async () => {
    const rows = [order('recharge_b', '2026-08-28T02:00:00.000Z'), order('recharge_a', '2026-08-28T01:00:00.000Z')]
    const first = await listRechargeOrders({ workspaceId: 'ws-a', params: { states: 'paid', limit: '1' }, scope: 'mine', actorId: 'actor-a', memoryOrders: rows, project: row => row.id })
    const cursor = first.next_cursor ?? undefined
    await expect(listRechargeOrders({ workspaceId: 'ws-b', params: { states: 'paid', limit: '1', cursor }, scope: 'mine', actorId: 'actor-a', memoryOrders: rows, project: row => row.id })).rejects.toMatchObject({ code: 'BILLING_ORDER_CURSOR_INVALID' })
    await expect(listRechargeOrders({ workspaceId: 'ws-a', params: { states: 'pending', limit: '1', cursor }, scope: 'mine', actorId: 'actor-a', memoryOrders: rows, project: row => row.id })).rejects.toMatchObject({ code: 'BILLING_ORDER_CURSOR_INVALID' })
  })

  it('passes a validated cursor to the durable repository and returns its next cursor', async () => {
    const rows = [order('recharge_b', '2026-08-28T02:00:00.000Z'), order('recharge_a', '2026-08-28T01:00:00.000Z')]
    const summary = { pending: 0, paid: 2, closed: 0, failed: 0 }
    const first = await listRechargeOrders({
      workspaceId: 'ws-a', params: { states: 'paid', limit: '1' }, scope: 'workspace', actorId: 'actor-a', memoryOrders: [] as RechargeOrderView[], project: row => row.id,
      durable: async () => ({ orders: [rows[0]!], summary, nextCursor: { createdAt: rows[0]!.createdAt, id: rows[0]!.id } }),
    })
    let observedCursor: { createdAt: string; id: string } | undefined
    const second = await listRechargeOrders({
      workspaceId: 'ws-a', params: { states: 'paid', limit: '1', cursor: first.next_cursor ?? undefined }, scope: 'workspace', actorId: 'actor-a', memoryOrders: [] as RechargeOrderView[], project: row => row.id,
      durable: async (_states, _limit, _actorId, cursor) => {
        observedCursor = cursor
        return { orders: [rows[1]!], summary }
      },
    })
    expect(observedCursor).toEqual({ createdAt: rows[0]!.createdAt, id: rows[0]!.id })
    expect(second).toMatchObject({ orders: ['recharge_a'], returned: 1, total: 2, next_cursor: null })
  })
})
