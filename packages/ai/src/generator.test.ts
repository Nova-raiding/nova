import { describe, expect, it } from 'vitest'
import { budgetContentGenerationInput, OpenAICompatibleContentGenerator, createContentGeneratorFromEnv, resolveTokenBudget } from './generator.js'

describe('content generator', () => {
  it('calls an OpenAI-compatible provider and validates structured output', async () => {
    const calls: RequestInit[] = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      fetch: async (_url, init = {}) => { calls.push(init); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '合规标题', detail: '商品详情', sellingPoints: ['事实卖点'] }) } }] }), { status: 200 }) },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, brandVisualRules: { restrictedSubjects: { people: ['某艺人'], spokespersons: [], intellectualProperties: ['未授权动漫角色'], prohibitedContent: [] } } })).resolves.toEqual({ title: '合规标题', detail: '商品详情', sellingPoints: ['事实卖点'] })
    expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer secret' })
    expect(String(calls[0]?.body)).toContain('pinned-model')
    expect(String(calls[0]?.body)).toContain('未授权动漫角色')
    expect(String(calls[0]?.body)).toContain('不得出现 restrictedSubjects')
  })

  it('emits relay usage with the workspace action context', async () => {
    const usage: unknown[] = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: value => { usage.push(value) },
      fetch: async () => new Response(JSON.stringify({ id: 'req_usage', usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, cost_cny: 0.02 }, choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['事实'] }) } }] }), { status: 200, headers: { 'x-request-id': 'header_usage' } }),
    })
    await generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_usage', actionId: 'task_usage' } })
    expect(usage[0]).toMatchObject({ workspaceId: 'ws_usage', actionId: 'task_usage', providerRequestId: 'header_usage', totalTokens: 10, costCny: 0.02, metadata: { settlement: 'recorded' } })
  })

  it('does not deliver provider output when usage settlement fails', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      usageSink: async () => { throw new Error('ledger unavailable') },
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['事实'] }) } }] }), { status: 200 }),
    })

    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_usage', actionId: 'action_unknown' } })).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true, receiptKey: expect.stringMatching(/^relay_usage_[a-f0-9]{64}$/u), message: 'model usage settlement is pending' })
  })

  it('only creates a provider from a complete HTTPS relay configuration', () => {
    expect(createContentGeneratorFromEnv({ AI_BASE_URL: 'https://model.example', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ AI_BASE_URL: 'https://model.example', AI_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeDefined()
    expect(createContentGeneratorFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://169.254.169.254/metadata', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
  })

  it('accepts a structured static brief without exposing provider secrets', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'sku', title: 'SKU', purpose: '区分规格', body: '蓝色/M', factSourceIds: ['product:p:v1'] }], brief: { platform: 'taobao', placement: '首图', targetDimensions: '800x800', visualHierarchy: ['商品图', '标题'], productImageGuidance: '使用真实图', logoSafety: '保留安全区', headline: '标题', subheadline: '副标题', coreSellingPoint: '卖点', cta: '立即查看', textDensity: '低', safeArea: '5%', protectedAreas: ['Logo'] } }) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).resolves.toMatchObject({ modules: [{ key: 'sku' }], brief: { placement: '首图', targetDimensions: '800x800' } })
  })

  it('rejects malformed optional structures instead of silently dropping them', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'sku', title: 'SKU', purpose: '用途', body: '', factSourceIds: [] }] }) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('CONTENT_SCHEMA_INVALID')
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('modules[0].body')
  })

  it('repairs invalid structured output at most twice before accepting a valid response', async () => {
    const calls: RequestInit[] = []
    const responses = [
      { title: '标题', detail: '详情', sellingPoints: [] },
      { title: '标题', detail: '详情', sellingPoints: ['已确认卖点'] },
    ]
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      fetch: async (_url, init = {}) => {
        calls.push(init)
        const content = responses.shift() ?? responses[0]
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 })
      },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).resolves.toMatchObject({ sellingPoints: ['已确认卖点'] })
    expect(calls).toHaveLength(2)
    expect(String(calls[1]?.body)).toContain('只修复结构和缺失字段')
    const retry = JSON.parse(String(calls[1]?.body)) as { messages: Array<{ role: string; content: string }> }
    expect(retry.messages.some(message => message.role === 'assistant')).toBe(false)
    expect(String(calls[1]?.body)).not.toContain('"sellingPoints":[]')
  })

  it('keeps hard facts and rules while dropping oversized optional knowledge context', () => {
    const bounded = budgetContentGenerationInput({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, knowledgeContext: { rules: [{ id: 'rule_1', content: '禁止虚假宣传', version: '1', sourceReference: 'official' }], assets: Array.from({ length: 20 }, (_, index) => ({ id: `asset_${index}`, kind: 'brand' as const, name: '资料', content: '可选内容'.repeat(2_000), revision: 1, confirmed: false as const })), confirmedLearningSuggestions: [] } }, 3_000)
    expect(bounded.product.title).toBe('商品')
    expect(bounded.knowledgeContext?.rules).toHaveLength(1)
    expect(bounded.knowledgeContext?.assets.length).toBeLessThan(20)
  })

  it('fails closed when hard facts and blocking rules alone exceed the budget', () => {
    expect(() => budgetContentGenerationInput({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, knowledgeContext: { rules: [{ id: 'rule_1', content: '硬规则'.repeat(10_000), version: '1', sourceReference: 'official' }], assets: [], confirmedLearningSuggestions: [] } }, 200)).toThrow('CONTEXT_BUDGET_EXCEEDED')
  })

  it('rejects invalid token-budget configuration instead of silently disabling limits', () => {
    expect(() => resolveTokenBudget('NaN', 12_000, 'input')).toThrow('TOKEN_BUDGET_INVALID')
    expect(() => resolveTokenBudget('0', 12_000, 'input')).toThrow('TOKEN_BUDGET_INVALID')
    expect(resolveTokenBudget('2500', 12_000, 'output')).toBe(2500)
    expect(() => createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example.com/v1', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'text-model', AI_MAX_INPUT_TOKENS: 'unbounded' })).toThrow('TOKEN_BUDGET_INVALID')
  })

  it('stops after the initial response and two failed repair attempts', async () => {
    let calls = 0
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      fetch: async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }) },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('CONTENT_SCHEMA_INVALID')
    expect(calls).toBe(3)
  })
})
