import { describe, expect, it, vi } from 'vitest'
import { createEmbeddingClientFromEnv, OpenAICompatibleEmbeddingClient } from './embedding.js'
import { ModelUsageEvidenceMissingError } from './relay-usage.js'
import { providerIdempotencyKey } from './provider-request.js'

const response = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const body = { data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.4] }], usage: { prompt_tokens: 4, total_tokens: 4, cost_cny: 0.002 } }

describe('relay embedding client', () => {
  it('authenticates through the relay, records usage/cost identity, and returns bounded vectors', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer relay-key' })
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'embed-v1', input: ['一', '二'], encoding_format: 'float', dimensions: 2 })
      return response(body, { 'x-provider-request-id': 'embed_req_1' })
    })
    const sink = vi.fn(async record => {
      expect(record).toMatchObject({ modality: 'embedding', model: 'embed-v1', providerRequestId: 'embed_req_1', inputTokens: 4, totalTokens: 4, costCny: 0.002, workspaceId: 'ws_1' })
      return { recorded: true as const, costEvidence: true as const }
    })
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: 'https://relay.example.test/v1', apiKey: 'relay-key', model: 'embed-v1', dimensions: 2, fetch: fetcher, usageSink: sink })
    await expect(client.embed({ texts: ['一', '二'], usageContext: { workspaceId: 'ws_1', actionId: 'knowledge:chunk' } })).resolves.toEqual({ embeddings: [[0.1, 0.2], [0.3, 0.4]], model: 'embed-v1', dimensions: 2 })
    expect(sink).toHaveBeenCalledOnce()
  })

  it('matches the supplied Wormhole Qwen embedding request contract', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024)
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://ai.wormholexyz.xyz/v1/embeddings')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-relay-key', 'content-type': 'application/json' })
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'qwen3.7-text-embedding-flash',
        input: '健康焦虑已经出现，但行动路径缺失——不是不想做，而是不知道信谁、从哪开始、怎么坚持。',
        dimensions: 1024,
        encoding_format: 'float',
      })
      return response({ data: [{ index: 0, embedding: vector }], usage: { prompt_tokens: 24, total_tokens: 24, cost_cny: 0.001 } }, { 'x-provider-request-id': 'qwen_embed_req_1' })
    })
    const sink = vi.fn(async record => {
      expect(record).toMatchObject({ modality: 'embedding', model: 'qwen3.7-text-embedding-flash', providerRequestId: 'qwen_embed_req_1', totalTokens: 24, costCny: 0.001, workspaceId: 'ws_qwen' })
      return { recorded: true as const, costEvidence: true as const }
    })
    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: 'https://ai.wormholexyz.xyz/v1', apiKey: 'test-relay-key', model: 'qwen3.7-text-embedding-flash',
      dimensions: 1024, fetch: fetcher, usageSink: sink,
    })

    const historicalIdentity = providerIdempotencyKey({
      operation: 'embedding', model: 'qwen3.7-text-embedding-flash', workspaceId: 'ws_qwen', actionId: 'knowledge:chunk',
      requestBody: JSON.stringify({ model: 'qwen3.7-text-embedding-flash', input: ['健康焦虑已经出现，但行动路径缺失——不是不想做，而是不知道信谁、从哪开始、怎么坚持。'], encoding_format: 'float', dimensions: 1024 }),
    })
    await expect(client.embed({ texts: ['健康焦虑已经出现，但行动路径缺失——不是不想做，而是不知道信谁、从哪开始、怎么坚持。'], usageContext: { workspaceId: 'ws_qwen', actionId: 'knowledge:chunk' } }))
      .resolves.toMatchObject({ model: 'qwen3.7-text-embedding-flash', dimensions: 1024, embeddings: [vector] })
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'idempotency-key': historicalIdentity })
    expect(sink).toHaveBeenCalledOnce()
  })

  it('reuses the pre-scalar idempotency identity after an ambiguous provider result', async () => {
    const keys: string[] = []
    let calls = 0
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      calls += 1
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
      if (calls === 1) throw new TypeError('socket closed after dispatch')
      return response({ data: [{ index: 0, embedding: [0.1] }], usage: { prompt_tokens: 1, total_tokens: 1, cost_cny: 0.001 } }, { 'x-provider-request-id': 'embed_retry_1' })
    })
    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: 'https://relay.example.test/v1', apiKey: 'relay-key', model: 'embed-v1', dimensions: 1, fetch: fetcher,
      usageSink: async () => ({ recorded: true, costEvidence: true }),
    })
    const input = { texts: ['retry after uncertain dispatch'], usageContext: { workspaceId: 'ws_1', actionId: 'knowledge:chunk-1' } }
    await expect(client.embed(input)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
    await expect(client.embed(input)).resolves.toMatchObject({ embeddings: [[0.1]] })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ input: 'retry after uncertain dispatch' })
  })

  it('fails closed before returning vectors when durable usage/cost settlement is absent', async () => {
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: 'https://relay.example.test', apiKey: 'key', model: 'embed-v1', fetch: async () => response(body, { 'x-request-id': 'req' }) })
    await expect(client.embed({ texts: ['text', 'more'] })).rejects.toBeInstanceOf(ModelUsageEvidenceMissingError)
  })

  it('rejects malformed dimensions and incomplete relay configuration', async () => {
    const client = new OpenAICompatibleEmbeddingClient({ baseUrl: 'https://relay.example.test', apiKey: 'key', model: 'embed-v1', dimensions: 3, fetch: async () => response(body), usageSink: async () => ({ recorded: true, costEvidence: true }) })
    await expect(client.embed({ texts: ['text', 'more'] })).rejects.toThrow('EMBEDDING_RESPONSE_DIMENSIONS_INVALID')
    expect(createEmbeddingClientFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example.test', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.test', MODEL_RELAY_API_KEY: 'key' })).toBeUndefined()
    expect(createEmbeddingClientFromEnv({ NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example.test', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.test', MODEL_RELAY_API_KEY: 'key', EMBEDDING_MODEL: 'embed-v1' })).toBeDefined()
    expect(() => createEmbeddingClientFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example.test', MODEL_RELAY_API_KEY: 'key', EMBEDDING_MODEL: 'embed-v1', EMBEDDING_TIMEOUT_MS: 'nope' })).toThrow('PROVIDER_TIMEOUT_INVALID')
  })
})
