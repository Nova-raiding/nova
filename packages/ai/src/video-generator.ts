import { assertUsageSinkConfiguredBeforeDispatch, emitRelayUsage, parseRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { relaySecurityFromEnv, assertRelayBaseUrl, assertRelayUrl, type RelaySecurityPolicy } from './relay-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { assertProviderResponseAccepted, ProviderRequestFailedError, providerIdempotencyKey, resolveProviderTimeoutMs, rethrowProviderTransportFailure, throwProviderOutcomeUnknown, withProviderRequestRetry, type ProviderBeforeRequest } from './provider-request.js'
import { isPlaceholderModelConfiguration } from './platform-model-gate.js'

export interface VideoGenerationInput {
  prompt: string
  output: 'rendering'
  context: unknown
  /** Durable business binding for a formal product render; candidate renders omit it. */
  productId?: string
  taskId?: string
  contentVersionId?: string
  sourceImage?: string
  usageContext?: RelayUsageContext
  beforeDispatch?: () => Promise<void>
  onAccepted?: (context: VideoBillingContext) => Promise<void>
}

export interface VideoBillingContext extends RelayUsageContext {
  settlementVerified?: boolean
  providerJobId: string
  model: string
  providerRequestId?: string
  productId?: string
  taskId?: string
  contentVersionId?: string
}

export interface VideoGenerationResult {
  settlementStatus?: 'pending_receipt' | 'settled'

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
  getStatus(providerJobId: string, billingContext?: VideoBillingContext): Promise<VideoGenerationResult>
}

export interface OpenAICompatibleVideoGeneratorOptions {
  baseUrl: string
  apiKey: string
  model: string
  imageModel?: string
  requestFormat?: 'json' | 'openai-video'
  resolution?: '720P' | '1080P'
  path?: string
  statusPath?: string
  durationSeconds?: number
  timeoutMs?: number
  fetch?: typeof fetch
  beforeRequest?: ProviderBeforeRequest
  usageSink?: RelayUsageSink
  relaySecurity?: RelaySecurityPolicy
}

const MAX_VIDEO_RELAY_RESPONSE_BYTES = 1 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Return true when a status payload makes any metering claim, even if that
 * claim is malformed and parseRelayUsage therefore rejects the whole receipt.
 * A prior settlement may cover a status response that omits usage entirely;
 * it must not hide a new malformed or contradictory provider claim. */
function hasExplicitVideoMeteringClaim(payload: unknown): boolean {
  const root = record(payload) ? payload : undefined
  const data = root && record(root.data) ? root.data : undefined
  const nestedData = data && record(data.data) ? data.data : undefined
  const result = data && record(data.result) ? data.result : undefined
  const metadata = root && record(root.metadata) ? root.metadata : undefined
  const envelopeNodes = [root, data, nestedData, result, metadata].filter(record)
  const malformedExplicitUsage = envelopeNodes.some(node =>
    Object.prototype.hasOwnProperty.call(node, 'usage') && !record(node.usage))
  const usage = [root?.usage, data?.usage, nestedData?.usage, result?.usage, metadata?.usage]
    .filter(record)
  const nodes = [...usage, ...envelopeNodes]
  const keys = [
    'prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens',
    'completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens',
    'total_tokens', 'totalTokens', 'cost_cny', 'costCny', 'actual_cost_cny',
    'actualCostCny', 'currency', 'cost_currency', 'costCurrency',
    'duration_seconds', 'durationSeconds', 'duration', 'output_video_duration',
    'outputVideoDuration', 'video_seconds', 'videoSeconds', 'video_duration',
    'videoDuration',
  ]
  return malformedExplicitUsage || nodes.some(node => keys.some(key => Object.prototype.hasOwnProperty.call(node, key)))
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

/**
 * Detect only a definitive relay refusal for an unavailable model. A generic
 * 5xx remains outcome-unknown because the provider may have accepted work.
 * Keep this allowlist narrow; broad matching would risk skipping
 * reconciliation for a request that was actually queued and billable.
 */
export function isDefinitiveVideoModelUnavailable(payload: unknown): boolean {
  const root = record(payload) ? payload : undefined
  const error = root && record(root.error) ? root.error : root
  if (!record(error)) return false
  const values = [error.code, error.type, error.reason]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
  return values.some(value => value === 'model_not_found' || value === 'model-not-found' || value === 'model_unavailable' || value === 'model-unavailable')
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
    assertRelayBaseUrl(options.baseUrl)
    validateVideoRelayPath(options.path, 'generation')
    validateVideoRelayPath(options.statusPath, 'status')
    // Keep direct construction subject to the same billing boundary as the
    // environment factory. Otherwise an out-of-range/NaN duration could be
    // sent to the relay while a different value is attached to usage evidence.
    this.options = { ...options, durationSeconds: videoDurationSeconds(options.durationSeconds === undefined ? undefined : String(options.durationSeconds)) }
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000)
    try {
      if (input.sourceImage && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(input.sourceImage)) throw new Error('VIDEO_SOURCE_IMAGE_INVALID')
      if (input.sourceImage && !this.options.imageModel) throw new Error('VIDEO_IMAGE_MODEL_REQUIRED')
      const model = input.sourceImage ? this.options.imageModel! : this.options.model
      // A reference image is an image-to-video request regardless of the
      // configured provider model name. Keep the relay's native first-frame
      // mapping alongside the legacy `image` field for every image-conditioned
      // request; model-name allowlists silently dropped this field for new
      // providers and produced accepted jobs that later failed upstream with
      // "input.media.0.url/type required".
      const metadata = input.sourceImage || this.options.resolution
        ? {
            ...(this.options.resolution ? { parameters: { resolution: this.options.resolution } } : {}),
            ...(input.sourceImage ? { input: { media: [{ type: 'first_frame', url: input.sourceImage }] } } : {}),
          }
        : undefined
      const requestBody = JSON.stringify({
        model,
        prompt: input.prompt,
        duration: this.options.durationSeconds ?? 5,
        ...(input.sourceImage ? { image: input.sourceImage } : {}),
        ...(this.options.resolution ? { size: this.options.resolution } : {}),
        ...(metadata ? { metadata } : {}),
      })
      const providerKey = providerIdempotencyKey({ operation: 'video_generate', model, workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, requestBody })
      assertUsageSinkConfiguredBeforeDispatch(this.options.usageSink, this.options.relaySecurity?.environment)
      let form: FormData | undefined
      if (this.options.requestFormat === 'openai-video') {
        form = new FormData()
        form.set('model', model)
        form.set('prompt', input.prompt)
        form.set('seconds', String(this.options.durationSeconds ?? 5))
        if (this.options.resolution) form.set('size', this.options.resolution)
        if (input.sourceImage) {
          const [header, encoded] = input.sourceImage.split(',', 2)
          const mimeType = header!.slice(5, header!.indexOf(';'))
          form.set('input_reference', new Blob([Buffer.from(encoded!, 'base64')], { type: mimeType }), 'reference.png')
          form.set('metadata', JSON.stringify({ img_url: input.sourceImage, ...(this.options.resolution ? { resolution: this.options.resolution } : {}) }))
        }
      }
      let dispatchClaimed = false
      const response = await withProviderRequestRetry(async () => {
        if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
        if (this.options.beforeRequest) await this.options.beforeRequest({ operation: 'video_generate', workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, signal: controller.signal })
        controller.signal.throwIfAborted()
        if (!dispatchClaimed) {
          await input.beforeDispatch?.()
          dispatchClaimed = true
        }
        let candidate: Response
        try {
          candidate = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${this.options.path ?? '/videos'}`, {
            method: 'POST',
            headers: { accept: 'application/json', ...(!form ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.options.apiKey}`, 'idempotency-key': providerKey },
            body: form ?? requestBody,
            signal: controller.signal,
            redirect: 'error',
          })
        } catch (error) { rethrowProviderTransportFailure(error, providerKey, 'video provider request') }
        if (candidate.status === 429) assertProviderResponseAccepted(candidate, providerKey, 'video provider')
        return candidate
      }, { signal: controller.signal })
      let responseText: string
      try { responseText = await readBoundedResponseText(response, MAX_VIDEO_RELAY_RESPONSE_BYTES, 'video provider response') }
      catch (error) { rethrowProviderTransportFailure(error, providerKey, 'video provider response') }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown }
      catch (error) {
        assertProviderResponseAccepted(response, providerKey, 'video provider')
        throwProviderOutcomeUnknown(providerKey, 'video provider response parsing', error)
      }
      const remoteError = record(payload) && record(payload.error) ? payload.error : record(payload) ? payload : {}
      const errorSummary = !response.ok ? [remoteError.code, remoteError.type, remoteError.message].filter(value => typeof value === 'string').join(': ').replace(/data:image\/[^\s]+/gu, '[image redacted]').slice(0, 500) : undefined
      // A 5xx normally means the provider outcome is ambiguous and must be
      // reconciled. `model_not_found` is different: the relay explicitly
      // rejected dispatch because no channel is enabled for this model. It
      // cannot have queued work, so fail closed as a normal request failure
      // and avoid creating a misleading reconciliation task. This is also the
      // only safe place to support an operator-configured model change: the
      // caller can surface the error and switch VIDEO_MODEL after validating
      // the replacement, but this adapter never silently changes models.
      if (!response.ok && response.status >= 500 && isDefinitiveVideoModelUnavailable(payload)) {
        const providerRequestId = [
          response.headers.get('x-oneapi-request-id'), response.headers.get('x-request-id'),
          response.headers.get('x-provider-request-id'), response.headers.get('request-id'),
        ].find(value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))?.trim()
        throw new ProviderRequestFailedError(providerKey, response.status, `video provider model unavailable${errorSummary ? `: ${errorSummary}` : ''}`, providerRequestId, errorSummary)
      }
      assertProviderResponseAccepted(response, providerKey, 'video provider', errorSummary)
      // Capture the relay's durable job identity before settlement. Usage
      // settlement must still fail closed, but it must not discard an accepted
      // provider job: without the id neither `video.get` nor provider-side
      // reconciliation can identify work the relay has already queued (and may
      // already be billing for).
      const parsed = parseVideoResult(payload, providerKey)
      const context = { ...input.usageContext, preauthorizationDurationSeconds: this.options.durationSeconds ?? 5, resolution: this.options.resolution, providerAttemptId: providerKey }
      const observed = parseRelayUsage(payload, response.headers, { modality: 'video', model, context })
      if (parsed.providerJobId && input.onAccepted) {
        try { await input.onAccepted({ ...context, model, providerJobId: parsed.providerJobId, ...(observed?.providerRequestId ? { providerRequestId: observed.providerRequestId } : {}) }) }
        catch (error) { throw Object.assign(new Error('accepted video job persistence requires reconciliation', { cause: error }), { code: 'MODEL_VIDEO_CONTEXT_PENDING', providerSucceeded: true, reconciliationRequired: true, providerJobId: parsed.providerJobId, actionId: input.usageContext?.actionId, runKey: input.usageContext?.runKey }) }
      }
      // Accepted asynchronous work is queryable, but never deliverable before actual metering.
      if (parsed.providerJobId && observed?.metadata?.usage_observed !== true) {
        return { status: 'queued', providerJobId: parsed.providerJobId, settlementStatus: 'pending_receipt' }
      }
      try {
        await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'video', model, context })
      } catch (error) {
        if (parsed.providerJobId && error instanceof Error) Object.assign(error, { ...videoJobIdentity(payload), providerAttemptId: providerKey })
        throw error
      }
      return { ...parsed, settlementStatus: 'settled' }
    } finally {
      clearTimeout(timeout)
    }
  }

  async getStatus(providerJobId: string, billingContext?: VideoBillingContext): Promise<VideoGenerationResult> {
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
      if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
      if (this.options.beforeRequest) await this.options.beforeRequest({ operation: 'video_query', signal: controller.signal })
      controller.signal.throwIfAborted()
      let response: Response
      try {
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
      const parsed = { ...parseVideoResult(payload, providerKey) }
      if (parsed.providerJobId && parsed.providerJobId !== jobId) throw new Error('VIDEO_PROVIDER_JOB_ID_MISMATCH')
      if (!billingContext) return parsed
      parsed.providerJobId = jobId
      if (billingContext.providerJobId !== jobId) throw new Error('VIDEO_BILLING_CONTEXT_MISMATCH')
      if (parsed.status !== 'completed') return { ...parsed, settlementStatus: 'pending_receipt' }
      // Status HTTP request ids identify a read, not the original billable generation.
      const billingHeaders = new Headers()
      if (billingContext.providerRequestId) billingHeaders.set('x-oneapi-request-id', billingContext.providerRequestId)
      else throw Object.assign(new Error('video generation request identity missing'), { code: 'MODEL_USAGE_RECEIPT_IDENTITY_MISSING', providerSucceeded: true })
      const defaults = { modality: 'video' as const, model: billingContext.model, context: billingContext }
      const usage = parseRelayUsage(payload, billingHeaders, defaults)
      // A prior durable settlement can cover a status read that omits usage,
      // but cannot override new, explicitly contradictory metering evidence.
      if (usage?.metadata?.usage_observed !== true) return billingContext.settlementVerified && !hasExplicitVideoMeteringClaim(payload)
        ? { ...parsed, settlementStatus: 'settled' }
        : { status: 'queued', providerJobId: jobId, settlementStatus: 'pending_receipt' }
      const sink = this.options.usageSink
      await emitRelayUsage(sink ? usage => sink({ ...usage, metadata: { ...usage.metadata, provider_job_id: jobId } }) : undefined, payload, billingHeaders, defaults)
      return { ...parsed, settlementStatus: 'settled' }
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** Bound provider-controlled identifiers before they cross into evidence rows. */
function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

/**
 * The provider job identity carried by an accepted relay response. This is the
 * single source of truth for both the success result and the reconciliation
 * evidence attached to a settlement failure, so the two can never diverge.
 */
export function videoJobIdentity(payload: unknown): { providerJobId?: string; providerStatus?: string } {
  const root = record(payload) ? payload : undefined
  const data = root && record(root.data) ? root.data : root
  if (!record(data)) return {}
  const nested = record(data.data) ? data.data : undefined
  const providerJobId = [data.task_id, data.job_id, data.id].map(boundedIdentifier).find((value): value is string => Boolean(value))
  const rawStatus = typeof data.status === 'string' ? data.status : typeof nested?.status === 'string' ? nested.status : undefined
  return { ...(providerJobId ? { providerJobId } : {}), ...(rawStatus ? { providerStatus: rawStatus.toLowerCase() } : {}) }
}

function parseVideoResult(payload: unknown, providerKey?: string): VideoGenerationResult {
  const root = record(payload) ? payload : undefined
  const relayCode = root && (typeof root.code === 'number' || typeof root.code === 'string') ? String(root.code).trim() : undefined
  // New API's video endpoint returns the literal string `success` for a
  // successful envelope (while OpenAI-compatible relays use 0/200).
  if (relayCode && !['0', '200', 'success'].includes(relayCode.toLowerCase())) {
    if (providerKey) throw new ProviderRequestFailedError(providerKey, 200, `video relay rejected the job with code ${relayCode}`)
    throw new Error(`video relay rejected the job with code ${relayCode}`)
  }
  const data = record(payload) && record(payload.data) ? payload.data : payload
  if (!record(data)) {
    if (providerKey) throwProviderOutcomeUnknown(providerKey, 'video provider non-object response')
    throw new Error('video provider response is not an object')
  }
  const nestedData = record(data.data) ? data.data : undefined
  const metadata = record(data.metadata) ? data.metadata : undefined
  const videoUrl = httpsUrl(data.result_url) ?? httpsUrl(data.video_url) ?? httpsUrl(data.output_url) ?? httpsUrl(data.url)
    ?? httpsUrl(nestedData?.result_url) ?? httpsUrl(nestedData?.video_url) ?? httpsUrl(nestedData?.output_url) ?? httpsUrl(nestedData?.url)
    ?? httpsUrl(metadata?.url)
    ?? httpsOutput(nestedData?.output)
  const providerJobId = videoJobIdentity(payload).providerJobId
  const rawStatus = typeof data.status === 'string' ? data.status.toLowerCase() : typeof nestedData?.status === 'string' ? nestedData.status.toLowerCase() : ''
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(rawStatus)) {
    const failureReason = typeof data.fail_reason === 'string' ? data.fail_reason.slice(0, 500) : rawStatus
    if (providerKey) throw new ProviderRequestFailedError(providerKey, 200, `video provider job failed: ${failureReason}`, undefined, failureReason)
    throw new Error(`video provider job failed: ${failureReason}`)
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

export function createVideoGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink, beforeRequest?: ProviderBeforeRequest): VideoGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim()
  const model = source.VIDEO_MODEL?.trim() || source.AI_VIDEO_MODEL?.trim()
  if (!relayUrl || !apiKey || !model || isPlaceholderModelConfiguration(relayUrl) || isPlaceholderModelConfiguration(apiKey) || isPlaceholderModelConfiguration(model)) return undefined
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity) return undefined
  const resolution = source.VIDEO_RESOLUTION?.trim().toUpperCase()
  if (resolution && !['720P', '1080P'].includes(resolution)) throw new Error('VIDEO_RESOLUTION must be 720P or 1080P')
  return new OpenAICompatibleVideoGenerator({
    baseUrl: relayUrl,
    relaySecurity,
    apiKey,
    model,
    ...(source.VIDEO_REQUEST_FORMAT === 'openai-video' ? { requestFormat: 'openai-video' as const } : {}),
    ...(resolution ? { resolution: resolution as '720P' | '1080P' } : {}),
    ...(source.VIDEO_IMAGE_MODEL?.trim() ? { imageModel: source.VIDEO_IMAGE_MODEL.trim() } : {}),
    ...(source.VIDEO_GENERATION_PATH?.trim() ? { path: source.VIDEO_GENERATION_PATH.trim() } : {}),
    ...(source.VIDEO_STATUS_PATH?.trim() ? { statusPath: source.VIDEO_STATUS_PATH.trim() } : {}),
    durationSeconds: videoDurationSeconds(source.VIDEO_DURATION_SECONDS),
    timeoutMs: resolveProviderTimeoutMs(source.VIDEO_TIMEOUT_MS, 180_000, 'VIDEO_TIMEOUT_MS'),
    ...(usageSink ? { usageSink } : {}),
    ...(beforeRequest ? { beforeRequest } : {}),
  })
}
