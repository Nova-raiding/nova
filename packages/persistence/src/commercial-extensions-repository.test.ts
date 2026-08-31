import { describe, expect, it } from 'vitest'
import { MemoryCommercialExtensionsRepository, PostgresCommercialExtensionsRepository, type SubscriptionChange, type SubscriptionPlanEntitlements } from './commercial-extensions-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: object[] }> = []

  enqueue(rows: object[] = []) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as unknown as { rows: T[] }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const dueChange: SubscriptionChange = {
  id: 'change_1', workspaceId: 'ws_downgrade', fromPlanCode: 'pro', toPlanCode: 'basic',
  fromPriceCny: 299, toPriceCny: 99, billingCycle: 'monthly', priceDifferenceCny: -200,
  effectiveAt: '2026-09-01T00:00:00.000Z', status: 'scheduled', reason: '下周期降级',
  createdBy: 'owner', createdAt: '2026-08-01T00:00:00.000Z',
}

const appliedSubscription: SubscriptionPlanEntitlements = {
  workspaceId: 'ws_downgrade', planCode: 'basic', planName: '基础版', billingCycle: 'monthly',
  priceCny: 99, includedStores: 1, includedTasks: 20,
  currentPeriodStart: '2026-09-01T00:00:00.000Z', currentPeriodEnd: '2026-10-01T00:00:00.000Z',
  revision: 4, updatedAt: '2026-09-01T00:00:01.000Z',
}

describe('model markup policy', () => {
  it('defaults to 2.5 and protects concurrent updates with a revision', async () => {
    const repository = new MemoryCommercialExtensionsRepository()
    const initial = await repository.getModelMarkupPolicy()
    expect(initial).toMatchObject({ multiplier: 2.5, revision: 1, updatedBy: 'system' })

    const updated = await repository.updateModelMarkupPolicy({ multiplier: 3, reason: '成本策略调整', updatedBy: 'finance_1', expectedRevision: initial.revision })
    expect(updated).toMatchObject({ multiplier: 3, revision: 2, reason: '成本策略调整', updatedBy: 'finance_1' })
    await expect(repository.updateModelMarkupPolicy({ multiplier: 4, reason: '过期修改', updatedBy: 'finance_2', expectedRevision: initial.revision })).rejects.toThrow('revision conflict')
  })
})

describe('scheduled subscription downgrade', () => {
  it('applies a due memory change once and updates plan entitlements together', async () => {
    const repository = new MemoryCommercialExtensionsRepository()
    await repository.upsertOffer({ code: 'pro', name: '专业版', billingCycle: 'monthly', priceCny: 299, includedStores: 5, includedTasks: 100, active: true, validFrom: '2026-01-01T00:00:00.000Z', updatedBy: 'ops' })
    await repository.upsertOffer({ code: 'basic', name: '基础版', billingCycle: 'monthly', priceCny: 99, includedStores: 1, includedTasks: 20, active: true, validFrom: '2026-01-01T00:00:00.000Z', updatedBy: 'ops' })
    const scheduled = await repository.scheduleChange({ ...dueChange })

    const [left, right] = await Promise.all([
      repository.applyDueSubscriptionChange({ workspaceId: dueChange.workspaceId, at: '2026-09-01T00:00:01.000Z' }),
      repository.applyDueSubscriptionChange({ workspaceId: dueChange.workspaceId, at: '2026-09-01T00:00:01.000Z' }),
    ])

    const applied = [left, right].filter((value): value is NonNullable<typeof value> => Boolean(value))
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({
      change: { id: scheduled.id, status: 'applied' },
      subscription: { planCode: 'basic', planName: '基础版', priceCny: 99, includedStores: 1, includedTasks: 20, revision: 2 },
    })
    await expect(repository.getPendingChange(dueChange.workspaceId)).resolves.toBeUndefined()
    await expect(repository.applyDueSubscriptionChange({ workspaceId: dueChange.workspaceId, at: '2026-09-01T00:00:02.000Z' })).resolves.toBeUndefined()
  })

  it('does not apply a memory change before its effective time', async () => {
    const repository = new MemoryCommercialExtensionsRepository()
    await repository.upsertOffer({ code: 'pro', name: '专业版', billingCycle: 'monthly', priceCny: 299, includedStores: 5, includedTasks: 100, active: true, validFrom: '2026-01-01T00:00:00.000Z', updatedBy: 'ops' })
    await repository.upsertOffer({ code: 'basic', name: '基础版', billingCycle: 'monthly', priceCny: 99, includedStores: 1, includedTasks: 20, active: true, validFrom: '2026-01-01T00:00:00.000Z', updatedBy: 'ops' })
    await repository.scheduleChange({ ...dueChange })
    await expect(repository.applyDueSubscriptionChange({ workspaceId: dueChange.workspaceId, at: '2026-08-31T23:59:59.999Z' })).resolves.toBeUndefined()
    await expect(repository.getPendingChange(dueChange.workspaceId)).resolves.toMatchObject({ status: 'scheduled' })
  })

  it('uses one SQL transaction, a row lock, and conditional scheduled-to-applied transition', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue([dueChange])
    client.enqueue([{ name: '基础版', includedStores: 1, includedTasks: 20 }])
    client.enqueue([appliedSubscription])
    client.enqueue([{ ...dueChange, status: 'applied' }])
    client.enqueue()
    const repository = new PostgresCommercialExtensionsRepository(new RecordingPool(client))

    await expect(repository.applyDueSubscriptionChange({ workspaceId: dueChange.workspaceId, at: appliedSubscription.updatedAt }))
      .resolves.toEqual({ change: { ...dueChange, status: 'applied' }, subscription: appliedSubscription })

    expect(client.calls.map(call => call.text)).toEqual([
      'BEGIN',
      "SELECT set_config('app.workspace_id', $1, true)",
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      expect.stringContaining('FROM commercial_offers'),
      expect.stringContaining('UPDATE workspace_subscriptions'),
      expect.stringContaining("SET status='applied'"),
      'COMMIT',
    ])
    expect(client.calls[2]?.text).toContain("status='scheduled' AND effective_at <= $2::timestamptz")
    expect(client.calls[4]?.text).toContain('included_stores=$6, included_tasks=$7')
    expect(client.calls[5]?.text).toContain("id=$2 AND status='scheduled'")
  })

  it('rolls back SQL when the subscription cannot be updated', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue([dueChange])
    client.enqueue([{ name: '基础版', includedStores: 1, includedTasks: 20 }])
    client.enqueue([])
    client.enqueue()
    const repository = new PostgresCommercialExtensionsRepository(new RecordingPool(client))

    await expect(repository.applyDueSubscriptionChange({ workspaceId: dueChange.workspaceId, at: appliedSubscription.updatedAt }))
      .rejects.toThrow('SUBSCRIPTION_DOWNGRADE_SUBSCRIPTION_NOT_FOUND')
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.calls.some(call => call.text.includes("SET status='applied'"))).toBe(false)
  })
})
