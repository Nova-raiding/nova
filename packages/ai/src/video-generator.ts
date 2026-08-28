import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { inspectOutboundUrl } from '../../connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'

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
  timeoutMs?: number
  fetch?: typeof fetch
  usageSink?: RelayUsageSink
}

const MAX_VIDEO_RELAY_RESPONSE_BYTES = 1 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\//u.test(value) ? value : undefined
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
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000)
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${this.options.path ?? '/video/generations'}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.options.model, prompt: input.prompt }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`video provider returned HTTP ${response.status}`)
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_VIDEO_RELAY_RESPONSE_BYTES, 'video provider response')) as unknown
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'video', model: this.options.model, context: input.usageContext })
      return parseVideoResult(payload)
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
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${statusPath}`, {
        method: usesPathParameter ? 'GET' : 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        ...(usesPathParameter ? {} : { body: JSON.stringify({ job_id: jobId }) }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`video provider status returned HTTP ${response.status}`)
      return parseVideoResult(JSON.parse(await readBoundedResponseText(response, MAX_VIDEO_RELAY_RESPONSE_BYTES, 'video provider status response')))
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseVideoResult(payload: unknown): VideoGenerationResult {
  const data = record(payload) && record(payload.data) ? payload.data : payload
  if (!record(data)) throw new Error('video provider response is not an object')
  const videoUrl = httpsUrl(data.video_url) ?? httpsUrl(data.output_url) ?? httpsUrl(data.url)
  const providerJobId = typeof data.task_id === 'string' && data.task_id.trim() ? data.task_id.trim() : typeof data.job_id === 'string' && data.job_id.trim() ? data.job_id.trim() : typeof data.id === 'string' && data.id.trim() ? data.id.trim() : undefined
  const rawStatus = typeof data.status === 'string' ? data.status.toLowerCase() : ''
  if (['failed', 'error', 'cancelled'].includes(rawStatus)) throw new Error(`video provider job failed: ${rawStatus}`)
  if (rawStatus === 'completed' && !videoUrl) throw new Error('video provider marked the job completed without an HTTPS artifact URL')
  if (!videoUrl && !providerJobId) throw new Error('video provider response contains neither an HTTPS artifact URL nor a provider job id')
  return { status: videoUrl ? 'completed' : 'queued', ...(videoUrl ? { videoUrl } : {}), ...(providerJobId ? { providerJobId } : {}) }
}

export function createVideoGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink): VideoGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim()
  const model = source.VIDEO_MODEL?.trim() ?? source.AI_VIDEO_MODEL?.trim()
  if (!relayUrl || !apiKey || !model) return undefined
  if (!/^https:\/\//u.test(relayUrl) || inspectOutboundUrl(relayUrl, { environment: source.NODE_ENV, resolveDns: false })) return undefined
  return new OpenAICompatibleVideoGenerator({
    baseUrl: relayUrl,
    apiKey,
    model,
    ...(source.VIDEO_GENERATION_PATH?.trim() ? { path: source.VIDEO_GENERATION_PATH.trim() } : {}),
    ...(source.VIDEO_STATUS_PATH?.trim() ? { statusPath: source.VIDEO_STATUS_PATH.trim() } : {}),
    timeoutMs: Number(source.VIDEO_TIMEOUT_MS ?? 180_000),
    ...(usageSink ? { usageSink } : {}),
  })
}
