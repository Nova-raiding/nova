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
    expect(source.indexOf('await reserveDailyModelBudget(workspaceId, actionId, kind)')).toBeLessThan(source.indexOf('try { return await invoke() }'))
  })

  it('settles provider actuals and only releases failures that did not succeed upstream', () => {
    expect(source).toContain('reservationKey: usage.actionId, actualCostCny: actionActualCostCny')
    expect(source).toContain('providerRequestId: usage.providerRequestId')
    expect(source).toContain("if (!providerSucceededButSettlementPending(error)) await releaseDailyModelBudget(workspaceId, actionId)")
    expect(source).toContain("alertKey: `model-budget-overrun:${usage.actionId}`")
  })

  it('reserves async generation before context freezing and releases fixture completion', () => {
    const mcpCreate = source.slice(source.indexOf("case 'content.generate'"), source.indexOf("case 'content.codex.prepare'"))
    const restCreate = source.slice(source.indexOf("const generationJobCreateMatch"))
    for (const region of [mcpCreate, restCreate]) {
      expect(region).toContain('await reserveDailyModelBudget(')
      expect(region.indexOf('await reserveDailyModelBudget(')).toBeLessThan(region.indexOf('const prepared = await service.prepareGenerationContext'))
    }
    expect(source).toContain('await releaseDailyModelBudget(workspaceId, `model:generation:${completed.job.idempotencyKey}`)')
  })
})
