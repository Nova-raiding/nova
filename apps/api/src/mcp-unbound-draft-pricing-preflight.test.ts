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

  it('reports a settled model draft as a paid side effect, including actual usage and cost', async () => {
    const generate = vi.fn().mockResolvedValue({ title: '候选标题' })
    const requireSettledContentExecutionEvidence = vi.fn().mockResolvedValue({
      providerExecuted: true,
      providerRequestId: 'relay-request-1',
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      costCny: 0.0012,
      settlementStatus: 'settled',
    })
    const dependencies = {
      contentGenerator: { generate },
      requirePlatformModelCostGate: vi.fn(),
      createHash,
      enforceMcpCommercialAccess: vi.fn().mockResolvedValue({ classification: 'POINT_CHARGED' }),
      assertProviderActionCanStart: vi.fn(),
      reserveCreativePointsForModel: vi.fn().mockResolvedValue({ id: 'reservation-1' }),
      recordActionSettlement: vi.fn(),
      requestActor: vi.fn().mockReturnValue('merchant-test'),
      recordOperationAudit: vi.fn(),
      providerSucceededButSettlementPending: vi.fn(),
      persistence: {},
      unknownModelProviderReceipt: vi.fn(),
      releaseReservedModelPoints: vi.fn(),
      requireSettledContentExecutionEvidence,
      validateContentSchema: vi.fn().mockReturnValue({ title: '候选标题' }),
      firstValueExecutionLabel: vi.fn(),
      firstValueNextActions: vi.fn(),
      isProduction: () => true,
      service: {},
      relayPricing: { estimateRequestCost: vi.fn().mockResolvedValue({ costCny: 0.001 }) },
      textModel: 'qwen3.8-flash',
    } as unknown as FirstValuePreviewRuntime

    const result = await merchantFirstValuePreview('ws_test', {
      draft: 'true', idempotency_key: 'draft-cost-evidence-1', draft_title: '待审核商品草稿',
    }, {} as IncomingMessage, dependencies)

    expect(result).toMatchObject({
      readOnly: false, previewOnly: true, candidateOnly: true, publishable: false,
      execution: {
        mode: 'platform_relay_candidate', providerExecuted: true, modelCalled: true,
        providerRequestId: 'relay-request-1',
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        costCny: 0.0012, settlementStatus: 'settled',
      },
    })
    expect(generate).toHaveBeenCalledOnce()
    expect(requireSettledContentExecutionEvidence).toHaveBeenCalledOnce()
  })

  it('withholds a generated draft and moves its authorized action to pending_receipt when the receipt is missing', async () => {
    const evidenceError = Object.assign(new Error('provider response must not be logged'), {
      code: 'MODEL_RELAY_EVIDENCE_REQUIRED',
      details: { operation_status: 'pending_receipt', missing: ['provider_request_id', 'usage', 'cost_cny', 'settlement'] },
    })
    const generate = vi.fn().mockResolvedValue({ title: '不得返回的候选' })
    const transitionSettlementStatus = vi.fn().mockResolvedValue({ settlementStatus: 'pending_receipt' })
    const releaseReservedModelPoints = vi.fn()
    const validateContentSchema = vi.fn()
    const dependencies = {
      contentGenerator: { generate },
      requirePlatformModelCostGate: vi.fn(),
      createHash,
      enforceMcpCommercialAccess: vi.fn().mockResolvedValue({ classification: 'POINT_CHARGED' }),
      assertProviderActionCanStart: vi.fn(),
      reserveCreativePointsForModel: vi.fn().mockResolvedValue({ id: 'reservation-missing-receipt' }),
      recordActionSettlement: vi.fn(),
      requestActor: vi.fn().mockReturnValue('merchant-test'),
      recordOperationAudit: vi.fn(),
      providerSucceededButSettlementPending: vi.fn(),
      persistence: { actionLedger: { transitionSettlementStatus } },
      unknownModelProviderReceipt: vi.fn(),
      releaseReservedModelPoints,
      requireSettledContentExecutionEvidence: vi.fn().mockRejectedValue(evidenceError),
      validateContentSchema,
      firstValueExecutionLabel: vi.fn(),
      firstValueNextActions: vi.fn(),
      isProduction: () => true,
      service: {},
      relayPricing: { estimateRequestCost: vi.fn().mockResolvedValue({ costCny: 0.001 }) },
      textModel: 'qwen3.8-flash',
    } as unknown as FirstValuePreviewRuntime

    await expect(merchantFirstValuePreview('ws_test', {
      draft: 'true', idempotency_key: 'draft-missing-receipt', draft_title: '待审核商品草稿',
    }, {} as IncomingMessage, dependencies)).rejects.toBe(evidenceError)

    expect(transitionSettlementStatus).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws_test',
      actionKey: expect.stringMatching(/^content-draft:/u),
      from: ['authorized'],
      to: 'pending_receipt',
    }))
    expect(releaseReservedModelPoints).not.toHaveBeenCalled()
    expect(validateContentSchema).not.toHaveBeenCalled()
  })

  it('keeps receipt failure fail-closed and logs no provider error details if the pending transition fails', async () => {
    const evidenceError = Object.assign(new Error('provider response must not be logged'), { code: 'MODEL_RELAY_EVIDENCE_REQUIRED' })
    const transitionFailure = Object.assign(new Error('sensitive database detail'), { code: 'ACTION_LEDGER_UNAVAILABLE' })
    const transitionSettlementStatus = vi.fn().mockRejectedValue(transitionFailure)
    const releaseReservedModelPoints = vi.fn()
    const validateContentSchema = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dependencies = {
      contentGenerator: { generate: vi.fn().mockResolvedValue({ title: '不得返回的候选' }) },
      requirePlatformModelCostGate: vi.fn(),
      createHash,
      enforceMcpCommercialAccess: vi.fn().mockResolvedValue({ classification: 'POINT_CHARGED' }),
      assertProviderActionCanStart: vi.fn(),
      reserveCreativePointsForModel: vi.fn().mockResolvedValue({ id: 'reservation-transition-failure' }),
      recordActionSettlement: vi.fn(),
      requestActor: vi.fn().mockReturnValue('merchant-test'),
      recordOperationAudit: vi.fn(),
      providerSucceededButSettlementPending: vi.fn(),
      persistence: { actionLedger: { transitionSettlementStatus } },
      unknownModelProviderReceipt: vi.fn(),
      releaseReservedModelPoints,
      requireSettledContentExecutionEvidence: vi.fn().mockRejectedValue(evidenceError),
      validateContentSchema,
      firstValueExecutionLabel: vi.fn(),
      firstValueNextActions: vi.fn(),
      isProduction: () => true,
      service: {},
      relayPricing: { estimateRequestCost: vi.fn().mockResolvedValue({ costCny: 0.001 }) },
      textModel: 'qwen3.8-flash',
    } as unknown as FirstValuePreviewRuntime

    try {
      await expect(merchantFirstValuePreview('ws_test', {
        draft: 'true', idempotency_key: 'draft-transition-failure', draft_title: '待审核商品草稿',
      }, {} as IncomingMessage, dependencies)).rejects.toBe(evidenceError)
      expect(releaseReservedModelPoints).not.toHaveBeenCalled()
      expect(validateContentSchema).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('model settlement pending transition failed', expect.objectContaining({ code: 'ACTION_LEDGER_UNAVAILABLE' }))
      expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive database detail')
      expect(JSON.stringify(log.mock.calls)).not.toContain('provider response must not be logged')
    } finally {
      log.mockRestore()
    }
  })
})
