import { describe, expect, it } from 'vitest'
import { budgetContentGenerationInput, OpenAICompatibleContentGenerator, validateContentSchema, type ContentGenerationInput } from './generator.js'
const body = { title: '内部审核', detail: '纯文本候选', sellingPoints: [] }
const input: ContentGenerationInput = { platform: 'taobao', outputType: 'plain_text', candidateOnly: true, directionId: 'A', product: { title: '蓝色袋子' }, taskIntent: { requestText: '只要纯文本', constraints: '不用于商业发布', sourceAssets: [{ id: 'asset-real', revision: 2, sha256: 'a'.repeat(64) }] } }
describe('plain text generation contract', () => {
  it('allows empty points only under the trusted plain contract, rejects visual extras', () => {
    expect(validateContentSchema(body, 'test', { outputType: 'plain_text' })).toEqual(body)
    for (const extra of [{ modules: [] }, { brief: {} }, { outputType: 'plain_text' }, { sellingPoints: [4] }]) expect(() => validateContentSchema({ ...body, ...extra }, 'test', { outputType: 'plain_text' })).toThrow('CONTENT_SCHEMA_INVALID')
    expect(() => validateContentSchema(body, 'test', { requireDecisionContracts: true })).toThrow('modules')
    expect(() => validateContentSchema(body, 'test', { candidateOnly: true })).toThrow('brief')
  })
  it('never drops frozen intent or asset identity to fit token budget', () => {
    expect(budgetContentGenerationInput(input).taskIntent).toEqual(input.taskIntent)
    expect(() => budgetContentGenerationInput({ ...input, taskIntent: { ...input.taskIntent!, constraints: '限制'.repeat(20000) } }, 1000)).toThrow('CONTEXT_BUDGET_EXCEEDED')
  })
  it('uses actual adapter prompt and validation without a live provider', async () => {
    let requestBody = ''
    const generator = new OpenAICompatibleContentGenerator({ baseUrl: 'https://model.example', apiKey: 'test', model: 'pinned-model', usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async (_url, init) => {
      requestBody = String(init?.body)
      return new Response(JSON.stringify({ id: 'plain-response', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost_cny: 0.001 }, choices: [{ message: { content: JSON.stringify(body) } }] }))
    } })
    expect(await generator.generate(input)).toEqual(body)
    expect(requestBody).toContain('commerce-plain-text-generation')
    expect(requestBody).toContain('不用于商业发布')
    expect(requestBody).toContain('asset-real')
    expect(requestBody).toContain('不是事实证据')
    const wire = JSON.parse(requestBody)
    const instruction = JSON.parse(wire.messages.find((message: { role: string }) => message.role === 'user').content)
    expect(instruction.input.product).toEqual({ title: '蓝色袋子' })
    expect(instruction.input.confirmedFactSourceIds).toBeUndefined()
  })
})
