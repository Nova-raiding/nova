import { describe, expect, it, vi } from 'vitest'
import { MemorySubscriptionRepository, PostgresSubscriptionRepository, SubscriptionOrderIdempotencyConflictError } from './subscription-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: string[] = []
  private readonly responses: Array<{ rows: Row[] }> = []
  enqueue(rows: Row[] = []) { this.responses.push({ rows }) }
  async query<T = Row>(text: string) {
    this.calls.push(text)
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

describe('PostgresSubscriptionRepository', () => {
  const paidOrder = { id: 'sub_1', workspaceId: 'ws_subscription', orderNo: 'SO1', planCode: 'pro', planName: 'Pro', billingCycle: 'monthly', priceCny: 299, paymentAmountCny: 299, includedStores: 5, includedTasks: 500, addonCodes: ['video'], status: 'paid', paymentProvider: 'alipay', providerTradeId: 'trade_1', idempotencyKey: 'sub-key', createdAt: '2026-08-01T00:00:00.000Z', paidAt: '2026-08-28T00:00:00.000Z' }

  it('projects only columns that exist on workspace_subscriptions', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue()
    client.enqueue([{ workspaceId: 'ws_subscription', status: 'trialing', planCode: 'trial', planName: 'Trial', billingCycle: 'monthly', priceCny: 0, includedStores: 1, includedTasks: 5, currentPeriodStart: '2026-08-01T00:00:00.000Z', currentPeriodEnd: '2026-09-01T00:00:00.000Z', revision: 1, updatedAt: '2026-08-01T00:00:00.000Z' }])
    client.enqueue()

    const result = await new PostgresSubscriptionRepository(new RecordingPool(client)).get('ws_subscription')

    expect(result.planCode).toBe('trial')
    expect(client.calls[3]).not.toContain('payment_amount_cny')
  })

  it('commits the paid order, active subscription and source event in one transaction', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([paidOrder]); client.enqueue(); client.enqueue()
    const appendEvent = vi.fn(async () => undefined)

    await new PostgresSubscriptionRepository(new RecordingPool(client), appendEvent).markPaid({ workspaceId: 'ws_subscription', orderNo: 'SO1', providerTradeId: 'trade_1', eventSource: 'provider_callback' })

    expect(appendEvent).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: 'subscription.order.paid', aggregateId: 'SO1', payload: expect.objectContaining({ plan_code: 'pro', source: 'provider_callback' }) }))
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('rolls back subscription activation when the source event cannot be persisted', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([paidOrder]); client.enqueue(); client.enqueue()
    const repository = new PostgresSubscriptionRepository(new RecordingPool(client), async () => { throw new Error('outbox unavailable') })

    await expect(repository.markPaid({ workspaceId: 'ws_subscription', orderNo: 'SO1', providerTradeId: 'trade_1', eventSource: 'provider_callback' })).rejects.toThrow('outbox unavailable')
    expect(client.calls.at(-1)).toBe('ROLLBACK')
    expect(client.calls).not.toContain('COMMIT')
  })
})

describe('MemorySubscriptionRepository', () => {
  it('retrieves an older order directly by order number after more than 100 newer orders', async () => {
    const repository = new MemorySubscriptionRepository()
    const first = await repository.createOrder({ workspaceId: 'ws_subscription', planCode: 'starter', planName: 'Starter', billingCycle: 'monthly', priceCny: 99, includedStores: 2, includedTasks: 100, paymentProvider: 'pending_provider', idempotencyKey: 'oldest-key' })
    for (let index = 0; index < 101; index += 1) {
      await repository.createOrder({ workspaceId: 'ws_subscription', planCode: 'starter', planName: 'Starter', billingCycle: 'monthly', priceCny: 99, includedStores: 2, includedTasks: 100, paymentProvider: 'pending_provider', idempotencyKey: `newer-key-${index}` })
    }

    await expect(repository.getOrderByOrderNo('ws_subscription', first.orderNo)).resolves.toMatchObject({ id: first.id, orderNo: first.orderNo })
  })

  it('rejects idempotency reuse for a different subscription intent', async () => {
    const repository = new MemorySubscriptionRepository()
    const input = { workspaceId: 'ws_subscription', planCode: 'starter', planName: 'Starter', billingCycle: 'monthly' as const, priceCny: 99, includedStores: 2, includedTasks: 100, paymentProvider: 'pending_provider', idempotencyKey: 'sub-key' }
    await repository.createOrder(input)

    await expect(repository.createOrder({ ...input, planCode: 'pro', planName: 'Pro', priceCny: 299 })).rejects.toBeInstanceOf(SubscriptionOrderIdempotencyConflictError)
  })

  it('rejects idempotency reuse by a different authenticated member', async () => {
    const repository = new MemorySubscriptionRepository()
    const input = { workspaceId: 'ws_subscription', planCode: 'starter', planName: 'Starter', billingCycle: 'monthly' as const, priceCny: 99, includedStores: 2, includedTasks: 100, paymentProvider: 'pending_provider', createdByActorId: 'actor_a', idempotencyKey: 'member-key' }
    await repository.createOrder(input)

    await expect(repository.createOrder({ ...input, createdByActorId: 'actor_b' })).rejects.toBeInstanceOf(SubscriptionOrderIdempotencyConflictError)
  })
})
