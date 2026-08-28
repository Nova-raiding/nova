import { describe, expect, it } from 'vitest'
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
})

describe('MemorySubscriptionRepository', () => {
  it('rejects idempotency reuse for a different subscription intent', async () => {
    const repository = new MemorySubscriptionRepository()
    const input = { workspaceId: 'ws_subscription', planCode: 'starter', planName: 'Starter', billingCycle: 'monthly' as const, priceCny: 99, includedStores: 2, includedTasks: 100, paymentProvider: 'pending_provider', idempotencyKey: 'sub-key' }
    await repository.createOrder(input)

    await expect(repository.createOrder({ ...input, planCode: 'pro', planName: 'Pro', priceCny: 299 })).rejects.toBeInstanceOf(SubscriptionOrderIdempotencyConflictError)
  })
})
