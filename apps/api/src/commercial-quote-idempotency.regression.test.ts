import { describe, expect, it, vi } from 'vitest'
import { CommercialContractError } from '../../../packages/persistence/src/commercial-contract-repository.js'
import { handleCommercialMcpMethod, type CommercialMcpDependencies } from './mcp-commercial-handlers.js'

describe('commercial upgrade quote idempotency contract', () => {
  it('rejects reuse of a quote key for another target through the public MCP error contract', async () => {
    const createUpgradeQuote = vi.fn(async (input: { targetSkuCode: string; idempotencyKey: string }) => {
      if (input.idempotencyKey === 'upgrade-quote-request-1' && input.targetSkuCode !== 'growth') {
        throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'quote key reused: private persistence detail')
      }
      return {
        id: 'quote-growth-1', workspaceId: 'workspace-1', sourceOrderId: 'order-current',
        sourcePeriodId: 'period-current', sourcePeriodRevision: '7', sourceEntitlementId: 'entitlement-current',
        sourceSkuCode: 'basic', targetSkuCode: input.targetSkuCode, targetSkuVersionId: `${input.targetSkuCode}-v1`,
        currentCyclePriceFen: 200000, targetCyclePriceFen: 500000, amountFen: 150000, currency: 'CNY',
        periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
        quotedAt: '2026-10-05T00:00:00.000Z', expiresAt: '2026-10-05T01:00:00.000Z',
        remainingMs: 1000000, totalMs: 2000000, benefitIncrements: [], priceNumerator: '1', priceDenominator: '2',
      }
    })
    const deps = {
      ready: Promise.resolve(),
      persistence: { commercialContracts: { createUpgradeQuote } },
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      actor: () => 'actor-1',
    } as unknown as CommercialMcpDependencies

    await expect(handleCommercialMcpMethod('commercial.upgrade.quote.create', {
      target_sku_code: 'growth', idempotency_key: 'upgrade-quote-request-1',
    }, 'workspace-1', { headers: {} } as never, deps)).resolves.toMatchObject({
      upgrade_quote_id: 'quote-growth-1', target_sku_code: 'growth', amount_fen: 150000,
    })

    await expect(handleCommercialMcpMethod('commercial.upgrade.quote.create', {
      target_sku_code: 'premium', idempotency_key: 'upgrade-quote-request-1',
    }, 'workspace-1', { headers: {} } as never, deps)).rejects.toMatchObject({
      code: 'COMMERCIAL_IDEMPOTENCY_CONFLICT', status: 409,
      message: '该请求编号已用于其他升级意图，请查询原请求或更换请求编号',
    })
    expect(createUpgradeQuote).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-1', actorId: 'actor-1', targetSkuCode: 'premium', idempotencyKey: 'upgrade-quote-request-1',
    })
    expect(createUpgradeQuote.mock.calls[1]?.[0]).not.toHaveProperty('workspaceId', 'another-workspace')
  })
})
