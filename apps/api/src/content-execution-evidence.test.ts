import { describe, expect, it } from 'vitest'
import type { ModelUsageRecord } from '../../../packages/persistence/src/model-usage-repository.js'
import { aggregateContentExecutionEvidence } from './content-execution-evidence.js'
const receipt = (change: Partial<ModelUsageRecord> = {}): ModelUsageRecord => ({ id: 'r1', workspaceId: 'ws', actionId: 'action', receiptKey: 'key1', receiptHash: 'hash', modality: 'text', model: 'model', providerRequestId: 'provider1', inputTokens: 358, outputTokens: 1707, totalTokens: 2065, costCny: 0.000642, settlementStatus: 'settled', attemptCount: 1, revision: 1, observedAt: '2026-10-05T01:53:20Z', ...change })
describe('text action execution evidence', () => {
  it('includes each structure repair receipt exactly once', () => {
    const first = receipt()
    const last = receipt({ id: 'r2', receiptKey: 'key2', providerRequestId: 'provider2', inputTokens: 470, outputTokens: 1870, totalTokens: 2340, costCny: 0.000710, observedAt: '2026-10-05T01:53:41Z' })
    expect(aggregateContentExecutionEvidence([first, last, first], 'action')).toMatchObject({ settled: true, providerRequestId: 'provider2', providerRequestCount: 2, costCny: 0.001352, usage: { inputTokens: 828, outputTokens: 3577, totalTokens: 4405 } })
  })
  it.each(['pending_cost', 'pending_wallet', 'manual_attention', 'waived'] as const)('does not hide an earlier %s receipt behind a settled final response', settlementStatus => {
    expect(aggregateContentExecutionEvidence([receipt({ settlementStatus }), receipt({ id: 'r2', receiptKey: 'key2', providerRequestId: 'provider2', observedAt: '2026-10-05T01:54:00Z' })], 'action')).toMatchObject({ settled: false, settlementStatus })
  })
  it('uses a newer revision of the same receipt without double counting', () => {
    expect(aggregateContentExecutionEvidence([receipt({ revision: 1, settlementStatus: 'pending_cost' }), receipt({ revision: 2 })], 'action')).toMatchObject({ settled: true, costCny: 0.000642, providerRequestCount: 1 })
  })
  it('fails closed for conflicting duplicate evidence and missing cost', () => {
    expect(aggregateContentExecutionEvidence([receipt(), receipt({ costCny: 1 })], 'action').settled).toBe(false)
    expect(aggregateContentExecutionEvidence([receipt({ costCny: undefined })], 'action').settled).toBe(false)
    expect(aggregateContentExecutionEvidence([], 'action').settled).toBe(false)
  })
  it('adds ledger micro-CNY without floating point drift', () => {
    expect(aggregateContentExecutionEvidence([receipt({ costCny: 0.1 }), receipt({ id: 'r2', receiptKey: 'key2', providerRequestId: 'p2', costCny: 0.2 })], 'action').costCny).toBe(0.3)
  })
  it('does not present incomplete token fields as action totals', () => {
    const result = aggregateContentExecutionEvidence([receipt(), receipt({ id: 'r2', receiptKey: 'key2', providerRequestId: 'p2', inputTokens: undefined })], 'action')
    expect(result.usage).not.toHaveProperty('inputTokens')
    expect(result.usage?.totalTokens).toBe(4130)
  })
})
