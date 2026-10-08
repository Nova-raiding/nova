import { describe, expect, it, vi } from 'vitest'
import type { CommercialUpgradeQuoteV3 } from '../../../packages/persistence/src/commercial-transaction-repository.js'
import { handleCommercialMcpMethod, type CommercialMcpDependencies } from './mcp-commercial-handlers.js'

const quote = {
  id: 'quote-frozen-v1', workspaceId: 'workspace-1', actorId: 'actor-1',
  sourceOrderId: 'order-source', sourcePeriodId: 'period-source', sourcePeriodRevision: 4,
  sourceEntitlementId: 'entitlement-source', sourceSkuCode: 'basic', targetSkuCode: 'growth',
  targetSkuVersionId: 'growth-v1', currentCyclePriceFen: 150000, targetCyclePriceFen: 300000,
  amountFen: 75000, currency: 'CNY', periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z', quotedAt: '2026-10-16T12:00:00.000Z',
  expiresAt: '2026-10-16T12:05:00.000Z', remainingMs: 1_296_000_000, totalMs: 2_678_400_000,
  priceNumerator: '7500000000000', priceDenominator: '100000000', algorithmVersion: 'remaining-period-v1',
  benefitIncrements: [{ code: 'creative_points', quantity: 2500, sourceQuantity: 5000, targetQuantity: 10000, exactNumerator: '250000000000', exactDenominator: '100000000' }],
  resolvedTargetBenefits: [{ code: 'creative_points', quantity: 10000 }],
  sourceSnapshot: { code: 'basic', internal_policy: 'private-source-snapshot' },
  targetSnapshot: { code: 'growth', internal_policy: 'private-target-snapshot' },
} as unknown as CommercialUpgradeQuoteV3

describe('commercial quote API frozen-price projection', () => {
  it('returns the immutable historical quote snapshot without exposing internal catalog snapshots', async () => {
    const getUpgradeQuote = vi.fn(async () => quote)
    const deps = {
      ready: Promise.resolve(),
      persistence: { commercialContracts: { getUpgradeQuote } },
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      actor: () => 'actor-1',
    } as unknown as CommercialMcpDependencies

    const result = await handleCommercialMcpMethod('commercial.upgrade.quote.get', {
      upgrade_quote_id: quote.id,
    }, quote.workspaceId, { headers: {} } as never, deps) as Record<string, unknown>

    expect(getUpgradeQuote).toHaveBeenCalledWith(quote.workspaceId, quote.id)
    expect(result).toMatchObject({
      upgrade_quote_id: quote.id,
      source_period_revision: 4,
      current_cycle_price_fen: 150000,
      target_cycle_price_fen: 300000,
      amount_fen: 75000,
      price_numerator: '7500000000000',
      price_denominator: '100000000',
      algorithm_version: 'remaining-period.v1',
      benefit_increments: { creative_points: 2500 },
    })
    expect(result).not.toHaveProperty('actor_id')
    expect(result).not.toHaveProperty('source_snapshot')
    expect(result).not.toHaveProperty('target_snapshot')
    expect(JSON.stringify(result)).not.toContain('private-source-snapshot')
    expect(JSON.stringify(result)).not.toContain('private-target-snapshot')
  })
})
