import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { merchantFirstValuePreview, preflightUnboundContentPricing } from './mcp-first-value-preview.js'
import type { FirstValuePreviewRuntime } from './server.js'

describe('unbound text candidate pricing preflight', () => {
  it('does not require relay pricing in local test mode', async () => {
    await expect(preflightUnboundContentPricing({ production: false, workspaceId: 'ws_test' })).resolves.toBeUndefined()
  })

  it('blocks a production call before provider or point reservation when pricing is unavailable', async () => {
    await expect(preflightUnboundContentPricing({ production: true, workspaceId: 'ws_test', textModel: 'text-model' })).rejects.toMatchObject({
      code: 'MODEL_PRICING_PREFLIGHT_UNAVAILABLE',
      details: { provider_executed: false, points_reserved: false },
    })
  })

  it('checks the active model and preserves the pricing failure reason', async () => {
    const estimateRequestCost = vi.fn().mockRejectedValue(Object.assign(new Error('pricing timed out'), { code: 'MODEL_PRICING_FETCH_TIMEOUT' }))
    await expect(preflightUnboundContentPricing({ production: true, workspaceId: 'ws_test', textModel: 'qwen3.8-flash', relayPricing: { estimateRequestCost } })).rejects.toMatchObject({
      code: 'MODEL_PRICING_PREFLIGHT_UNAVAILABLE',
      details: { provider_executed: false, points_reserved: false, reason_code: 'MODEL_PRICING_FETCH_TIMEOUT' },
    })
    expect(estimateRequestCost).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_test', modality: 'text', model: 'qwen3.8-flash', inputTokens: 1, outputTokens: 1 }))
  })

  it('continues after a verified relay price estimate', async () => {
    const estimateRequestCost = vi.fn().mockResolvedValue({ costCny: 0.001 })
    await expect(preflightUnboundContentPricing({ production: true, workspaceId: 'ws_test', textModel: 'qwen3.8-flash', relayPricing: { estimateRequestCost } })).resolves.toBeUndefined()
    expect(estimateRequestCost).toHaveBeenCalledOnce()
  })

  it('stops the first-value handler before reservation, settlement, audit, or provider call when pricing times out', async () => {
    const pricingTimeout = Object.assign(new Error('pricing timed out'), { code: 'MODEL_PRICING_FETCH_TIMEOUT' })
    const estimateRequestCost = vi.fn().mockRejectedValue(pricingTimeout)
    const reserveCreativePointsForModel = vi.fn()
    const recordActionSettlement = vi.fn()
    const recordOperationAudit = vi.fn()
    const generate = vi.fn()
    const dependencies = {
      contentGenerator: { generate },
      requirePlatformModelCostGate: vi.fn(),
      createHash,
      enforceMcpCommercialAccess: vi.fn().mockResolvedValue({ classification: 'POINT_CHARGED' }),
      assertProviderActionCanStart: vi.fn(),
      reserveCreativePointsForModel,
      recordActionSettlement,
      requestActor: vi.fn(),
      recordOperationAudit,
      providerSucceededButSettlementPending: vi.fn(),
      persistence: {},
      unknownModelProviderReceipt: vi.fn(),
      releaseReservedModelPoints: vi.fn(),
      requireSettledContentExecutionEvidence: vi.fn(),
      validateContentSchema: vi.fn(),
      firstValueExecutionLabel: vi.fn(),
      firstValueNextActions: vi.fn(),
      isProduction: () => true,
      service: {},
      relayPricing: { estimateRequestCost },
      textModel: 'qwen3.8-flash',
    } as unknown as FirstValuePreviewRuntime

    await expect(merchantFirstValuePreview(
      'ws_test',
      { draft: 'true', idempotency_key: 'pricing-timeout-before-provider', draft_title: '候选文案' },
      {} as IncomingMessage,
      dependencies,
    )).rejects.toMatchObject({
      code: 'MODEL_PRICING_PREFLIGHT_UNAVAILABLE',
      details: { provider_executed: false, points_reserved: false, reason_code: 'MODEL_PRICING_FETCH_TIMEOUT' },
    })

    expect(reserveCreativePointsForModel).not.toHaveBeenCalled()
    expect(recordActionSettlement).not.toHaveBeenCalled()
    expect(recordOperationAudit).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })
})
