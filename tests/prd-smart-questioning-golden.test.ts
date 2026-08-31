import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MerchantService, type Task, type TaskQuestion } from '../packages/application/src/service.js'

interface GoldenScenario {
  id: string
  setup: 'base' | 'facts_unconfirmed' | 'multi_sku' | 'authorization_revoked' | 'authorization_refresh' | 'expired_rule' | 'zero_stock' | 'defer_flow' | 'restore_flow' | 'answer_flow' | 'brand_default'
  requestText: string
  answers?: Record<string, string | number | boolean | string[]>
  expectedPresent?: string[]
  expectedAbsent?: string[]
  expectedAbsentPrefixes?: string[]
  expectedBlocking?: string[]
  expectedBlockingPrefixes?: string[]
  minimumIntentBlocking?: number
  expectedMax?: number
  structuredIntentMax?: number
}

const scenarios = JSON.parse(readFileSync(new URL('./fixtures/prd-smart-questioning-golden.json', import.meta.url), 'utf8')) as GoldenScenario[]
const kindRank: Record<TaskQuestion['kind'], number> = { blocking: 0, recommended: 1, optional: 2 }

interface ScenarioResult {
  service: MerchantService
  workspaceId: string
  product: ReturnType<MerchantService['importProduct']>
  task: Task
  rounds: TaskQuestion[][]
}

function buildScenario(scenario: GoldenScenario): ScenarioResult {
  const workspaceId = `ws_golden_${scenario.id}`
  let service = new MerchantService({ seedFixture: false, fixtureMode: true })
  let account: ReturnType<MerchantService['registerPlatformAccount']> | undefined
  if (scenario.setup === 'authorization_revoked' || scenario.setup === 'authorization_refresh') {
    account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `store-${scenario.id}`, credentialRef: `vault://${scenario.id}`, accessTokenExpiresAt: '2026-01-01T00:00:00Z' })
    if (scenario.setup === 'authorization_revoked') service.revokePlatformAccount(workspaceId, account.id, 'taobao')
    else account.tokenState = 'refresh_required'
  }
  const multiSku = scenario.setup === 'multi_sku'
  const product = service.importProduct({
    workspaceId,
    platform: 'taobao',
    ...(account ? { accountId: account.id } : {}),
    remoteId: `remote-${scenario.id}`,
    title: `黄金商品 ${scenario.id}`,
    stock: scenario.setup === 'zero_stock' ? 0 : 20,
    price: 99,
    skus: multiSku
      ? [{ id: 'sku-a', name: '白色', price: 99, stock: 10 }, { id: 'sku-b', name: '黑色', price: 109, stock: 10 }]
      : [{ id: 'sku-a', name: '标准款', price: 99, stock: scenario.setup === 'zero_stock' ? 0 : 20 }],
  })
  if (scenario.setup !== 'facts_unconfirmed') service.confirmProductFacts(workspaceId, product.id)
  if (scenario.setup === 'brand_default') service.upsertBrandProfile({ workspaceId, name: '云岚', audience: '城市通勤女性' })
  if (scenario.setup === 'expired_rule') {
    const rule = service.publishRuleVersion({ packId: `expired-${scenario.id}`, name: '过期黄金规则', version: '1', scope: 'global', effectiveTo: '2026-01-01T00:00:00Z', source: { kind: 'official', reference: `golden://${scenario.id}`, checkedAt: '2025-12-01T00:00:00Z' }, checks: { forbiddenTerms: ['过期表达'] }, actorId: 'golden-evaluator', reason: '黄金评测规则冲突' })
    service.setRuleStatus({ packId: `expired-${scenario.id}`, version: rule.version, status: 'active', actorId: 'golden-evaluator', reason: '启用过期规则验证 fail-closed' })
  }

  let task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', ...(account ? { accountId: account.id } : {}), requestText: scenario.requestText, ...(scenario.answers ? { answers: scenario.answers } : {}) })
  const rounds: TaskQuestion[][] = [structuredClone(task.missingQuestions)]
  if (scenario.setup === 'defer_flow' || scenario.setup === 'restore_flow') {
    task = service.answerTask(workspaceId, task.id, { defer_questions: ['goal', 'audience'] }, task.version)
    rounds.push(structuredClone(task.missingQuestions))
    if (scenario.setup === 'restore_flow') {
      const restarted = new MerchantService({ seedFixture: false, fixtureMode: true })
      restarted.hydrateSnapshot({ entityType: 'product', entity: structuredClone(product) })
      restarted.hydrateSnapshot({ entityType: 'task', entity: structuredClone(task) })
      service = restarted
      task = restarted.getTask(task.id)
      rounds.push(structuredClone(task.missingQuestions))
    }
  } else if (scenario.setup === 'answer_flow') {
    task = service.answerTask(workspaceId, task.id, { goal: '提升转化', audience: '城市通勤女性' }, task.version)
    rounds.push(structuredClone(task.missingQuestions))
  }
  return { service, workspaceId, product, task, rounds }
}

function questionProjection(rounds: readonly TaskQuestion[][]) {
  return rounds.map(round => round.map(question => ({ id: question.id, kind: question.kind, prompt: question.prompt, why: question.why, ifSkipped: question.ifSkipped, field: question.field, candidates: question.candidates })))
}

function assertRoundInvariants(scenario: GoldenScenario, questions: readonly TaskQuestion[]) {
  const urgent = /紧急|马上|尽快|急|today|asap|urgent/iu.test(scenario.requestText)
  const defaultMax = scenario.expectedMax ?? (urgent ? 3 : 4)
  const intentBlocking = questions.filter(question => question.kind === 'blocking' && question.id.startsWith('merchant_intent_')).length
  const allowedMax = intentBlocking > defaultMax ? Math.min(scenario.structuredIntentMax ?? 8, intentBlocking) : defaultMax
  expect(questions.length, `${scenario.id}: question cap`).toBeLessThanOrEqual(allowedMax)
  expect(allowedMax, `${scenario.id}: explicit absolute cap`).toBeLessThanOrEqual(scenario.structuredIntentMax ?? 8)
  expect(new Set(questions.map(question => question.id)).size, `${scenario.id}: duplicate question id`).toBe(questions.length)
  expect(questions.every(question => question.prompt.trim() && question.why.trim() && question.ifSkipped.trim()), `${scenario.id}: explanations`).toBe(true)
  for (let index = 1; index < questions.length; index += 1) expect(kindRank[questions[index - 1]!.kind], `${scenario.id}: kind ordering`).toBeLessThanOrEqual(kindRank[questions[index]!.kind])
}

describe('PRD smart-questioning golden evaluation', () => {
  it('covers at least 20 real MerchantService scenarios with deterministic bounded rounds', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20)
    for (const scenario of scenarios) {
      const first = buildScenario(scenario)
      const second = buildScenario(scenario)
      expect(questionProjection(second.rounds), `${scenario.id}: deterministic recomputation`).toEqual(questionProjection(first.rounds))
      first.rounds.forEach(round => assertRoundInvariants(scenario, round))

      const finalIds = first.task.missingQuestions.map(question => question.id)
      for (const id of scenario.expectedPresent ?? []) expect(finalIds, `${scenario.id}: expected ${id}`).toContain(id)
      for (const id of scenario.expectedAbsent ?? []) expect(finalIds, `${scenario.id}: unexpected ${id}`).not.toContain(id)
      for (const prefix of scenario.expectedAbsentPrefixes ?? []) expect(finalIds.some(id => id.startsWith(prefix)), `${scenario.id}: unexpected prefix ${prefix}`).toBe(false)
      if (scenario.minimumIntentBlocking !== undefined) expect(first.task.missingQuestions.filter(question => question.kind === 'blocking' && question.id.startsWith('merchant_intent_')).length, `${scenario.id}: intent blockers`).toBeGreaterThanOrEqual(scenario.minimumIntentBlocking)
    }
  })

  it('reports zero P0 misses and zero false blocking questions', () => {
    const misses: Array<{ scenario: string; question: string }> = []
    const falseBlocks: Array<{ scenario: string; question: string }> = []
    let expectedP0 = 0
    let detectedP0 = 0
    let rounds = 0
    for (const scenario of scenarios) {
      const result = buildScenario(scenario)
      rounds += result.rounds.length
      const blockingIds = result.task.missingQuestions.filter(question => question.kind === 'blocking').map(question => question.id)
      for (const expected of scenario.expectedBlocking ?? []) {
        expectedP0 += 1
        if (blockingIds.includes(expected)) detectedP0 += 1
        else misses.push({ scenario: scenario.id, question: expected })
      }
      if (scenario.minimumIntentBlocking !== undefined) {
        expectedP0 += scenario.minimumIntentBlocking
        const found = blockingIds.filter(id => id.startsWith('merchant_intent_')).length
        detectedP0 += Math.min(found, scenario.minimumIntentBlocking)
        for (let index = found; index < scenario.minimumIntentBlocking; index += 1) misses.push({ scenario: scenario.id, question: `merchant_intent_${index + 1}` })
      }
      const allowedIds = new Set(scenario.expectedBlocking ?? [])
      const allowedPrefixes = scenario.expectedBlockingPrefixes ?? []
      for (const id of blockingIds) if (!allowedIds.has(id) && !allowedPrefixes.some(prefix => id.startsWith(prefix))) falseBlocks.push({ scenario: scenario.id, question: id })
    }
    const statistics = { scenarios: scenarios.length, rounds, expectedP0, detectedP0, p0Misses: misses.length, falseBlocking: falseBlocks.length, misses, falseBlocks }
    console.info(`SMART_QUESTIONING_GOLDEN ${JSON.stringify(statistics)}`)
    expect(statistics.p0Misses).toBe(0)
    expect(statistics.falseBlocking).toBe(0)
  })

  it('never allows a blocking question to be deferred', () => {
    const blockingScenarios = scenarios.filter(scenario => (scenario.expectedBlocking?.length ?? 0) > 0 || scenario.minimumIntentBlocking !== undefined)
    expect(blockingScenarios.length).toBeGreaterThan(0)
    for (const scenario of blockingScenarios) {
      const result = buildScenario(scenario)
      const blocker = result.task.missingQuestions.find(question => question.kind === 'blocking')
      expect(blocker, `${scenario.id}: blocker exists`).toBeDefined()
      expect(() => result.service.answerTask(result.workspaceId, result.task.id, { defer_questions: [blocker!.id] }, result.task.version), `${scenario.id}: blocker cannot defer`).toThrowError(expect.objectContaining({ code: 'TASK_BLOCKING_QUESTION_REQUIRED' }))
    }
  })

  it('preserves deferred state across restart and lets explicit answers remove questions', () => {
    const deferred = buildScenario(scenarios.find(scenario => scenario.id === 'deferred-questions')!)
    expect(deferred.task.deferredQuestionIds).toEqual(['goal', 'audience'])
    expect(deferred.task.deferredQuestions.every(question => question.why.trim() && question.ifSkipped.trim())).toBe(true)

    const restored = buildScenario(scenarios.find(scenario => scenario.id === 'restored-session')!)
    expect(restored.task.deferredQuestionIds).toEqual(['goal', 'audience'])
    expect(restored.rounds.at(-1)).toEqual(restored.rounds.at(-2))

    const answered = buildScenario(scenarios.find(scenario => scenario.id === 'explicit-answer-eliminates')!)
    expect(answered.task.answers).toMatchObject({ goal: '提升转化', audience: '城市通勤女性' })
    expect(answered.task.missingQuestions.map(question => question.id)).toEqual(expect.not.arrayContaining(['goal', 'audience']))
    expect(answered.task.deferredQuestionIds).toEqual([])
  })

  it('gives explicit answers priority and never guesses protected facts or campaign audience', () => {
    const unconfirmed = buildScenario(scenarios.find(scenario => scenario.id === 'facts-unconfirmed')!)
    expect(unconfirmed.task.answers.confirm_facts).toBeUndefined()
    expect(unconfirmed.task.state).toBe('draft')

    const sku = buildScenario(scenarios.find(scenario => scenario.id === 'multi-sku-missing')!)
    expect(sku.task.answers.sku_id).toBeUndefined()

    const ambiguous = buildScenario(scenarios.find(scenario => scenario.id === 'structured-intent-ambiguity')!)
    expect(ambiguous.task.answers.merchant_intent_json).toBeUndefined()
    expect(ambiguous.task.state).toBe('draft')

    const explicitIntent = buildScenario(scenarios.find(scenario => scenario.id === 'structured-intent-explicit-answer')!)
    expect(explicitIntent.task.answers.price_policy).toBe('商家确认会员价 88 元')
    expect(explicitIntent.task.missingQuestions.some(question => question.id.startsWith('merchant_intent_'))).toBe(false)

    const brandDefault = buildScenario(scenarios.find(scenario => scenario.id === 'brand-default-audience')!)
    expect(brandDefault.task.answers.audience).toBe('城市通勤女性')
    const pendingCampaign = buildScenario(scenarios.find(scenario => scenario.id === 'campaign-audience-pending')!)
    expect(pendingCampaign.task.answers.audience).toBeUndefined()
    expect(pendingCampaign.task.missingQuestions).toContainEqual(expect.objectContaining({ id: 'audience', kind: 'recommended' }))
    const explicitCampaign = buildScenario(scenarios.find(scenario => scenario.id === 'campaign-audience-explicit')!)
    expect(explicitCampaign.task.answers.audience).toBe('大学生')
  })
})
