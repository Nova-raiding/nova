import { describe, expect, it } from 'vitest'
import { MemoryCommercialExtensionsRepository } from '../../persistence/src/commercial-extensions-repository.js'
import { executeScheduledSubscriptionDowngrades } from './subscription-downgrade-executor.js'

describe('subscription downgrade executor', () => {
  it('deduplicates workspace scans and applies only due scheduled changes', async () => {
    const repository = new MemoryCommercialExtensionsRepository()
    await repository.upsertOffer({ code: 'pro', name: '专业版', billingCycle: 'monthly', priceCny: 299, includedStores: 5, includedTasks: 100, active: true, validFrom: '2026-01-01T00:00:00.000Z', updatedBy: 'ops' })
    await repository.upsertOffer({ code: 'basic', name: '基础版', billingCycle: 'monthly', priceCny: 99, includedStores: 1, includedTasks: 20, active: true, validFrom: '2026-01-01T00:00:00.000Z', updatedBy: 'ops' })
    const common = { fromPlanCode: 'pro', toPlanCode: 'basic', fromPriceCny: 299, toPriceCny: 99, billingCycle: 'monthly' as const, priceDifferenceCny: -200, reason: '下周期降级', createdBy: 'owner' }
    await repository.scheduleChange({ ...common, workspaceId: 'ws_due', effectiveAt: '2026-09-01T00:00:00.000Z' })
    await repository.scheduleChange({ ...common, workspaceId: 'ws_later', effectiveAt: '2026-10-01T00:00:00.000Z' })

    const result = await executeScheduledSubscriptionDowngrades({ workspaceIds: ['ws_due', 'ws_due', ' ws_later ', ''], repository, at: new Date('2026-09-01T00:00:01.000Z') })

    expect(result).toMatchObject({ scanned: 2, applied: 1, skipped: 1, failed: 0, failures: [] })
    expect(result.applications[0]).toMatchObject({ change: { workspaceId: 'ws_due', status: 'applied' }, subscription: { planCode: 'basic', includedStores: 1, includedTasks: 20 } })
  })

  it('isolates a workspace failure so later downgrades still run', async () => {
    const calls: string[] = []
    const repository = {
      applyDueSubscriptionChange: async ({ workspaceId }: { workspaceId: string; at?: string }) => {
        calls.push(workspaceId)
        if (workspaceId === 'ws_bad') throw new Error('database unavailable')
        return undefined
      },
    }

    const result = await executeScheduledSubscriptionDowngrades({ workspaceIds: ['ws_bad', 'ws_ok'], repository, at: new Date('2026-09-01T00:00:01.000Z') })
    expect(calls).toEqual(['ws_bad', 'ws_ok'])
    expect(result).toMatchObject({ scanned: 2, applied: 0, skipped: 1, failed: 1, failures: [{ workspaceId: 'ws_bad', error: 'database unavailable' }] })
  })
})
