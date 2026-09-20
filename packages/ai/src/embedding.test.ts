import { describe, expect, it, vi } from 'vitest'
import { createEmbeddingClientFromEnv, OpenAICompatibleEmbeddingClient } from './embedding.js'
import { ModelUsageEvidenceMissingError } from './relay-usage.js'

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
