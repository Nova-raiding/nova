import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBoundedResponseText } from '../packages/connectors/src/bounded-response.js'
import { createRelayPricingClientFromEnv } from '../packages/ai/src/relay-pricing.js'
import { parseRelayUsage } from '../packages/ai/src/relay-usage.js'
import { retryAfterMilliseconds } from '../packages/ai/src/provider-request.js'
import { assertRelayUrl, relaySecurityFromEnv } from '../packages/ai/src/relay-security.js'

export type ProbeResult = {
  modality: 'text' | 'image' | 'image_edit' | 'ocr' | 'video'
  state: 'ready' | 'blocked' | 'not_run_cost_guard' | 'skipped_input'
  endpoint: string
  model: string
  httpStatus?: number
  providerRequestId?: string
  providerJobId?: string
  usageObserved?: boolean
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; billingUnits?: number; durationSeconds?: number }
  usageProviderRequestId?: string
  costObserved?: boolean
  costSource?: 'provider_receipt' | 'relay_pricing_snapshot'
  costCny?: number
  pricingVersion?: string
  pricingGroup?: string
  evidence_ref?: string
  detail?: string
}

type SuccessfulProbe = Omit<ProbeResult, 'state' | 'detail'> & {
  responseValid: boolean
  responseFailure?: string
}

const source = process.env.MODEL_RELAY_BASE_URL?.trim() ?? ''
const key = process.env.MODEL_RELAY_API_KEY?.trim() ?? ''
const videoKey = process.env.VIDEO_MODEL_RELAY_API_KEY?.trim() || key
const confirmCost = process.env.MODEL_RELAY_CANARY_CONFIRM === 'true'
const timeoutMs = resolveBoundedInteger(process.env.MODEL_RELAY_CANARY_TIMEOUT_MS, 120_000, 2_000, 120_000, 'MODEL_RELAY_CANARY_TIMEOUT_MS')
const rawVideoDurationSeconds = Number(process.env.VIDEO_DURATION_SECONDS ?? 5)
const videoDurationSeconds = Number.isFinite(rawVideoDurationSeconds) ? Math.max(3, Math.min(15, rawVideoDurationSeconds)) : 5
// Keep the default canary prompt deliberately neutral. Some relay safety
// filters reject vague or non-deterministic test prompts before a provider
// job is created, which would test the filter rather than video readiness.
const videoCanaryPrompt = process.env.MODEL_RELAY_CANARY_VIDEO_PROMPT?.trim()
  || 'A simple blue geometric cube on a plain white background, no people, no text.'
const base = source.replace(/\/+$/u, '')
const pricingClient = createRelayPricingClientFromEnv(process.env)
const relaySecurity = relaySecurityFromEnv(process.env)
const artifactRoot = process.env.MODEL_RELAY_ARTIFACT_ROOT?.trim()
const releaseId = process.env.RELEASE_ID?.trim() || ''

export function resolveBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const text = value?.trim()
  if (!text) return fallback
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function canaryIdempotencyKey(input: { releaseId: string; modality: ProbeResult['modality']; model: string; existingVideoTaskId?: string }): string {
  const identity = JSON.stringify([input.releaseId.trim(), input.modality, input.model.trim(), input.existingVideoTaskId?.trim() ?? ''])
  return `model_relay_canary_${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

export function canRetryCanaryResponse(status: number, attempt: number, maximumAttempts = 3): boolean {
  return status === 429 && attempt < Math.max(1, Math.min(3, Math.trunc(maximumAttempts)))
}

export function canaryRetryDelayMs(headers: Headers, attempt: number): number {
  const hinted = retryAfterMilliseconds(headers.get('retry-after')) ?? 0
  const exponential = Math.min(5_000, 250 * (2 ** Math.max(0, attempt - 1)))
  return Math.min(60_000, Math.max(hinted, exponential))
}

export function shouldBlockForCostGuard(input: {
  modality: ProbeResult['modality']
  confirmCost: boolean
  existingVideoTaskId?: string
}): boolean {
  return !input.confirmCost
    && (input.modality === 'image' || input.modality === 'image_edit' || (input.modality === 'video' && !input.existingVideoTaskId))
}

export function requireProductionReleaseBinding(input: { environment?: string; releaseId: string }): void {
  if (input.environment?.trim() === 'production' && !input.releaseId.trim()) {
    throw new Error('RELEASE_ID is required for production model relay evidence')
  }
  if (input.environment?.trim() === 'production' && !/^[A-Za-z0-9._-]+$/u.test(input.releaseId.trim())) {
    throw new Error('RELEASE_ID must be a safe production evidence identifier')
  }
}

export function readRelayErrorRecovery(path: string | undefined): Record<string, unknown> | undefined {
  const sourcePath = path?.trim()
  if (!sourcePath) return undefined
  const value = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_RELAY_ERROR_RECOVERY_PATH must contain one JSON object')
  return value as Record<string, unknown>
}

function modelFor(modality: ProbeResult['modality']) {
  if (modality === 'text') return process.env.AI_MODEL?.trim() || process.env.MODEL_ID?.trim() || ''
  if (modality === 'image') return process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || ''
  if (modality === 'image_edit') return process.env.IMAGE_EDIT_MODEL?.trim() || process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || ''
  if (modality === 'ocr') return process.env.OCR_MODEL?.trim() || process.env.AI_VISION_MODEL?.trim() || ''
  return process.env.VIDEO_MODEL?.trim() || process.env.AI_VIDEO_MODEL?.trim() || ''
}

function keyFor(modality: ProbeResult['modality']) {
  return modality === 'video' ? videoKey : key
}

function endpointFor(modality: ProbeResult['modality']) {
  if (modality === 'text' || modality === 'ocr') return '/chat/completions'
  if (modality === 'image') return process.env.IMAGE_GENERATION_PATH?.trim() || '/images/generations'
  if (modality === 'image_edit') return process.env.IMAGE_EDIT_PATH?.trim() || '/images/generations'
  return process.env.VIDEO_GENERATION_PATH?.trim()
    || (process.env.VIDEO_REQUEST_FORMAT?.trim() === 'openai-video' ? '/videos' : '/video/generations')
}

export function buildVideoProbeRequest(input: {
  model: string
  prompt: string
  durationSeconds: number
  resolution?: string
  requestFormat?: string
}): { body: string | FormData; contentType?: string } {
  if (input.requestFormat === 'openai-video') {
    const form = new FormData()
    form.set('model', input.model)
    form.set('prompt', input.prompt)
    form.set('seconds', String(input.durationSeconds))
    if (input.resolution) form.set('size', input.resolution)
    // Deliberately omit Content-Type: fetch must attach the multipart boundary.
    return { body: form }
  }
  return {
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      duration: input.durationSeconds,
      ...(input.resolution ? { size: input.resolution } : {}),
    }),
    contentType: 'application/json',
  }
}

function assertSafeRelativePath(path: string) {
  if (!path.startsWith('/') || path.includes('\\') || /^https?:\/\//iu.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error('relay canary path must be a safe relative path')
  return path
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Persist only the real relay response and probe metadata; never credentials. */
export function writeRelayResponseArtifact(root: string, release: string, modality: ProbeResult['modality'], response: { status: number; headers: Headers; payload: unknown; result: ProbeResult }): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(release)) throw new Error('RELEASE_ID must be a safe artifact path component')
  const body = JSON.stringify({
    schema_version: '1', release_id: release, modality,
    observed_at: new Date().toISOString(), http_status: response.status,
    response_headers: Object.fromEntries([...response.headers].filter(([name]) => /request-id|usage|cost|quota/iu.test(name))),
    result: response.result,
    relay_response: response.payload,
  }, null, 2) + '\n'
  const digest = createHash('sha256').update(body).digest('hex')
  const directory = resolve(root, 'relay', release)
  const canonicalTarget = resolve(directory, `${modality}.json`)
  // Evidence artifacts are immutable. Reusing a release/modality slot with a
  // different response must never silently overwrite the prior receipt.
  let target = canonicalTarget
  if (existsSync(canonicalTarget)) {
    const existing = readFileSync(canonicalTarget, 'utf8')
    const existingDigest = createHash('sha256').update(existing).digest('hex')
    if (existingDigest !== digest) target = resolve(directory, `${modality}-${digest.slice(0, 16)}.json`)
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (!existsSync(target)) writeFileSync(target, body, { mode: 0o600 })
  const relativePath = relative(resolve(root), target).split('\\').join('/')
  return `artifact://production/${relativePath}#${digest}`
}

export function extractProviderRequestId(payload: unknown, headers: Headers): string | undefined {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : {}
  const nestedData = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : {}
  const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result as Record<string, unknown> : {}
  return nonEmptyText(headers.get('x-oneapi-request-id'))
    ?? nonEmptyText(headers.get('x-request-id'))
    ?? nonEmptyText(headers.get('x-provider-request-id'))
    ?? nonEmptyText(headers.get('request-id'))
    ?? nonEmptyText(root.provider_request_id)
    ?? nonEmptyText(root.request_id)
    ?? nonEmptyText(data.provider_request_id)
    ?? nonEmptyText(data.request_id)
    ?? nonEmptyText(nestedData.provider_request_id)
    ?? nonEmptyText(nestedData.request_id)
    ?? nonEmptyText(result.provider_request_id)
    ?? nonEmptyText(result.request_id)
}

type PricingClient = Pick<NonNullable<ReturnType<typeof createRelayPricingClientFromEnv>>, 'quote'>

export async function evaluateRelayUsageEvidence(
  payload: unknown,
  headers: Headers,
  modality: ProbeResult['modality'],
  model: string,
  options: { pricing?: PricingClient; durationSeconds?: number; resolution?: string } = {},
) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const nestedData = nested?.data && typeof nested.data === 'object' && !Array.isArray(nested.data) ? nested.data as Record<string, unknown> : undefined
  const result = nested?.result && typeof nested.result === 'object' && !Array.isArray(nested.result) ? nested.result as Record<string, unknown> : undefined
  const rawUsage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : nested?.usage && typeof nested.usage === 'object' && !Array.isArray(nested.usage)
      ? nested.usage as Record<string, unknown>
      : nestedData?.usage && typeof nestedData.usage === 'object' && !Array.isArray(nestedData.usage) ? nestedData.usage as Record<string, unknown>
        : result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage as Record<string, unknown> : undefined
  const parsed = parseRelayUsage(payload, headers, {
    modality,
    model,
    ...(modality === 'image' || modality === 'image_edit'
      ? { context: { billingUnits: 1 } }
      : modality === 'video' ? { context: { durationSeconds: options.durationSeconds ?? videoDurationSeconds, ...(options.resolution ? { resolution: options.resolution } : {}) } } : {}),
  })
  const nonNegativeNumber = (value: unknown): number | undefined => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : undefined
    return number !== undefined && Number.isFinite(number) && number >= 0 ? number : undefined
  }
  const imageArtifacts = Array.isArray(record.data) ? record.data.length
    : nested && Array.isArray(nested.data) ? nested.data.length
      : result && Array.isArray(result.data) ? result.data.length : 0
  const reportedBillingUnits = nonNegativeNumber(rawUsage?.billing_units ?? rawUsage?.billed_units ?? rawUsage?.output_image_count)
  // The suffixed fields are defined in seconds. A generic `duration` is only
  // trusted when the provider explicitly says seconds or when the same
  // receipt corroborates it with `output_video_duration`. Never infer its
  // unit from the request-side duration used for preauthorization.
  const explicitDurationUnit = typeof rawUsage?.duration_unit === 'string'
    ? rawUsage.duration_unit.trim().toLowerCase()
    : typeof rawUsage?.unit === 'string' ? rawUsage.unit.trim().toLowerCase() : undefined
  const secondsUnit = explicitDurationUnit === undefined || ['s', 'sec', 'second', 'seconds'].includes(explicitDurationUnit)
  const outputVideoDuration = rawUsage?.output_video_duration
  const genericDuration = rawUsage?.duration
  const genericDurationCorroborated = outputVideoDuration !== undefined && outputVideoDuration !== null
  const rawReportedDurations = secondsUnit
    ? [rawUsage?.duration_seconds, rawUsage?.durationSeconds, outputVideoDuration,
        ...(genericDuration !== undefined && genericDuration !== null && (explicitDurationUnit !== undefined || genericDurationCorroborated) ? [genericDuration] : [])]
    .filter(value => value !== undefined && value !== null)
    : []
  const parsedReportedDurations = rawReportedDurations.map(nonNegativeNumber)
  const reportedDuration = rawReportedDurations.length > 0
    && parsedReportedDurations.every((value): value is number => value !== undefined && value > 0)
    && parsedReportedDurations.every(value => value === parsedReportedDurations[0])
    ? parsedReportedDurations[0]
    : undefined
  const rawReportedResolutions = [rawUsage?.SR, rawUsage?.resolution, rawUsage?.output_resolution]
    .filter(value => value !== undefined && value !== null)
  const normalizeVideoResolution = (value: unknown): '720P' | '1080P' | undefined => {
    const normalized = typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string' ? value.trim().toUpperCase() : ''
    if (normalized === '720' || normalized === '720P') return '720P'
    if (normalized === '1080' || normalized === '1080P') return '1080P'
    return undefined
  }
  const parsedReportedResolutions = rawReportedResolutions.map(normalizeVideoResolution)
  const reportedResolution = rawReportedResolutions.length > 0
    && parsedReportedResolutions.every((value): value is '720P' | '1080P' => value !== undefined)
    && parsedReportedResolutions.every(value => value === parsedReportedResolutions[0])
    ? parsedReportedResolutions[0]
    : undefined
  const invalidReportedResolution = rawReportedResolutions.length > 0 && reportedResolution === undefined
  const usage = {
    ...(parsed?.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
    ...(parsed?.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
    ...(parsed?.totalTokens !== undefined ? { totalTokens: parsed.totalTokens } : {}),
    ...(modality === 'image' || modality === 'image_edit' ? { billingUnits: reportedBillingUnits ?? imageArtifacts } : {}),
    ...(modality === 'video' && reportedDuration !== undefined ? { durationSeconds: reportedDuration } : {}),
  }
  // Cost alone proves money, not consumption units. Only response-derived
  // numeric units are release evidence; requested media duration/count is not.
  const usageObserved = Object.keys(usage).length > 0
  const metering = usageObserved ? { usage, ...(parsed?.providerRequestId ? { usageProviderRequestId: parsed.providerRequestId } : {}) } : {}
  const rawCost = parsed?.costCny ?? record.cost ?? headers.get('x-model-cost-cny')
  const providerCost = typeof rawCost === 'number'
    ? rawCost
    : typeof rawCost === 'string' && /^\d+(?:\.\d+)?$/u.test(rawCost.trim()) ? Number(rawCost) : undefined
  if (providerCost !== undefined && Number.isFinite(providerCost) && providerCost >= 0) {
    return { usageObserved, ...metering, costObserved: true, costSource: 'provider_receipt' as const, costCny: providerCost }
  }
  const quoteClient = options.pricing ?? pricingClient
  if (quoteClient && parsed && usageObserved && (modality !== 'video' || (reportedDuration !== undefined && !invalidReportedResolution))) {
    const { resolution: _requestResolution, ...providerNeutralMetadata } = parsed.metadata ?? {}
    const pricingUsage = modality === 'video' && reportedDuration !== undefined
      ? { ...parsed, metadata: { ...providerNeutralMetadata, duration_seconds: reportedDuration, duration_evidence: 'provider_usage', ...(reportedResolution ? { resolution: reportedResolution } : {}) } }
      : parsed
    const quote = await quoteClient.quote(pricingUsage)
    return { usageObserved: true, ...metering, costObserved: true, costSource: 'relay_pricing_snapshot' as const, costCny: quote.costCny, pricingVersion: quote.metadata.pricing_version, pricingGroup: quote.metadata.pricing_group }
  }
  return { usageObserved, ...metering, costObserved: false }
}

export function evaluateVideoProbePayload(payload: unknown): { ready: boolean; providerJobId?: string; reason?: string } {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : root
  const nestedData = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : {}
  const nestedOutput = nestedData.output && typeof nestedData.output === 'object' && !Array.isArray(nestedData.output) ? nestedData.output as Record<string, unknown> : {}
  const providerJobId = nonEmptyText(data.task_id) ?? nonEmptyText(data.job_id) ?? nonEmptyText(data.id)
  const relayCode = typeof root.code === 'number' || typeof root.code === 'string' ? String(root.code).trim() : undefined
  if (relayCode && !['0', '200', 'success'].includes(relayCode.toLowerCase())) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_relay_error_code' }
  // The local New API relay wraps async video state one level deeper as
  // `data.data.task_status` (while other providers use `status`). Treat the
  // provider's task status as first-class evidence so an accepted/running job
  // remains explicitly pending and a completed job can be validated once it
  // carries an HTTPS artifact.
  const status = (nonEmptyText(data.status) ?? nonEmptyText(nestedData.status) ?? nonEmptyText(nestedData.task_status) ?? nonEmptyText(nestedOutput.task_status))?.toLowerCase()
  const artifact = [data.result_url, data.video_url, data.output_url, data.url, nestedData.result_url, nestedData.video_url, nestedData.output_url, nestedData.url].some(value => typeof value === 'string' && /^https:\/\//u.test(value)) || hasHttpsOutput(nestedData.output)
  if (status && ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_failed' }
  // Wormhole's async wrapper reports the provider state as IN_PROGRESS while
  // the nested output uses RUNNING. Treat both as pending; otherwise a valid
  // job is incorrectly classified as "state missing" before it has finished.
  if (status && ['queued', 'pending', 'processing', 'running', 'in_progress', 'submitted'].includes(status)) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_pending' }
  if (status && ['completed', 'succeeded', 'success'].includes(status) && !artifact) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_completed_without_https_artifact' }
  if (artifact) return { ready: true, ...(providerJobId ? { providerJobId } : {}) }
  return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: providerJobId ? 'video_async_state_missing' : 'video_response_missing_job_or_artifact' }
}

/**
 * A successful HTTP response is not a successful canary. Production evidence
 * must remain blocked until it is attributable and both usage and cost are
 * observable. Keeping this decision pure makes every modality use the same
 * fail-closed contract, including asynchronous video status responses.
 */
export function finalizeSuccessfulProbe(input: SuccessfulProbe): ProbeResult {
  const { responseValid, responseFailure, ...result } = input
  if (!responseValid) return { ...result, state: 'blocked', detail: responseFailure ?? 'response_contract_invalid' }
  if (!result.providerRequestId) return { ...result, state: 'blocked', detail: 'provider_request_id_missing' }
  if (result.usageObserved !== true) return { ...result, state: 'blocked', detail: 'usage_evidence_missing' }
  const numericUsage = result.usage && Object.values(result.usage).filter(value => value !== undefined)
  if (!result.usage || !numericUsage?.length || numericUsage.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return { ...result, state: 'blocked', detail: 'numeric_usage_evidence_missing' }
  }
  if ((result.modality === 'text' || result.modality === 'ocr')
    && result.usage.inputTokens === undefined && result.usage.outputTokens === undefined && result.usage.totalTokens === undefined) {
    return { ...result, state: 'blocked', detail: 'token_usage_evidence_missing' }
  }
  if ((result.modality === 'image' || result.modality === 'image_edit')
    && (!Number.isSafeInteger(result.usage.billingUnits) || (result.usage.billingUnits ?? 0) <= 0)) {
    return { ...result, state: 'blocked', detail: 'billing_unit_evidence_missing' }
  }
  if (result.modality === 'video' && (typeof result.usage.durationSeconds !== 'number' || result.usage.durationSeconds <= 0)) {
    return { ...result, state: 'blocked', detail: 'duration_evidence_missing' }
  }
  if (result.usage.totalTokens !== undefined && result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined
    && result.usage.totalTokens !== result.usage.inputTokens + result.usage.outputTokens) {
    return { ...result, state: 'blocked', detail: 'token_usage_evidence_inconsistent' }
  }
  if (!result.usageProviderRequestId || result.usageProviderRequestId !== result.providerRequestId) return { ...result, state: 'blocked', detail: 'usage_request_id_mismatch' }
  if (result.costObserved !== true || typeof result.costCny !== 'number' || !Number.isFinite(result.costCny) || result.costCny < 0 || !result.costSource) {
    return { ...result, state: 'blocked', detail: 'cost_evidence_missing' }
  }
  if (result.costSource === 'relay_pricing_snapshot' && (!result.pricingVersion || !result.pricingGroup)) {
    return { ...result, state: 'blocked', detail: 'pricing_snapshot_identity_missing' }
  }
  return { ...result, state: 'ready' }
}

export function blockHttpProbe(
  common: Pick<ProbeResult, 'modality' | 'endpoint' | 'model'>,
  httpStatus: number,
  providerRequestId?: string,
): ProbeResult {
  return {
    ...common,
    state: 'blocked',
    httpStatus,
    ...(providerRequestId ? { providerRequestId } : {}),
    usageObserved: false,
    costObserved: false,
    detail: `relay returned HTTP ${httpStatus}`,
  }
}

function hasHttpsOutput(value: unknown, depth = 0): boolean {
  if (depth > 2) return false
  if (typeof value === 'string') return /^https:\/\//u.test(value)
  if (Array.isArray(value)) return value.some(item => hasHttpsOutput(item, depth + 1))
  if (!value || typeof value !== 'object') return false
  const output = value as Record<string, unknown>
  return ['result_url', 'video_url', 'output_url', 'url', 'output'].some(key => hasHttpsOutput(output[key], depth + 1))
}

async function probe(modality: ProbeResult['modality']): Promise<ProbeResult> {
  const model = modelFor(modality)
  const existingVideoTaskId = modality === 'video' ? process.env.MODEL_RELAY_CANARY_VIDEO_TASK_ID?.trim() : undefined
  const endpoint = existingVideoTaskId ? process.env.VIDEO_STATUS_PATH?.trim() || '/video/generations/{job_id}' : endpointFor(modality)
  const common = { modality, endpoint, model }
  if (!model) return { ...common, state: 'blocked', detail: 'model_missing' }
  if (!keyFor(modality)) return { ...common, state: 'blocked', detail: modality === 'video' ? 'VIDEO_MODEL_RELAY_API_KEY missing' : 'MODEL_RELAY_API_KEY missing' }
  if (shouldBlockForCostGuard({ modality, confirmCost, ...(existingVideoTaskId ? { existingVideoTaskId } : {}) })) return { ...common, state: 'not_run_cost_guard', detail: 'set MODEL_RELAY_CANARY_CONFIRM=true to run potentially billable media probes' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    assertSafeRelativePath(endpoint)
    await assertRelayUrl(base, relaySecurity ?? {})
    const body = modality === 'text'
      ? { model, temperature: 0, max_tokens: 8, messages: [{ role: 'user', content: '只返回 OK' }] }
      : modality === 'ocr'
        ? { model, temperature: 0, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: '只返回 JSON：{"ocr_text":"OK"}' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==' } }] }] }
        : modality === 'image'
          ? { model, prompt: '生成一张纯白测试图，只用于中转站连通性验收', n: 1, size: '1024x1024', response_format: 'url' }
          : modality === 'image_edit'
            ? { model, prompt: '对测试素材做最小编辑：保持主体不变', image: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg=='], image_mode: 'optimize', edit_region: { x: 0, y: 0, width: 1, height: 1 }, n: 1, size: '1024x1024', response_format: 'url' }
            : { model, prompt: videoCanaryPrompt, duration: videoDurationSeconds }
    const usesVideoStatusPath = Boolean(existingVideoTaskId && endpoint.includes('{job_id}'))
    const requestEndpoint = existingVideoTaskId ? endpoint.replace(/\{job_id\}/gu, encodeURIComponent(existingVideoTaskId)) : endpoint
    const videoRequest = modality === 'video' && !existingVideoTaskId
      ? buildVideoProbeRequest({
        model,
        prompt: videoCanaryPrompt,
        durationSeconds: videoDurationSeconds,
        ...(process.env.VIDEO_RESOLUTION?.trim() ? { resolution: process.env.VIDEO_RESOLUTION.trim().toUpperCase() } : {}),
        ...(process.env.VIDEO_REQUEST_FORMAT?.trim() ? { requestFormat: process.env.VIDEO_REQUEST_FORMAT.trim() } : {}),
      })
      : undefined
    const requestBody = !existingVideoTaskId ? videoRequest?.body ?? JSON.stringify(body) : usesVideoStatusPath ? undefined : JSON.stringify({ job_id: existingVideoTaskId })
    const idempotencyKey = canaryIdempotencyKey({ releaseId, modality, model, ...(existingVideoTaskId ? { existingVideoTaskId } : {}) })
    let response: Response | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetch(`${base}${requestEndpoint}`, {
        method: existingVideoTaskId ? usesVideoStatusPath ? 'GET' : 'POST' : 'POST',
        headers: {
          accept: 'application/json',
          ...(!videoRequest || videoRequest.contentType ? { 'content-type': videoRequest?.contentType ?? 'application/json' } : {}),
          authorization: `Bearer ${keyFor(modality)}`,
          'x-damai-canary': 'true',
          'x-idempotency-key': idempotencyKey,
        },
        ...(requestBody === undefined ? {} : { body: requestBody }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!canRetryCanaryResponse(response.status, attempt)) break
      await new Promise<void>((resolveWait, rejectWait) => {
        const retryTimer = setTimeout(resolveWait, canaryRetryDelayMs(response!.headers, attempt))
        controller.signal.addEventListener('abort', () => {
          clearTimeout(retryTimer)
          rejectWait(controller.signal.reason ?? new DOMException('relay canary retry aborted', 'AbortError'))
        }, { once: true })
      })
    }
    if (!response) throw new Error('relay canary produced no response')
    const payload = await readBoundedResponseText(response, 1 * 1024 * 1024, 'model relay response')
      .then(text => JSON.parse(text) as unknown)
      .catch(() => undefined)
    const providerRequestId = extractProviderRequestId(payload, response.headers)
    if (!response.ok) {
      const blocked = blockHttpProbe(common, response.status, providerRequestId)
      if (artifactRoot) {
        blocked.evidence_ref = writeRelayResponseArtifact(artifactRoot, releaseId, modality, {
          status: response.status, headers: response.headers, payload, result: blocked,
        })
      }
      return blocked
    }
    let measured: Awaited<ReturnType<typeof evaluateRelayUsageEvidence>>
    try { measured = await evaluateRelayUsageEvidence(payload, response.headers, modality, model, { resolution: process.env.VIDEO_RESOLUTION?.trim().toUpperCase() }) }
    catch (error) {
      measured = { usageObserved: false, costObserved: false }
      return { ...common, state: 'blocked', httpStatus: response.status, ...measured, detail: `pricing evidence failed: ${(error as { code?: string })?.code ?? (error instanceof Error ? error.message : 'unknown')}` }
    }
    const videoEvaluation = modality === 'video' ? evaluateVideoProbePayload(payload) : undefined
    const valid = modality === 'text' || modality === 'ocr'
      ? Boolean(payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).choices))
      : modality === 'video'
        ? videoEvaluation?.ready === true
        : Boolean(payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data))
    const finalized = finalizeSuccessfulProbe({
      ...common,
      httpStatus: response.status,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(videoEvaluation?.providerJobId ? { providerJobId: videoEvaluation.providerJobId } : {}),
      ...measured,
      responseValid: valid,
      ...(valid ? {} : { responseFailure: videoEvaluation?.reason ?? 'response_shape_incompatible' }),
    })
    // A successful transport can still be blocked by an async/payload/usage
    // contract. Preserve that raw response as immutable evidence too; without
    // it an accepted-but-pending provider job would be unauditable.
    if (artifactRoot) {
      finalized.evidence_ref = writeRelayResponseArtifact(artifactRoot, releaseId, modality, {
        status: response.status, headers: response.headers, payload, result: finalized,
      })
    }
    return finalized
  } catch (error) {
    return { ...common, state: 'blocked', detail: error instanceof Error ? error.name === 'AbortError' ? 'timeout' : error.message : 'probe_failed' }
  } finally { clearTimeout(timer) }
}

export async function main() {
  if (process.argv.includes('--probe')) {
    const results: ProbeResult[] = []
    const requestedModalities = process.argv.find((argument) => argument.startsWith('--modalities='))?.slice('--modalities='.length).split(',').map(value => value.trim()).filter(Boolean) ?? ['text', 'image', 'image_edit', 'ocr', 'video']
    const modalities = requestedModalities.filter((modality): modality is ProbeResult['modality'] => ['text', 'image', 'image_edit', 'ocr', 'video'].includes(modality))
    if (modalities.length !== requestedModalities.length || modalities.length === 0) {
      console.error(JSON.stringify({ state: 'blocked', reason: 'modalities must be a non-empty comma-separated subset of text,image,image_edit,ocr,video' }))
      process.exitCode = 2
      return
    }
    if (!base || (!key && !videoKey)) {
      console.error(JSON.stringify({ state: 'blocked', reason: !base ? 'MODEL_RELAY_BASE_URL missing' : 'MODEL_RELAY_API_KEY and VIDEO_MODEL_RELAY_API_KEY missing' }))
      process.exitCode = 1
    } else {
      try {
        requireProductionReleaseBinding({ environment: process.env.NODE_ENV, releaseId })
        if (!relaySecurity) throw new Error('MODEL_RELAY_BASE_URL/ALLOWED_HOSTS 不满足 relay 安全配置')
        for (const modality of modalities) results.push(await probe(modality))
        // The evidence contract stores the relay origin; each result carries its
        // endpoint path. This keeps /v1 configuration paths out of the origin
        // field and makes generated evidence compatible with its validator.
        const relayOrigin = new URL(base).origin
        const generatedAt = new Date()
        const ttlSeconds = resolveBoundedInteger(process.env.MODEL_RELAY_EVIDENCE_TTL_SECONDS, 24 * 60 * 60, 60, 7 * 24 * 60 * 60, 'MODEL_RELAY_EVIDENCE_TTL_SECONDS')
        const errorRecovery = readRelayErrorRecovery(process.env.MODEL_RELAY_ERROR_RECOVERY_PATH)
        const evidence = {
          schema_version: '1', release_id: releaseId, generated_at: generatedAt.toISOString(),
          expires_at: new Date(generatedAt.getTime() + ttlSeconds * 1000).toISOString(),
          environment: process.env.NODE_ENV?.trim() || '', simulated: false, relay: relayOrigin, results,
          ...(errorRecovery ? { error_recovery: errorRecovery } : {}),
        }
        const evidencePath = process.env.MODEL_RELAY_EVIDENCE_PATH?.trim()
        if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        console.log(JSON.stringify(evidence, null, 2))
        if (results.some(result => result.state !== 'ready' || result.providerRequestId === undefined || result.usageObserved !== true || result.costObserved !== true)) process.exitCode = 1
        if (process.env.NODE_ENV?.trim() === 'production' && (!artifactRoot || results.some(result => !result.evidence_ref))) process.exitCode = 1
        if (process.env.NODE_ENV?.trim() === 'production' && !errorRecovery) process.exitCode = 1
      } catch (error) {
        console.error(JSON.stringify({ state: 'blocked', reason: error instanceof Error ? error.message : 'relay_probe_failed' }))
        process.exitCode = 1
      }
    }
  } else {
    console.error('使用 --probe 才会发起真实中转请求；可用 --modalities=text,ocr 分阶段探测；媒体请求还需要 MODEL_RELAY_CANARY_CONFIRM=true。')
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
