import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { relaySecurityFromEnv, assertRelayUrl, type RelaySecurityPolicy } from './relay-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { assertProviderResponseAccepted, ProviderRequestFailedError, providerIdempotencyKey, rethrowProviderTransportFailure, throwProviderOutcomeUnknown } from './provider-request.js'
import { isPlaceholderModelConfiguration } from './platform-model-gate.js'

export interface VideoGenerationInput {
  prompt: string
  output: 'rendering'
  context: unknown
  usageContext?: RelayUsageContext
}

export interface VideoGenerationResult {
  status: 'completed' | 'queued'
  videoUrl?: string
  providerJobId?: string
  /** Set by the application after a completed provider artifact is durably archived. */
  assetId?: string
  /** A completed provider artifact is quarantined until asset.scan promotes it. */
  archiveState?: 'quarantined' | 'archived'
}

export interface VideoGenerator {
  generate(input: VideoGenerationInput): Promise<VideoGenerationResult>
  getStatus(providerJobId: string): Promise<VideoGenerationResult>
}

export interface OpenAICompatibleVideoGeneratorOptions {
  baseUrl: string
  apiKey: string
  model: string
  path?: string
  statusPath?: string
  durationSeconds?: number
  timeoutMs?: number
  fetch?: typeof fetch
  usageSink?: RelayUsageSink
  relaySecurity?: RelaySecurityPolicy
}

const MAX_VIDEO_RELAY_RESPONSE_BYTES = 1 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\//u.test(value) ? value : undefined
}

function httpsOutput(value: unknown, depth = 0): string | undefined {
  if (depth > 2) return undefined
  const direct = httpsUrl(value)
  if (direct) return direct
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = httpsOutput(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (!record(value)) return undefined
  for (const key of ['result_url', 'video_url', 'output_url', 'url', 'output']) {
    const found = httpsOutput(value[key], depth + 1)
    if (found) return found
  }
  return undefined
}

export function videoDurationSeconds(value: string | undefined): number {
  const parsed = Number(value ?? 5)
  return Number.isFinite(parsed) ? Math.max(3, Math.min(15, Math.trunc(parsed))) : 5
}

export function validateVideoRelayPath(value: string | undefined, kind: 'generation' | 'status'): string | undefined {
  if (!value) return undefined
  if (!value.startsWith('/') || value.includes('\\') || /^https?:\/\//iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`video ${kind} path must be a safe relative path`)
  if (kind === 'status' && value.replaceAll('{job_id}', '').includes('{')) throw new Error('video status path contains an unsupported placeholder')
  return value
}

/**
 * The relay owns the provider-specific video API. The application only
 * accepts an HTTPS artifact URL or an opaque provider job id, so an accepted
 * request can never be mistaken for a rendered video.
 */
export class OpenAICompatibleVideoGenerator implements VideoGenerator {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: OpenAICompatibleVideoGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('video provider URL, API key and model are required')
    validateVideoRelayPath(options.path, 'generation')
    validateVideoRelayPath(options.statusPath, 'status')
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000)
    try {
      const requestBody = JSON.stringify({ model: this.options.model, prompt: input.prompt, duration: this.options.durationSeconds ?? 5 })
      const providerKey = providerIdempotencyKey({ operation: 'video_generate', model: this.options.model, workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, requestBody })
      let response: Response
      try {
        if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${this.options.path ?? '/video/generations'}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, 'idempotency-key': providerKey },
          body: requestBody,
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (error) { rethrowProviderTransportFailure(error, providerKey, 'video provider request') }
      assertProviderResponseAccepted(response, providerKey, 'video provider')
      let responseText: string
      try { responseText = await readBoundedResponseText(response, MAX_VIDEO_RELAY_RESPONSE_BYTES, 'video provider response') }
      catch (error) { rethrowProviderTransportFailure(error, providerKey, 'video provider response') }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown }
      catch (error) { throwProviderOutcomeUnknown(providerKey, 'video provider response parsing', error) }
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'video', model: this.options.model, context: { ...input.usageContext, durationSeconds: this.options.durationSeconds ?? 5, providerAttemptId: providerKey } })
      return parseVideoResult(payload, providerKey)
    } finally {
      clearTimeout(timeout)
    }
  }

  async getStatus(providerJobId: string): Promise<VideoGenerationResult> {
    const jobId = providerJobId.trim()
    if (!jobId || jobId.length > 256 || /[\u0000-\u001f\u007f]/u.test(jobId)) throw new Error('provider job id is invalid')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000)
    try {
      const statusTemplate = this.options.statusPath ?? '/video/generations/{job_id}'
      const statusPath = statusTemplate.replace(/\{job_id\}/gu, encodeURIComponent(jobId))
      const usesPathParameter = statusTemplate.includes('{job_id}')
      const requestBody = JSON.stringify({ job_id: jobId })
      const providerKey = providerIdempotencyKey({ operation: 'video_generate', model: this.options.model, actionId: `status:${jobId}`, requestBody })
      let response: Response
      try {
        if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${statusPath}`, {
          method: usesPathParameter ? 'GET' : 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
          ...(usesPathParameter ? {} : { body: requestBody }),
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (error) { rethrowProviderTransportFailure(error, providerKey, 'video provider status request') }
      assertProviderResponseAccepted(response, providerKey, 'video provider status')
      let responseText: string
      try { responseText = await readBoundedResponseText(response, MAX_VIDEO_RELAY_RESPONSE_BYTES, 'video provider status response') }
      catch (error) { rethrowProviderTransportFailure(error, providerKey, 'video provider status response') }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown }
      catch (error) { throwProviderOutcomeUnknown(providerKey, 'video provider status response parsing', error) }
      return parseVideoResult(payload, providerKey)
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseVideoResult(payload: unknown, providerKey?: string): VideoGenerationResult {
  const root = record(payload) ? payload : undefined
  const relayCode = root && (typeof root.code === 'number' || typeof root.code === 'string') ? String(root.code).trim() : undefined
  if (relayCode && relayCode !== '0' && relayCode !== '200') {
    if (providerKey) throw new ProviderRequestFailedError(providerKey, 200, `video relay rejected the job with code ${relayCode}`)
    throw new Error(`video relay rejected the job with code ${relayCode}`)
  }
  const data = record(payload) && record(payload.data) ? payload.data : payload
  if (!record(data)) {
    if (providerKey) throwProviderOutcomeUnknown(providerKey, 'video provider non-object response')
    throw new Error('video provider response is not an object')
  }
  const nestedData = record(data.data) ? data.data : undefined
  const videoUrl = httpsUrl(data.result_url) ?? httpsUrl(data.video_url) ?? httpsUrl(data.output_url) ?? httpsUrl(data.url)
    ?? httpsUrl(nestedData?.result_url) ?? httpsUrl(nestedData?.video_url) ?? httpsUrl(nestedData?.output_url) ?? httpsUrl(nestedData?.url)
    ?? httpsOutput(nestedData?.output)
  const providerJobId = typeof data.task_id === 'string' && data.task_id.trim() ? data.task_id.trim() : typeof data.job_id === 'string' && data.job_id.trim() ? data.job_id.trim() : typeof data.id === 'string' && data.id.trim() ? data.id.trim() : undefined
  const rawStatus = typeof data.status === 'string' ? data.status.toLowerCase() : typeof nestedData?.status === 'string' ? nestedData.status.toLowerCase() : ''
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(rawStatus)) {
    if (providerKey) throw new ProviderRequestFailedError(providerKey, 200, `video provider job failed: ${rawStatus}`)
    throw new Error(`video provider job failed: ${rawStatus}`)
  }
  if (['completed', 'succeeded', 'success'].includes(rawStatus) && !videoUrl) {
    if (providerKey) throwProviderOutcomeUnknown(providerKey, 'video provider completed without an HTTPS artifact URL')
    throw new Error('video provider marked the job completed without an HTTPS artifact URL')
  }
  if (!videoUrl && !providerJobId) {
    if (providerKey) throwProviderOutcomeUnknown(providerKey, 'video provider response contains neither an HTTPS artifact URL nor a provider job id')
    throw new Error('video provider response contains neither an HTTPS artifact URL nor a provider job id')
  }
  return { status: videoUrl ? 'completed' : 'queued', ...(videoUrl ? { videoUrl } : {}), ...(providerJobId ? { providerJobId } : {}) }
}

export function createVideoGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink): VideoGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim()
  const model = source.VIDEO_MODEL?.trim() || source.AI_VIDEO_MODEL?.trim()
  if (!relayUrl || !apiKey || !model || isPlaceholderModelConfiguration(relayUrl) || isPlaceholderModelConfiguration(apiKey) || isPlaceholderModelConfiguration(model)) return undefined
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity) return undefined
  return new OpenAICompatibleVideoGenerator({
    baseUrl: relayUrl,
    relaySecurity,
    apiKey,
    model,
    ...(source.VIDEO_GENERATION_PATH?.trim() ? { path: source.VIDEO_GENERATION_PATH.trim() } : {}),
    ...(source.VIDEO_STATUS_PATH?.trim() ? { statusPath: source.VIDEO_STATUS_PATH.trim() } : {}),
    durationSeconds: videoDurationSeconds(source.VIDEO_DURATION_SECONDS),
    timeoutMs: Number(source.VIDEO_TIMEOUT_MS ?? 180_000),
    ...(usageSink ? { usageSink } : {}),
  })
}
