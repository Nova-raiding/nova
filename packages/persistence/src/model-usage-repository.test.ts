import { describe, expect, it } from 'vitest'
import { allowedModelUsageSettlementDecisions, MemoryModelUsageRepository } from './model-usage-repository.js'

describe('MemoryModelUsageRepository', () => {
  it('defines the authoritative operations decisions for each settlement state', () => {
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'pending_cost' })).toEqual(['waive', 'manual_attention'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'pending_wallet', costCny: 0.02, customerChargeCny: 0.05 })).toEqual(['retry', 'manual_attention'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'pending_wallet', costCny: 0.02 })).toEqual(['manual_attention'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'manual_attention' })).toEqual(['waive'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'manual_attention', costCny: 0.02, customerChargeCny: 0.05 })).toEqual(['retry'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'settled', costCny: 0.02, customerChargeCny: 0.05 })).toEqual([])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'waived' })).toEqual([])
  })

  it('deduplicates exact callbacks, rejects conflicting receipts, and scopes records by workspace', async () => {
    const repository = new MemoryModelUsageRepository()
    const first = await repository.record({ workspaceId: 'ws_usage', actionId: 'task_1', modality: 'text', model: 'relay-text', providerRequestId: 'req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.01, markupMultiplier: 2.5, customerChargeCny: 0.025, pricingPolicyRevision: 1 })
    const replay = await repository.record({ workspaceId: 'ws_usage', actionId: 'task_1', modality: 'text', model: 'relay-text', providerRequestId: 'req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.01 })
    expect(replay).toEqual(first)
    await expect(repository.record({ workspaceId: 'ws_usage', actionId: 'other_task', modality: 'text', model: 'relay-text', providerRequestId: 'req_1', totalTokens: 198, costCny: 9 })).rejects.toThrow('MODEL_USAGE_IDEMPOTENCY_CONFLICT')
    expect(first.customerChargeCny).toBe(0.025)
    expect(await repository.list('ws_usage')).toHaveLength(1)
    expect(await repository.list('ws_other')).toHaveLength(0)
  })

  it('fills a pending-cost receipt once and exposes it to the wallet settlement queue', async () => {
    const repository = new MemoryModelUsageRepository()
    const pending = await repository.record({ workspaceId: 'ws_pending', actionId: 'task_pending', modality: 'text', model: 'relay-text', providerRequestId: 'req_pending', totalTokens: 12 })
    expect(pending.settlementStatus).toBe('pending_cost')
    const completedReceipt = await repository.record({ workspaceId: 'ws_pending', actionId: 'task_pending', modality: 'text', model: 'relay-text', providerRequestId: 'req_pending', totalTokens: 12, costCny: 0.02, settlementStatus: 'pending_wallet' })
    expect(completedReceipt).toMatchObject({ costCny: 0.02, settlementStatus: 'pending_wallet', revision: 2 })
    const claimed = await repository.claimPending({ workspaceId: 'ws_pending', owner: 'worker-1' })
    expect(claimed[0]).toMatchObject({ id: pending.id, claimOwner: 'worker-1', attemptCount: 1 })
    const claimedRevision = claimed[0]!.revision
    const settled = await repository.resolve({ workspaceId: 'ws_pending', id: pending.id, expectedRevision: claimedRevision, status: 'settled', actorId: 'worker-1', reason: '钱包与行动账本已结算', evidenceRef: 'relay://req_pending' })
    expect(settled).toMatchObject({ settlementStatus: 'settled', resolvedBy: 'worker-1', revision: claimedRevision + 1 })
  })
})
