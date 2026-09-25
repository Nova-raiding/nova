import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { budgetContentGenerationInput, MAX_CONTENT_INPUT_TOKENS, OpenAICompatibleContentGenerator, createContentGeneratorFromEnv, resolveTokenBudget, validateContentSchema } from './generator.js'
import { relayUsageReceiptKey, type RelayUsageRecord } from './relay-usage.js'

const decisionContract = {
  buyerQuestion: '我应该选择哪个规格？', pageTask: '帮助买家选择规格',
  claim: { text: '蓝色/M', factSourceIds: ['product:p:v1'], skuIds: ['sku-m'], platforms: ['taobao'], limitations: ['仅适用于当前 SKU'] },
  evidence: { type: 'parameter', sourceIds: ['product:p:v1'], status: 'verified' },
  visualContract: { requiredElements: ['规格名称'], protectedElements: ['商品颜色'], prohibitedImplications: ['不得暗示其他 SKU 同样适用'], accessibilityText: '蓝色 M 规格' },
  priority: 6, optional: false,
} as const

const validModules = [{
  key: 'sku', title: 'SKU', purpose: '区分规格', body: '蓝色/M', factSourceIds: ['product:p:v1'],
  contentKind: 'fact', referencedSkuIds: ['sku-m'], decisionContract,
}] as const

function validGeneratedContent(input: Record<string, unknown> = {}) {
  return { title: '标题', detail: '详情', sellingPoints: ['事实'], modules: validModules, ...input }
}

describe('content generator', () => {
  it('generates an unbound candidate through the provider without allowing fact modules', async () => {
    const brief = { platform: 'general', placement: '预览', targetDimensions: '按目标平台版位规范配置，未配置时由设计确认', visualHierarchy: ['主题'], productImageGuidance: '待确认素材', logoSafety: '待确认', headline: '创意标题', subheadline: '待确认', coreSellingPoint: '待确认', cta: '了解更多', textDensity: '低', safeArea: '待确认', protectedAreas: ['商品主体'] }
    const content = { title: '创意标题', detail: '待商家确认的文案方向', sellingPoints: ['待确认的表达方向'], brief }
    let promptText = ''
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init = {}) => {
        promptText = String(init.body)
        return new Response(JSON.stringify({ id: 'candidate-request', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 })
      },
    })
    await expect(generator.generate({ platform: 'general', candidateOnly: true, directionId: '创意方向', product: { title: '主题', stock: 0, skuCount: 0 } })).resolves.toEqual(content)
    expect(promptText).toContain('不得返回 modules')
    expect(() => validateContentSchema({ ...content, modules: validModules }, 'candidate', { candidateOnly: true })).toThrow('未绑定候选不得包含事实模块')
    expect(() => validateContentSchema({ title: content.title, detail: content.detail, sellingPoints: content.sellingPoints }, 'candidate', { candidateOnly: true })).toThrow('brief 必须是对象')
    expect(() => validateContentSchema(content, 'formal', { requireDecisionContracts: true })).toThrow('modules 必须是非空数组')
  })
  it('does not assemble a text provider from placeholder relay configuration', () => {
    expect(createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: '${MODEL_RELAY_API_KEY}', AI_MODEL: 'REPLACE_WITH_TEXT_MODEL' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'real-relay-key', AI_MODEL: 'your-text-model' })).toBeUndefined()
  })

  it('calls an OpenAI-compatible provider and validates structured output', async () => {
    const calls: RequestInit[] = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init = {}) => { calls.push(init); return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent({ title: '合规标题', detail: '商品详情', sellingPoints: ['事实卖点'] })) } }] }), { status: 200 }) },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, brandVisualRules: { restrictedSubjects: { people: ['某艺人'], spokespersons: [], intellectualProperties: ['未授权动漫角色'], prohibitedContent: [] } } })).resolves.toMatchObject({ title: '合规标题', detail: '商品详情', sellingPoints: ['事实卖点'], modules: [{ key: 'sku' }] })
    expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer secret' })
    expect(String(calls[0]?.body)).toContain('pinned-model')
    expect(String(calls[0]?.body)).toContain('未授权动漫角色')
    expect(String(calls[0]?.body)).toContain('不得出现 restrictedSubjects')
    expect(String(calls[0]?.body)).toContain('real_image、parameter、test_report、comparison、usage_result、manual_review')
    expect(String(calls[0]?.body)).toContain('referencedSkuIds 必须存在并逐个包含相同的 SKU ID')
    expect(String(calls[0]?.body)).toContain('outputShape')
    expect(String(calls[0]?.body)).toContain('visualContract')
  })

  it('retries a rate-limited text request with the same idempotency key', async () => {
    let attempts = 0
    const keys: string[] = []
    const bodies: string[] = []
    const proofs: Array<{ workspaceId?: string; actionId?: string; model: string; attempt: number; providerAttemptKey: string; requestBodySha256: string }> = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init = {}) => {
        attempts += 1
        keys.push(String((init.headers as Record<string, string>)['idempotency-key']))
        bodies.push(String(init.body))
        if (attempts === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        return new Response(JSON.stringify({ id: 'retry-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent()) } }] }), { status: 200 })
      },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_retry', actionId: 'action_retry' }, beforeProviderRequest: async proof => { proofs.push(proof) } })).resolves.toMatchObject({ title: '标题' })
    expect(attempts).toBe(2)
    expect(keys[0]).toBe(keys[1])
    expect(proofs).toHaveLength(1)
    expect(proofs[0]).toMatchObject({ workspaceId: 'ws_retry', actionId: 'action_retry', model: 'pinned-model', attempt: 0, providerAttemptKey: keys[0], requestBodySha256: createHash('sha256').update(bodies[0]!, 'utf8').digest('hex') })
    expect(bodies[0]).toBe(bodies[1])
    expect(bodies[0]).not.toContain('beforeProviderRequest')
  })

  it('stops before provider I/O when the logical-attempt fence rejects', async () => {
    let providerCalls = 0
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      fetch: async () => { providerCalls += 1; throw new Error('provider must not run') },
    })
    const denied = Object.assign(new Error('knowledge approval revoked'), { code: 'KNOWLEDGE_EXECUTION_CHANGED' })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_1', actionId: 'action_1' }, beforeProviderRequest: async () => { throw denied } })).rejects.toBe(denied)
    expect(providerCalls).toBe(0)
  })

  it('accepts a single full-response JSON fence but does not extract JSON from prose', async () => {
    const content = validGeneratedContent({ title: '围栏 JSON 标题' })
    const fenced = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'fenced-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(content)}\n\`\`\`` } }] }), { status: 200 }),
    })
    await expect(fenced.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 } })).resolves.toMatchObject({ title: '围栏 JSON 标题' })

    let attempts = 0
    const prose = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => { attempts += 1; return new Response(JSON.stringify({ id: `prose-${attempts}`, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: `结果如下：\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\`` } }] }), { status: 200 }) },
    })
    await expect(prose.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 } })).rejects.toThrow('CONTENT_SCHEMA_INVALID')
    expect(attempts).toBe(3)
  })

  it('repairs provider SKU references that escape the frozen product scope', async () => {
    let attempts = 0
    const invalid = validGeneratedContent({
      modules: [{
        ...validModules[0],
        referencedSkuIds: ['product-1'],
        decisionContract: { ...decisionContract, claim: { ...decisionContract.claim, skuIds: ['product-1'] } },
      }],
    })
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => {
        attempts += 1
        const content = attempts === 1 ? invalid : validGeneratedContent()
        return new Response(JSON.stringify({ id: `scope-${attempts}`, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 })
      },
    })

    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { id: 'product-1', title: '商品', stock: 1, skuCount: 1, skuIds: ['sku-m'] }, confirmedFactSourceIds: ['product:p:v1'] })).resolves.toMatchObject({ modules: [{ referencedSkuIds: ['sku-m'] }] })
    expect(attempts).toBe(2)
  })

  it('cancels an in-flight model provider request when the caller signal aborts', async () => {
    const controller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init) => {
        providerSignal = init?.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true }))
      },
    })
    const pending = generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 } }, { signal: controller.signal })
    controller.abort(new Error('lease lost'))

    await expect(pending).rejects.toThrow('lease lost')
    expect(providerSignal?.aborted).toBe(true)
  })

  it('emits relay usage with the workspace action context', async () => {
    const usage: unknown[] = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: value => { usage.push(value); return { recorded: true, costEvidence: true } },
      fetch: async () => new Response(JSON.stringify({ id: 'req_usage', usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, cost_cny: 0.02 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent()) } }] }), { status: 200, headers: { 'x-request-id': 'header_usage' } }),
    })
    await generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_usage', actionId: 'task_usage' } })
    expect(usage[0]).toMatchObject({ workspaceId: 'ws_usage', actionId: 'task_usage', providerRequestId: 'header_usage', totalTokens: 10, costCny: 0.02, metadata: { settlement: 'recorded' } })
  })

  it('keeps billing context out of the provider prompt while retaining it for usage settlement', async () => {
    const usage: unknown[] = []
    let requestBody = ''
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: value => { usage.push(value); return { recorded: true, costEvidence: true } },
      fetch: async (_url, init = {}) => { requestBody = String(init.body); return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent()) } }] }), { status: 200 }) },
    })
    await generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_private', actionId: 'action_private' } })
    expect(requestBody).not.toContain('ws_private')
    expect(requestBody).not.toContain('action_private')
    expect(usage[0]).toMatchObject({ workspaceId: 'ws_private', actionId: 'action_private' })
  })

  it('does not deliver provider output when usage settlement fails', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      usageSink: async () => { throw new Error('ledger unavailable') },
      fetch: async () => new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['事实'] }) } }] }), { status: 200 }),
    })

    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_usage', actionId: 'action_unknown' } })).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true, receiptKey: expect.stringMatching(/^relay_usage_[a-f0-9]{64}$/u), message: 'model usage settlement is pending' })
  })

  it('classifies text gateway ambiguity and accepted malformed JSON through the provider outcome contract', async () => {
    const gateway = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response('', { status: 502 }),
    })
    await expect(gateway.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { actionId: 'text:gateway' } })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown', reconciliationRequired: true, retryable: false })

    const malformed = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response('{not-json', { status: 200 }),
    })
    await expect(malformed.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { actionId: 'text:malformed' } })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown', reconciliationRequired: true, retryable: false })
  })

  it('records every structure-repair provider attempt under a stable distinct receipt identity', async () => {
    const usage: RelayUsageRecord[] = []
    const proofs: Array<{ attempt: number; providerAttemptKey: string; requestBodySha256: string }> = []
    const posted: Array<{ key: string; body: string }> = []
    const replies = [
      { title: '标题', detail: '详情', sellingPoints: [] },
      validGeneratedContent(),
    ]
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model',
      usageSink: value => { usage.push(structuredClone(value)); return { recorded: true, costEvidence: true } },
      fetch: async (_url, init = {}) => {
        posted.push({ key: String((init.headers as Record<string, string>)['idempotency-key']), body: String(init.body) })
        return new Response(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3, cost_cny: 0.01 }, choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }), { status: 200 })
      },
    })
    await generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 }, usageContext: { workspaceId: 'ws_1', actionId: 'text:repair' }, beforeProviderRequest: async proof => { proofs.push(proof) } })
    expect(usage).toHaveLength(2)
    expect(usage[0]?.providerRequestId).toBeUndefined()
    expect(usage[0]?.providerAttemptId).toMatch(/^mm-[a-f0-9]{64}$/u)
    expect(usage[1]?.providerAttemptId).toMatch(/^mm-[a-f0-9]{64}$/u)
    expect(usage[1]?.providerAttemptId).not.toBe(usage[0]?.providerAttemptId)
    expect(relayUsageReceiptKey(usage[0]!)).not.toBe(relayUsageReceiptKey(usage[1]!))
    expect(proofs).toHaveLength(2)
    for (const [index, proof] of proofs.entries()) {
      expect(proof).toMatchObject({ attempt: index, providerAttemptKey: posted[index]?.key, requestBodySha256: createHash('sha256').update(posted[index]!.body, 'utf8').digest('hex') })
    }
    expect(posted[0]?.key).not.toBe(posted[1]?.key)
  })

  it('reserves a full structured-output budget for repair responses', async () => {
    const maxTokens: number[] = []
    const replies = [{}, validGeneratedContent()]
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }), maxOutputTokens: 2_500,
      fetch: async (_url, init) => {
        maxTokens.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)
        return new Response(JSON.stringify({ id: `repair-budget-${maxTokens.length}`, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }), { status: 200 })
      },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 } })).resolves.toMatchObject({ title: '标题' })
    expect(maxTokens).toEqual([2_500, 2_500])
  })

  it('only creates a provider from a complete HTTPS relay configuration', () => {
    expect(createContentGeneratorFromEnv({ AI_BASE_URL: 'https://model.example', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ AI_BASE_URL: 'https://model.example', AI_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeDefined()
    expect(createContentGeneratorFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://169.254.169.254/metadata', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeUndefined()
    expect(createContentGeneratorFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model' })).toBeDefined()
    expect(() => createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'model', AI_THINKING_MODE: 'maybe' })).toThrow('AI_THINKING_MODE')
  })

  it('sends the explicit relay thinking-disable switch for strict JSON generation', async () => {
    let requestBody: Record<string, unknown> = {}
    const generator = createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'reasoning-model', AI_THINKING_MODE: 'disabled' }, () => ({ recorded: true, costEvidence: true })) as OpenAICompatibleContentGenerator
    Object.assign(generator as unknown as { fetchImpl: typeof fetch }, { fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'thinking-disabled', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent()) } }] }), { status: 200 })
    } })
    await generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 1, skuCount: 1 } })
    expect(requestBody.thinking).toEqual({ type: 'disabled' })
  })

  it('accepts a structured static brief without exposing provider secrets', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'sku', title: 'SKU', purpose: '区分规格', body: '蓝色/M', factSourceIds: ['product:p:v1'], contentKind: 'fact', referencedSkuIds: ['sku-m'], decisionContract }], brief: { platform: 'taobao', placement: '首图', targetDimensions: '800x800', visualHierarchy: ['商品图', '标题'], productImageGuidance: '使用真实图', logoSafety: '保留安全区', headline: '标题', subheadline: '副标题', coreSellingPoint: '卖点', cta: '立即查看', textDensity: '低', safeArea: '5%', protectedAreas: ['Logo'] } }) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).resolves.toMatchObject({ modules: [{ key: 'sku' }], brief: { placement: '首图', targetDimensions: '800x800' } })
  })

  it('fails closed on missing or unsupported detail-page evidence contracts', () => {
    const base = { title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'sku', title: 'SKU', purpose: '区分规格', body: '蓝色/M', factSourceIds: ['product:p:v1'], contentKind: 'fact' }] }
    expect(() => validateContentSchema({ title: '标题', detail: '详情', sellingPoints: ['卖点'] }, 'test', { requireDecisionContracts: true })).toThrow('modules 必须是非空数组')
    expect(() => validateContentSchema(base, 'test', { requireDecisionContracts: true })).toThrow('decisionContract')
    expect(() => validateContentSchema({ ...base, modules: [{ ...base.modules[0], decisionContract: { ...decisionContract, evidence: { type: 'parameter', sourceIds: [], status: 'verified' } } }] }, 'test', { requireDecisionContracts: true })).toThrow('verified 时不能为空')
    expect(() => validateContentSchema({ ...base, modules: [{ ...base.modules[0], decisionContract: { ...decisionContract, evidence: { type: 'invented', sourceIds: ['x'], status: 'verified' } } }] }, 'test', { requireDecisionContracts: true })).toThrow('evidence.type 不受支持')
    expect(() => validateContentSchema({ ...base, modules: [{ ...base.modules[0], decisionContract: { ...decisionContract, claim: { ...decisionContract.claim, factSourceIds: ['other:source'] } } }] }, 'test', { requireDecisionContracts: true })).toThrow('必须属于模块 factSourceIds')
  })

  it('uses an explicit pending dimension instruction when the provider leaves only that creative field empty', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent({ sellingPoints: ['事实卖点'], brief: { platform: 'taobao', placement: '详情页', targetDimensions: '', visualHierarchy: ['商品主体'], productImageGuidance: '使用真实商品图', logoSafety: '未提供 Logo 时不新增', headline: '标题', subheadline: '查看商品详情', coreSellingPoint: '事实卖点', cta: '查看详情', textDensity: '中', safeArea: '四周保留安全区', protectedAreas: ['商品主体'] } })) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).resolves.toMatchObject({ brief: { targetDimensions: '按目标平台版位规范配置，未配置时由设计确认' } })
  })

  it('rejects empty module provenance instead of borrowing every frozen product source', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['事实卖点'], modules: [{ key: 'hero', title: '首屏', purpose: '展示商品', body: '商品标题', factSourceIds: [], contentKind: 'fact' }], brief: { platform: 'taobao', placement: '详情页', targetDimensions: '', visualHierarchy: [], productImageGuidance: '使用真实商品图', logoSafety: '未提供 Logo 时不新增', headline: '标题', subheadline: '查看商品详情', coreSellingPoint: '事实卖点', cta: '查看详情', textDensity: '中', safeArea: '四周保留安全区', protectedAreas: [] } }) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { id: 'p1', title: '商品', stock: 2, skuCount: 1 }, confirmedFactSourceIds: ['product:p1:v3'] })).rejects.toThrow('modules[0].factSourceIds')
  })

  it('rejects malformed optional structures instead of silently dropping them', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'sku', title: 'SKU', purpose: '用途', body: '', factSourceIds: [], contentKind: 'fact' }] }) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('CONTENT_SCHEMA_INVALID')
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('modules[0].body')
  })

  it('requires every model module to declare its fact, creative, or pending classification', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify({ title: '标题', detail: '详情', sellingPoints: ['卖点'], modules: [{ key: 'hero', title: '首屏', purpose: '展示商品', body: '商品事实', factSourceIds: ['product:p:v1'] }] }) } }] }), { status: 200 }),
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('modules[0].contentKind')
  })

  it('repairs invalid structured output at most twice before accepting a valid response', async () => {
    const calls: RequestInit[] = []
    const responses = [
      { title: '标题', detail: '详情', sellingPoints: [] },
      validGeneratedContent({ sellingPoints: ['已确认卖点'] }),
    ]
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async (_url, init = {}) => {
        calls.push(init)
        const content = responses.shift() ?? responses[0]
        return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 })
      },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, usageContext: { workspaceId: 'ws_a', actionId: 'action_retry_safe' } })).resolves.toMatchObject({ sellingPoints: ['已确认卖点'] })
    expect(calls).toHaveLength(2)
    expect((calls[0]?.headers as Record<string, string>)['idempotency-key']).toMatch(/^mm-[a-f0-9]{64}$/u)
    expect((calls[1]?.headers as Record<string, string>)['idempotency-key']).toMatch(/^mm-[a-f0-9]{64}$/u)
    expect((calls[1]?.headers as Record<string, string>)['idempotency-key']).not.toBe((calls[0]?.headers as Record<string, string>)['idempotency-key'])
    expect(String(calls[1]?.body)).toContain('只修复结构和缺失字段')
    const retry = JSON.parse(String(calls[1]?.body)) as { messages: Array<{ role: string; content: string }> }
    expect(retry.messages.some(message => message.role === 'assistant')).toBe(false)
    expect(retry.messages.at(-1)?.content).toContain('decisionContract.visualContract.requiredElements')
    expect(retry.messages.at(-1)?.content).toContain('缺少来源则删除该模块')
    expect(String(calls[1]?.body)).not.toContain('"sellingPoints":[]')
    const initial = JSON.parse(String(calls[0]?.body)) as { messages: Array<{ content: string }> }
    expect(retry.messages[0]?.content).toBe(initial.messages[0]?.content)
  })

  it('keeps hard facts and rules while dropping oversized optional knowledge context', () => {
    const bounded = budgetContentGenerationInput({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, knowledgeContext: { rules: [{ id: 'rule_1', content: '禁止虚假宣传', version: '1', sourceReference: 'official' }], assets: Array.from({ length: 20 }, (_, index) => ({ id: `asset_${index}`, kind: 'brand' as const, name: '资料', content: '可选内容'.repeat(2_000), revision: 1, confirmed: false as const })), confirmedLearningSuggestions: [] } }, 3_000)
    expect(bounded.product.title).toBe('商品')
    expect(bounded.knowledgeContext?.rules).toHaveLength(1)
    expect(bounded.knowledgeContext?.assets.length).toBeLessThan(20)
  })

  // Regression: ISSUE-004 — approved product documents were frozen in the task but dropped from the provider envelope.
  // Found by /qa on 2026-09-15
  // Report: .gstack/qa-reports/qa-report-store-nova-2026-09-15.md
  it('preserves every approved document and revision in the budgeted provider request', async () => {
    const documents = [
      { id: 'doc_material', title: '面料说明', content: '面料为聚酯纤维。', revision: 3 },
      { id: 'doc_care', title: '洗护说明', content: '只能手洗，不能漂白。', revision: 7 },
    ]
    const input = budgetContentGenerationInput({
      platform: 'taobao', directionId: 'A', product: { title: '女装外套', stock: 2, skuCount: 1 },
      confirmedFactSourceIds: ['product:p:v1'],
      knowledgeContext: { rules: [], documents, assets: [], confirmedLearningSuggestions: [] },
    }, 3_000)
    expect(input.knowledgeContext?.documents).toEqual(documents)
    const calls: RequestInit[] = []
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }), maxInputTokens: 3_000,
      fetch: async (_url, init = {}) => {
        calls.push(init)
        return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent()) } }] }), { status: 200 })
      },
    })
    await generator.generate(input)
    const body = JSON.parse(String(calls[0]?.body)) as { messages: Array<{ content: string }> }
    const prompt = JSON.parse(body.messages[0]!.content) as { knowledgePolicy: string; input: { knowledgeContext: { documents: typeof documents } } }
    expect(prompt.input.knowledgeContext.documents).toEqual(documents)
    expect(prompt.knowledgePolicy).toContain('knowledgeContext.documents')
    expect(prompt.knowledgePolicy).toContain('approved')
  })

  it('fails closed instead of dropping or truncating an over-budget approved document', () => {
    const document = { id: 'doc_oversized', title: '大文档', content: '已确认商品事实'.repeat(2_000), revision: 5 }
    expect(() => budgetContentGenerationInput({
      platform: 'taobao', directionId: 'A', product: { title: '女装外套', stock: 2, skuCount: 1 },
      knowledgeContext: { rules: [], documents: [document], assets: [], confirmedLearningSuggestions: [] },
    }, 3_000)).toThrow('CONTEXT_BUDGET_EXCEEDED')
  })

  it('keeps approved documents while pruning oversized optional reference assets', () => {
    const documents = [{ id: 'doc_scope', title: '商品参数', content: '面料为聚酯纤维。', revision: 2 }]
    const bounded = budgetContentGenerationInput({
      platform: 'taobao', directionId: 'A', product: { title: '女装外套', stock: 2, skuCount: 1 },
      knowledgeContext: { rules: [], documents, assets: Array.from({ length: 20 }, (_, index) => ({ id: `asset_${index}`, kind: 'brand' as const, name: '参考资料', content: '可选风格参考'.repeat(2_000), revision: 1, confirmed: false as const })), confirmedLearningSuggestions: [] },
    }, 3_000)
    expect(bounded.knowledgeContext?.documents).toEqual(documents)
    expect(bounded.knowledgeContext?.assets.length).toBeLessThan(20)
  })

  it('reuses an application-budgeted envelope without changing the provider request', async () => {
    const calls: RequestInit[] = []
    const input = budgetContentGenerationInput({
      platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 },
      knowledgeContext: { rules: [{ id: 'rule_1', content: '禁止虚假宣传', version: '1', sourceReference: 'official' }], assets: [], confirmedLearningSuggestions: [] },
      usageContext: { workspaceId: 'ws_budget_reuse', actionId: 'action_budget_reuse' },
    }, 3_000)
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }), maxInputTokens: 3_000,
      fetch: async (_url, init = {}) => {
        calls.push(init)
        return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(validGeneratedContent()) } }] }), { status: 200 })
      },
    })
    await expect(generator.generate(input)).resolves.toMatchObject({ title: '标题' })
    const body = JSON.parse(String(calls[0]?.body)) as { messages: Array<{ content: string }> }
    expect(body.messages[0]?.content).toContain('禁止虚假宣传')
  })

  it('fails closed when hard facts and blocking rules alone exceed the budget', () => {
    expect(() => budgetContentGenerationInput({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 }, knowledgeContext: { rules: [{ id: 'rule_1', content: '硬规则'.repeat(10_000), version: '1', sourceReference: 'official' }], assets: [], confirmedLearningSuggestions: [] } }, 200)).toThrow('CONTEXT_BUDGET_EXCEEDED')
  })

  it('rejects invalid token-budget configuration instead of silently disabling limits', () => {
    expect(() => resolveTokenBudget('NaN', 12_000, 'input')).toThrow('TOKEN_BUDGET_INVALID')
    expect(() => resolveTokenBudget('0', 12_000, 'input')).toThrow('TOKEN_BUDGET_INVALID')
    expect(resolveTokenBudget('2500', 12_000, 'output')).toBe(2500)
    expect(resolveTokenBudget(String(MAX_CONTENT_INPUT_TOKENS), 4_000, 'input')).toBe(MAX_CONTENT_INPUT_TOKENS)
    expect(() => resolveTokenBudget(String(MAX_CONTENT_INPUT_TOKENS + 1), 4_000, 'input')).toThrow('TOKEN_BUDGET_INVALID')
    expect(() => createContentGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example.com/v1', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'text-model', AI_MAX_INPUT_TOKENS: 'unbounded' })).toThrow('TOKEN_BUDGET_INVALID')
  })

  it('rejects a model timeout that would abort every request instead of bounding it', () => {
    const relay = { MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_API_KEY: 'secret', AI_MODEL: 'text-model' }
    expect(() => createContentGeneratorFromEnv({ ...relay, AI_TIMEOUT_MS: 'unbounded' })).toThrow('PROVIDER_TIMEOUT_INVALID')
    expect(() => createContentGeneratorFromEnv({ ...relay, AI_TIMEOUT_MS: '0' })).toThrow('PROVIDER_TIMEOUT_INVALID')
    // An empty value means "unset" and keeps the default timeout.
    expect(createContentGeneratorFromEnv({ ...relay, AI_TIMEOUT_MS: '' })).toBeDefined()
  })

  it('stops after the initial response and two failed repair attempts', async () => {
    let calls = 0
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }),
      fetch: async () => { calls += 1; return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: '{}' } }] }), { status: 200 }) },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('CONTENT_SCHEMA_INVALID')
    expect(calls).toBe(3)
  })

  it('stops repairs when the action-level output budget is exhausted', async () => {
    let calls = 0
    const generator = new OpenAICompatibleContentGenerator({
      baseUrl: 'https://model.example', apiKey: 'secret', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }), maxOutputTokens: 2_500, maxTotalOutputTokens: 2_500,
      fetch: async () => { calls += 1; return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.001 }, choices: [{ message: { content: '{}' } }] }), { status: 200 }) },
    })
    await expect(generator.generate({ platform: 'taobao', directionId: 'A', product: { title: '商品', stock: 2, skuCount: 1 } })).rejects.toThrow('OUTPUT_BUDGET_EXCEEDED')
    expect(calls).toBe(1)
  })
})
