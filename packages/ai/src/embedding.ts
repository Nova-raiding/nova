import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { isPlaceholderModelConfiguration } from './platform-model-gate.js'
import { assertProviderResponseAccepted, providerIdempotencyKey, resolveProviderTimeoutMs, rethrowProviderTransportFailure, throwProviderOutcomeUnknown, withProviderRequestRetry, type ProviderBeforeRequest } from './provider-request.js'
import { assertRelayBaseUrl, assertRelayUrl, relaySecurityFromEnv, type RelaySecurityPolicy } from './relay-security.js'
import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'

const MAX_EMBEDDING_INPUTS = 64
const MAX_EMBEDDING_INPUT_CHARS = 32_000
const MAX_EMBEDDING_DIMENSIONS = 16_384
const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024

export interface EmbeddingResult { embeddings: number[][]; model: string; dimensions: number }
export interface EmbeddingClient { embed(input: { texts: readonly string[]; usageContext?: RelayUsageContext }): Promise<EmbeddingResult> }
export interface EmbeddingClientOptions { baseUrl: string; apiKey: string; model: string; dimensions?: number; timeoutMs?: number; fetch?: typeof fetch; usageSink?: RelayUsageSink; beforeRequest?: ProviderBeforeRequest; relaySecurity?: RelaySecurityPolicy }

function parseEmbeddings(payload: unknown, expectedCount: number, configuredDimensions?: number): number[][] {
  const root = payload as { data?: unknown } | undefined
  if (!root || !Array.isArray(root.data) || root.data.length !== expectedCount) throw new Error('EMBEDDING_RESPONSE_COUNT_INVALID')
  const ordered = root.data.map((item, fallbackIndex) => {
    const candidate = item as { index?: unknown; embedding?: unknown }
    const index = Number.isSafeInteger(candidate?.index) ? Number(candidate.index) : fallbackIndex
    const vector = candidate?.embedding
    if (!Array.isArray(vector) || vector.length < 1 || vector.length > MAX_EMBEDDING_DIMENSIONS || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('EMBEDDING_RESPONSE_VECTOR_INVALID')
    return { index, vector: [...vector] as number[] }
  }).sort((left, right) => left.index - right.index)
  if (ordered.some((item, index) => item.index !== index)) throw new Error('EMBEDDING_RESPONSE_INDEX_INVALID')
  const dimensions = ordered[0]!.vector.length
  if (ordered.some(item => item.vector.length !== dimensions) || (configuredDimensions !== undefined && dimensions !== configuredDimensions)) throw new Error('EMBEDDING_RESPONSE_DIMENSIONS_INVALID')
  return ordered.map(item => item.vector)
}

export class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: EmbeddingClientOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('embedding relay URL, API key and model are required')
    if (options.dimensions !== undefined && (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > MAX_EMBEDDING_DIMENSIONS)) throw new Error('EMBEDDING_DIMENSIONS_INVALID')
    assertRelayBaseUrl(options.baseUrl); this.fetchImpl = options.fetch ?? fetch
  }
  async embed(input: { texts: readonly string[]; usageContext?: RelayUsageContext }): Promise<EmbeddingResult> {
    if (!input.texts.length || input.texts.length > MAX_EMBEDDING_INPUTS || input.texts.some(text => typeof text !== 'string' || !text.trim() || text.length > MAX_EMBEDDING_INPUT_CHARS)) throw new Error('EMBEDDING_INPUT_INVALID')
    const body = JSON.stringify({ model: this.options.model, input: input.texts, encoding_format: 'float', ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}) })
    const attemptKey = providerIdempotencyKey({ operation: 'embedding', model: this.options.model, workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, requestBody: body })
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000)
    try {
      const response = await withProviderRequestRetry(async () => {
        if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
        if (this.options.beforeRequest) await this.options.beforeRequest({ operation: 'embedding', workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, signal: controller.signal })
        let candidate: Response
        try { candidate = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}/embeddings`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, 'idempotency-key': attemptKey }, body, signal: controller.signal, redirect: 'error' }) }
        catch (error) { rethrowProviderTransportFailure(error, attemptKey, 'embedding provider request') }
        assertProviderResponseAccepted(candidate, attemptKey, 'embedding provider'); return candidate
      }, { signal: controller.signal })
      let text: string
      try { text = await readBoundedResponseText(response, MAX_EMBEDDING_RESPONSE_BYTES, 'embedding response') } catch (error) { rethrowProviderTransportFailure(error, attemptKey, 'embedding provider response') }
      let payload: unknown
      try { payload = JSON.parse(text) } catch (error) { throwProviderOutcomeUnknown(attemptKey, 'embedding provider response parsing', error) }
      const embeddings = parseEmbeddings(payload, input.texts.length, this.options.dimensions)
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'embedding', model: this.options.model, context: { ...input.usageContext, providerAttemptId: attemptKey } })
      return { embeddings, model: this.options.model, dimensions: embeddings[0]!.length }
    } finally { clearTimeout(timeout) }
  }
}

export function createEmbeddingClientFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink, beforeRequest?: ProviderBeforeRequest): EmbeddingClient | undefined {
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim(); const apiKey = source.MODEL_RELAY_API_KEY?.trim(); const model = source.EMBEDDING_MODEL?.trim()
  if (!baseUrl || !apiKey || !model || [baseUrl, apiKey, model].some(isPlaceholderModelConfiguration)) return undefined
  const relaySecurity = relaySecurityFromEnv(source); if (!relaySecurity) return undefined
  const rawDimensions = source.EMBEDDING_DIMENSIONS?.trim(); const dimensions = rawDimensions ? Number(rawDimensions) : undefined
  return new OpenAICompatibleEmbeddingClient({ baseUrl, apiKey, model, ...(dimensions !== undefined ? { dimensions } : {}), timeoutMs: resolveProviderTimeoutMs(source.EMBEDDING_TIMEOUT_MS, 90_000, 'EMBEDDING_TIMEOUT_MS'), relaySecurity, ...(usageSink ? { usageSink } : {}), ...(beforeRequest ? { beforeRequest } : {}) })
}
