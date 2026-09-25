import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
const budgetSource = readFileSync(new URL('./model-budget-runtime.ts', import.meta.url), 'utf8')
const relayUsageSource = readFileSync(new URL('./model-relay-usage-runtime.ts', import.meta.url), 'utf8')
const reconciliationSource = readFileSync(new URL('./model-usage-reconciliation.ts', import.meta.url), 'utf8')
const imageHandlersSource = readFileSync(new URL('./mcp-image-handlers.ts', import.meta.url), 'utf8')
const multimodalHandlersSource = readFileSync(new URL('./mcp-multimodal-handlers.ts', import.meta.url), 'utf8')
const generationRoutesSource = readFileSync(new URL('./http-generation-job-create.ts', import.meta.url), 'utf8')

describe('daily model budget provider boundary', () => {
  it('wraps every provider modality with budget reservation before invocation', () => {
    for (const [kind, provider] of [
      ['text', 'rawContentGenerator.generate'],
      ['image', 'rawImageGenerator.generate'],
      ['ocr', 'rawImageFactsExtractor.extract'],
      ['image_edit', 'rawImageEditGenerator.generate'],
      ['video', 'rawVideoGenerator.generate'],
    ] as const) {
      if (kind === 'ocr') expect(source).toContain("withDailyModelBudget('ocr', input.usageContext, async () =>")
      else expect(source).toContain(`withDailyModelBudget('${kind}', input.usageContext, () => ${provider}(`)
    }
    expect(source).toContain('direction: appendProtectedProductConstraints(input.direction)')
    expect(source).toContain('createModelBudgetRuntime({')
    const budget = budgetSource.slice(budgetSource.indexOf('async function withDailyModelBudget'))
    const reserve = budget.indexOf('await reserveDailyModelBudget(workspaceId, actionId, runKey, kind)')
    const finalCheck = budget.indexOf('await deps.recheckBeforeProvider({ operation: kind, workspaceId }, false)')
    const invoke = budget.indexOf('return await invoke()')
    expect(reserve).toBeGreaterThanOrEqual(0)
    expect(finalCheck).toBeGreaterThan(reserve)
    expect(invoke).toBeGreaterThan(finalCheck)
    expect(budgetSource).toContain("if (!workspaceId || !actionId || !runKey) throw new DomainError('MODEL_COST_BUDGET_CONTEXT_REQUIRED'")
  })

  it('settles provider actuals and only releases failures that did not succeed upstream', () => {
    expect(source).toContain('createRelayUsageRuntime({')
    expect(relayUsageSource).toContain('recordUsageAndSettleBudget({ ...usageInput, budgetReservationKey: usage.actionId, budgetRunKey: usage.runKey!, costCny: usage.costCny')
    expect(relayUsageSource).toContain("...(usage.metadata || usage.runKey ? { metadata: { ...(usage.metadata ?? {}), ...(usage.runKey ? { run_key: usage.runKey } : {}) } } : {})")
    expect(relayUsageSource).not.toContain('const actionActualCostCny =')
    expect(budgetSource).toContain("if (!deps.providerSucceededButSettlementPending(error)) await releaseDailyModelBudget(workspaceId, actionId)")
    expect(relayUsageSource).toContain("alertKey: `model-budget-overrun:${usage.actionId}`")
  })

  it('preserves synchronous content point reservations when provider outcome needs reconciliation', () => {
    const handler = source.slice(source.indexOf("case 'content.generate':"), source.indexOf("case 'content.codex.prepare':"))
    const catchBranch = handler.match(/try \{ draft = await service\.generateDraft\(task\.id, undefined, `model:\$\{usageKey\}`\) \} catch \(error\) \{([^\n]+)\}/u)?.[1]
    expect(catchBranch).toMatch(/if \(providerSucceededButSettlementPending\(error\)\) await markTaskUsageProviderOutcomePending\(workspaceId, usageKey\); else \{ await releaseReservedModelPoints\(/u)
  })

  it('keeps image retry, edit, multimodal and video point releases behind a known-failure guard', () => {
    for (const reason of ['图片安全重试失败', '图片编辑失败', '多模态生成失败', '视频生成失败']) {
      const release = `await releaseReservedModelPoints(workspaceId, walletDebitKey, '${reason}'`
      const region = imageHandlersSource.includes(release) ? imageHandlersSource : multimodalHandlersSource.includes(release) ? multimodalHandlersSource : source
      const releaseAt = region.indexOf(release)
      expect(releaseAt, reason).toBeGreaterThanOrEqual(0)
      const branch = region.slice(region.lastIndexOf('} catch (error) {', releaseAt), region.indexOf('throw error', releaseAt))
      expect(branch, reason).toContain('if (!providerSucceededButSettlementPending(error)) {')
      expect(branch.indexOf('if (!providerSucceededButSettlementPending(error)) {'), reason).toBeLessThan(branch.indexOf(release))
    }
  })

  it('does not refund a successful provider call when multimodal or video event persistence fails', () => {
    for (const reason of ['多模态结果记录失败', '视频结果记录失败']) {
      const refund = `await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '${reason}' })`
      const region = multimodalHandlersSource.includes(refund) ? multimodalHandlersSource : source
      const refundAt = region.indexOf(refund)
      expect(refundAt, reason).toBeGreaterThanOrEqual(0)
      const branch = region.slice(region.lastIndexOf('} catch (error) {', refundAt), region.indexOf('throw error', refundAt))
      expect(branch, reason).toContain(`if (!providerExecuted) ${refund}`)
    }
  })

  it('reserves async generation before enqueue and releases fixture completion', () => {
    expect(source).toContain("return isProduction() || process.env.LOCAL_COMPOSE === 'true'")
    expect(source).toContain('if (durableContentGenerationEnvironment()) {')
    const mcpCreate = source.slice(source.indexOf("case 'content.generate'"), source.indexOf("case 'content.codex.prepare'"))
    const restCreate = generationRoutesSource.slice(generationRoutesSource.indexOf("const generationJobCreateMatch"))
    const mcpPrepare = mcpCreate.indexOf('const prepared = await service.prepareGenerationContext')
    const mcpReserve = mcpCreate.indexOf('await reserveDailyModelBudget(')
    const mcpEnqueue = mcpCreate.indexOf('const job = service.enqueueGeneration(')
    expect(mcpPrepare).toBeGreaterThanOrEqual(0)
    expect(mcpReserve).toBeGreaterThan(mcpPrepare)
    expect(mcpEnqueue).toBeGreaterThan(mcpReserve)
    const restReserve = restCreate.indexOf('await reserveDailyModelBudget(')
    const restPrepare = restCreate.indexOf('const prepared = await service.prepareGenerationContext')
    const restEnqueue = restCreate.indexOf('const job = service.enqueueGeneration(')
    expect(restReserve).toBeGreaterThanOrEqual(0)
    expect(restPrepare).toBeGreaterThan(restReserve)
    expect(restEnqueue).toBeGreaterThan(restPrepare)
    expect(source).toContain('await releaseDailyModelBudget(workspaceId, `model:generation:${completed.job.idempotencyKey}`)')
  })

  it('keeps synchronous multimodal, video plans, and image retries on their reserved run identity', () => {
    expect(multimodalHandlersSource).toContain("const modelRunKey = request.value.modality === 'video' && request.value.output === 'rendering'")
    expect(multimodalHandlersSource).toContain("const modelRunKey = request.value.output === 'rendering' ? `video:${walletDebitKey}` : walletDebitKey")
    expect(imageHandlersSource).toMatch(/service\.completeImageGeneration\(\{ workspaceId, jobId: retried\.job\.id, runKey: imageRunKey(?:,|\s*\})/u)
    expect(multimodalHandlersSource).toMatch(/service\.completeImageGeneration\(\{ workspaceId, jobId: imageJob\.id, runKey: modelRunKey(?:,|\s*\})/u)
    expect(multimodalHandlersSource).toContain('usageContext: { workspaceId, actionId: walletDebitKey, runKey: modelRunKey }')
  })

  it('keeps legacy image entitlement as read-only shadow and retains historical settlement compatibility', () => {
    expect(source).not.toContain('image-addon:')
    expect((source + imageHandlersSource).match(/observeLegacyImageEntitlementShadow\(\{ workspaceId, kind: 'image_generation' \}\)/gu)).toHaveLength(3)
    expect(source).not.toContain('consumeEntitlement(')
    expect(source).not.toContain('debitPluginWallet(')
    expect(relayUsageSource).toContain("const zeroCustomerChargeAuthorization = durableAuthorization?.settlement === 'included_quota' || durableAuthorization?.settlement === 'entitlement'")
    expect(relayUsageSource).toContain('if (usage.costCny === undefined && relayPricing)')
    expect(relayUsageSource).toContain('if (usage.costCny === undefined)')
    expect(reconciliationSource).toContain("action.settlement === 'entitlement' || action.settlement === 'included_quota'")
    expect(relayUsageSource).toContain('const durableZeroChargeAuthorization = zeroCustomerChargeAuthorization ? durableAuthorization : undefined')
    expect(reconciliationSource).toContain('settleProviderUsage({ workspaceId: input.workspaceId, actionKey, actualAmountFen: 0')
    expect(source).toContain('await releaseDailyModelBudget(input.workspaceId, input.actionKey)')
    expect(source).not.toContain('amountFen: 0, idempotencyKey: walletDebitKey')
  })
})
