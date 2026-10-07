import { describe, expect, it, vi } from 'vitest'
import { createEmbeddingClientFromEnv, OpenAICompatibleEmbeddingClient } from './embedding.js'
import { ModelUsageEvidenceMissingError } from './relay-usage.js'
import { providerIdempotencyKey } from './provider-request.js'
import { RelayPricingClient } from './relay-pricing.js'

const relay = 'https://relay.example.test'
const response = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const body = { data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.4] }], usage: { prompt_tokens: 4, total_tokens: 4, cost_cny: 0.002 } }

describe('relay embedding client', () => {
  it('authenticates through the relay, records usage/cost identity, and returns bounded vectors', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { expect(init?.headers).toMatchObject({ authorization: 'Bearer relay-key' }); expect(JSON.parse(String(init?.body))).toEqual({ model: 'embed-v1', input: ['一', '二'], encoding_format: 'float', dimensions: 2 }); return response(body, { 'x-provider-request-id': 'embed_req_1' }) })
    const sink = vi.fn(async record => { expect(record).toMatchObject({ modality: 'embedding', model: 'embed-v1', providerRequestId: 'embed_req_1', inputTokens: 4, totalTokens: 4, costCny: 0.002, workspaceId: 'ws_1' }); return { recorded: true as const, costEvidence: true as const } })
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: `${relay}/v1`, apiKey: 'relay-key', model: 'embed-v1', dimensions: 2, fetch: fetcher, usageSink: sink })
    await expect(client.embed({ texts: ['一', '二'], usageContext: { workspaceId: 'ws_1', actionId: 'knowledge:chunk' } })).resolves.toEqual({ embeddings: [[0.1, 0.2], [0.3, 0.4]], model: 'embed-v1', dimensions: 2 }); expect(sink).toHaveBeenCalledOnce()
  })

  it('matches the supplied Qwen embedding request and preserves the historical identity', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024)
    const model = 'qwen3.7-text-embedding-flash'
    const fetcher = vi.fn<typeof fetch>(async (url, init) => { expect(String(url)).toBe('https://ai.wormholexyz.xyz/v1/embeddings'); expect(JSON.parse(String(init?.body))).toMatchObject({ model, dimensions: 1024, encoding_format: 'float' }); return response({ data: [{ index: 0, embedding: vector }], usage: { prompt_tokens: 24, total_tokens: 24, cost_cny: 0.001 } }, { 'x-provider-request-id': 'qwen_embed_req_1' }) })
    const sink = vi.fn(async record => { expect(record).toMatchObject({ modality: 'embedding', model, providerRequestId: 'qwen_embed_req_1', totalTokens: 24, costCny: 0.001, workspaceId: 'ws_qwen' }); return { recorded: true as const, costEvidence: true as const } })
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: 'https://ai.wormholexyz.xyz/v1', apiKey: 'test-relay-key', model, dimensions: 1024, fetch: fetcher, usageSink: sink })
    const inputText = '健康焦虑已经出现，但行动路径缺失——不是不想做，而是不知道信谁、从哪开始、怎么坚持。'
    const historicalIdentity = providerIdempotencyKey({ operation: 'embedding', model, workspaceId: 'ws_qwen', actionId: 'knowledge:chunk', requestBody: JSON.stringify({ model, input: [inputText], encoding_format: 'float', dimensions: 1024 }) })
    await expect(client.embed({ texts: [inputText], usageContext: { workspaceId: 'ws_qwen', actionId: 'knowledge:chunk' } })).resolves.toMatchObject({ model, dimensions: 1024, embeddings: [vector] }); expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'idempotency-key': historicalIdentity }); expect(sink).toHaveBeenCalledOnce()
  })

  it('settles prompt-only embedding usage from the authenticated pricing snapshot', async () => {
    const model = 'qwen3.7-text-embedding-flash'; const pricingSnapshot = { pricing_version: 'wormhole-pricing-snapshot', group_ratio: { VIP: 0.85 }, data: [{ model_name: model, quota_type: 0, model_ratio: 0.005417276721, model_price: 0, completion_ratio: 1.986486486425, enable_groups: ['VIP'] }] }
    const pricing = new RelayPricingClient({ baseUrl: 'https://ai.wormholexyz.xyz/v1', apiKey: 'test-relay-key', group: 'VIP', modalityGroups: { embedding: 'VIP' }, fetch: async url => new Response(JSON.stringify(String(url).endsWith('/api/pricing') ? pricingSnapshot : { data: { quota_per_unit: 500_000, usd_exchange_rate: 6.83 } })) })
    let quote: Awaited<ReturnType<typeof pricing.quote>> | undefined; const sink = vi.fn(async usage => { quote = await pricing.quote(usage); return { recorded: true as const, costEvidence: true as const } }); const vector = [0.1, 0.2]
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: 'https://ai.wormholexyz.xyz/v1', apiKey: 'test-relay-key', model, fetch: async () => response({ data: [{ index: 0, embedding: vector }], usage: { prompt_tokens: 42, total_tokens: 42 } }, { 'x-provider-request-id': 'wormhole_embed_42' }), usageSink: sink })
    await expect(client.embed({ texts: ['embedding input'], usageContext: { workspaceId: 'ws_qwen' } })).resolves.toMatchObject({ embeddings: [vector] }); expect(sink).toHaveBeenCalledWith(expect.objectContaining({ modality: 'embedding', model, providerRequestId: 'wormhole_embed_42', inputTokens: 42, outputTokens: 0, totalTokens: 42, metadata: expect.objectContaining({ usage_observed: true, output_tokens_derivation: 'embedding_total_equals_prompt_tokens' }) })); expect(quote).toMatchObject({ costCny: 0, metadata: { cost_source: 'relay_pricing_snapshot', pricing_version: 'wormhole-pricing-snapshot', pricing_group: 'VIP', formula_version: 'new-api-quota-v1' } })
  })

  it('reuses the pre-scalar idempotency identity after an ambiguous provider result', async () => {
    const keys: string[] = []; let calls = 0; const fetcher = vi.fn<typeof fetch>(async (_url, init) => { calls += 1; keys.push(new Headers(init?.headers).get('idempotency-key') ?? ''); if (calls === 1) throw new TypeError('socket closed after dispatch'); return response({ data: [{ index: 0, embedding: [0.1] }], usage: { prompt_tokens: 1, total_tokens: 1, cost_cny: 0.001 } }, { 'x-provider-request-id': 'embed_retry_1' }) })
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: `${relay}/v1`, apiKey: 'relay-key', model: 'embed-v1', dimensions: 1, fetch: fetcher, usageSink: async () => ({ recorded: true, costEvidence: true }) }); const input = { texts: ['retry after uncertain dispatch'], usageContext: { workspaceId: 'ws_1', actionId: 'knowledge:chunk-1' } }
    await expect(client.embed(input)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' }); await expect(client.embed(input)).resolves.toMatchObject({ embeddings: [[0.1]] }); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
  })

  it('fails closed before returning vectors when durable usage/cost settlement is absent', async () => {
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: relay, apiKey: 'key', model: 'embed-v1', fetch: async () => response(body, { 'x-request-id': 'req' }) }); await expect(client.embed({ texts: ['text', 'more'] })).rejects.toBeInstanceOf(ModelUsageEvidenceMissingError)
  })

  it('rejects malformed dimensions and incomplete relay configuration', async () => {
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: relay, apiKey: 'key', model: 'embed-v1', dimensions: 3, fetch: async () => response(body), usageSink: async () => ({ recorded: true, costEvidence: true }) }); await expect(client.embed({ texts: ['text', 'more'] })).rejects.toThrow('EMBEDDING_RESPONSE_DIMENSIONS_INVALID'); expect(createEmbeddingClientFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: relay, MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.test', MODEL_RELAY_API_KEY: 'key' })).toBeUndefined(); expect(createEmbeddingClientFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: relay, MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.test', MODEL_RELAY_API_KEY: 'key', EMBEDDING_MODEL: 'embed-v1' })).toBeDefined(); expect(() => createEmbeddingClientFromEnv({ MODEL_RELAY_BASE_URL: relay, MODEL_RELAY_API_KEY: 'key', EMBEDDING_MODEL: 'embed-v1', EMBEDDING_TIMEOUT_MS: 'nope' })).toThrow('PROVIDER_TIMEOUT_INVALID')
  })
  it('does not dispatch in production when the durable usage sink is missing', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: relay,
      apiKey: 'test-only-key',
      model: 'embedding-test-model',
      relaySecurity: { environment: 'production', allowedHosts: ['relay.example.test'] },
      fetch: fetcher,
    })

    await expect(client.embed({ texts: ['不应发送'] })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'sink' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires provider usage and cost evidence before calling the settlement sink', async () => {
    const sink = vi.fn(async () => undefined)
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }), { status: 200, headers: { 'x-request-id': 'embedding-request-1' } }))
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: relay, apiKey: 'test-only-key', model: 'embedding-test-model', usageSink: sink, fetch: fetcher })

    await expect(client.embed({ texts: ['没有成本凭证'] })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'cost', providerSucceeded: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('records embedding usage only after a provider-reported CNY cost is present', async () => {
    const usage: unknown[] = []
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 2, total_tokens: 2, cost_cny: '0.0002' },
    }), { status: 200, headers: { 'x-request-id': 'embedding-request-2' } }))
    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: relay,
      apiKey: 'test-only-key',
      model: 'embedding-test-model',
      usageSink: record => { usage.push(record); return { recorded: true, costEvidence: true } },
      fetch: fetcher,
    })

    await expect(client.embed({ texts: ['有成本凭证'], usageContext: { workspaceId: 'ws_test', actionId: 'embedding:test' } })).resolves.toMatchObject({ model: 'embedding-test-model', dimensions: 2 })
    expect(usage[0]).toMatchObject({ workspaceId: 'ws_test', actionId: 'embedding:test', modality: 'embedding', providerRequestId: 'embedding-request-2', inputTokens: 2, totalTokens: 2, costCny: 0.0002 })
  })
})
