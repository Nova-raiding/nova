import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

describe('daily model budget provider boundary', () => {
  it('wraps every provider modality with budget reservation before invocation', () => {
    for (const [kind, provider] of [
      ['text', 'rawContentGenerator.generate'],
      ['image', 'rawImageGenerator.generate'],
      ['ocr', 'rawImageFactsExtractor.extract'],
      ['image_edit', 'rawImageEditGenerator.generate'],
      ['video', 'rawVideoGenerator.generate'],
    ] as const) expect(source).toContain(`withDailyModelBudget('${kind}', input.usageContext, () => ${provider}(`)
    expect(source).toContain('direction: appendProtectedProductConstraints(input.direction)')
    expect(source).toContain('await reserveDailyModelBudget(workspaceId, actionId, runKey, kind)')
    expect(source.indexOf('await reserveDailyModelBudget(workspaceId, actionId, runKey, kind)')).toBeLessThan(source.indexOf('try { return await invoke() }'))
    expect(source).toContain("if (!workspaceId || !actionId || !runKey) throw new DomainError('MODEL_COST_BUDGET_CONTEXT_REQUIRED'")
  })

  it('settles provider actuals and only releases failures that did not succeed upstream', () => {
    expect(source).toContain('recordUsageAndSettleBudget({ ...usageInput, budgetReservationKey: usage.actionId, budgetRunKey: usage.runKey!, costCny: usage.costCny')
    expect(source).toContain("...(usage.metadata || usage.runKey ? { metadata: { ...(usage.metadata ?? {}), ...(usage.runKey ? { run_key: usage.runKey } : {}) } } : {})")
    expect(source).not.toContain('const actionActualCostCny =')
    expect(source).toContain("if (!providerSucceededButSettlementPending(error)) await releaseDailyModelBudget(workspaceId, actionId)")
    expect(source).toContain("alertKey: `model-budget-overrun:${usage.actionId}`")
  })

  it('reserves async generation before context freezing and releases fixture completion', () => {
    expect(source).toContain("return isProduction() || process.env.LOCAL_COMPOSE === 'true'")
    expect(source).toContain('if (durableContentGenerationEnvironment()) {')
    const mcpCreate = source.slice(source.indexOf("case 'content.generate'"), source.indexOf("case 'content.codex.prepare'"))
    const restCreate = source.slice(source.indexOf("const generationJobCreateMatch"))
    for (const region of [mcpCreate, restCreate]) {
      expect(region).toContain('await reserveDailyModelBudget(')
      expect(region.indexOf('await reserveDailyModelBudget(')).toBeLessThan(region.indexOf('const prepared = await service.prepareGenerationContext'))
    }
    expect(source).toContain('await releaseDailyModelBudget(workspaceId, `model:generation:${completed.job.idempotencyKey}`)')
  })

  it('keeps synchronous multimodal, video plans, and image retries on their reserved run identity', () => {
    expect(source).toContain("const modelRunKey = request.value.modality === 'video' && request.value.output === 'rendering'")
    expect(source).toContain("const modelRunKey = request.value.output === 'rendering' ? `video:${walletDebitKey}` : walletDebitKey")
    expect(source).toContain('service.completeImageGeneration({ workspaceId, jobId: retried.job.id, runKey: imageRunKey })')
    expect(source).toContain('service.completeImageGeneration({ workspaceId, jobId: imageJob.id, runKey: modelRunKey })')
    expect(source).toContain('usageContext: { workspaceId, actionId: walletDebitKey, runKey: modelRunKey }')
  })

  it('authorizes entitlement-funded image calls on the provider action without a zero-value wallet debit', () => {
    expect(source).not.toContain('image-addon:')
    expect(source.match(/consumeEntitlement\(\{ workspaceId, kind: 'image_generation', actionKey: walletDebitKey, actionKind: 'model_image', modelRunKey:/gu)).toHaveLength(3)
    expect(source).toContain("settlement: 'entitlement', amountFen: 0, reservedAmountFen: 0")
    expect(source).toContain("const zeroCustomerChargeAuthorization = durableAuthorization?.settlement === 'entitlement' || durableAuthorization?.settlement === 'included_quota'")
    expect(source).toContain('const durableZeroChargeAuthorization = zeroCustomerChargeAuthorization ? durableAuthorization : undefined')
    expect(source).toContain('settleProviderUsage({ workspaceId: input.workspaceId, actionKey, actualAmountFen: 0')
    expect(source).toContain('await releaseDailyModelBudget(input.workspaceId, input.actionKey)')
    expect(source).not.toContain('amountFen: 0, idempotencyKey: walletDebitKey')
  })
})
