import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readBoundedResponseText } from '../packages/connectors/src/bounded-response.js'
import { createRelayPricingClientFromEnv } from '../packages/ai/src/relay-pricing.js'
import { parseRelayUsage } from '../packages/ai/src/relay-usage.js'
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
  costObserved?: boolean
  costSource?: 'provider_receipt' | 'relay_pricing_snapshot'
  costCny?: number
  pricingVersion?: string
  pricingGroup?: string
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
const timeoutMs = Math.min(120_000, Math.max(2_000, Number(process.env.MODEL_RELAY_CANARY_TIMEOUT_MS ?? 120_000)))
const rawVideoDurationSeconds = Number(process.env.VIDEO_DURATION_SECONDS ?? 5)
const videoDurationSeconds = Number.isFinite(rawVideoDurationSeconds) ? Math.max(3, Math.min(15, rawVideoDurationSeconds)) : 5
const base = source.replace(/\/+$/u, '')
const pricingClient = createRelayPricingClientFromEnv(process.env)
const relaySecurity = relaySecurityFromEnv(process.env)

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
  return process.env.VIDEO_GENERATION_PATH?.trim() || '/video/generations'
}

function assertSafeRelativePath(path: string) {
  if (!path.startsWith('/') || path.includes('\\') || /^https?:\/\//iu.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error('relay canary path must be a safe relative path')
  return path
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function extractProviderRequestId(payload: unknown, headers: Headers): string | undefined {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : {}
  const nestedData = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : {}
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
}

type PricingClient = Pick<NonNullable<ReturnType<typeof createRelayPricingClientFromEnv>>, 'quote'>

export async function evaluateRelayUsageEvidence(
  payload: unknown,
  headers: Headers,
  modality: ProbeResult['modality'],
  model: string,
  options: { pricing?: PricingClient; durationSeconds?: number } = {},
) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const nestedData = nested?.data && typeof nested.data === 'object' && !Array.isArray(nested.data) ? nested.data as Record<string, unknown> : undefined
  const rawUsage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : nested?.usage && typeof nested.usage === 'object' && !Array.isArray(nested.usage)
      ? nested.usage as Record<string, unknown>
      : nestedData?.usage && typeof nestedData.usage === 'object' && !Array.isArray(nestedData.usage) ? nestedData.usage as Record<string, unknown> : undefined
  const parsed = parseRelayUsage(payload, headers, {
    modality,
    model,
    ...(modality === 'image' || modality === 'image_edit'
      ? { context: { billingUnits: 1 } }
      : modality === 'video' ? { context: { durationSeconds: options.durationSeconds ?? videoDurationSeconds } } : {}),
  })
  const requestUsageObserved = modality === 'image' || modality === 'image_edit'
    ? parsed?.metadata?.billing_units === 1
    : modality === 'video'
      ? typeof parsed?.metadata?.duration_seconds === 'number' && parsed.metadata.duration_seconds > 0
      : false
  // Cost alone proves money, not consumption units. Keep the two evidence
  // dimensions separate so a media response cannot pass usage gates merely
  // because it contains cost_cny.
  const usageObserved = requestUsageObserved
    || parsed?.inputTokens !== undefined
    || parsed?.outputTokens !== undefined
    || parsed?.totalTokens !== undefined
    || Boolean(rawUsage && Object.keys(rawUsage).length)
  const rawCost = parsed?.costCny ?? record.cost ?? headers.get('x-model-cost-cny')
  const providerCost = typeof rawCost === 'number'
    ? rawCost
    : typeof rawCost === 'string' && /^\d+(?:\.\d+)?$/u.test(rawCost.trim()) ? Number(rawCost) : undefined
  if (providerCost !== undefined && Number.isFinite(providerCost) && providerCost >= 0) {
    return { usageObserved, costObserved: true, costSource: 'provider_receipt' as const, costCny: providerCost }
  }
  const quoteClient = options.pricing ?? pricingClient
  if (quoteClient && parsed && usageObserved) {
    const quote = await quoteClient.quote(parsed)
    return { usageObserved: true, costObserved: true, costSource: 'relay_pricing_snapshot' as const, costCny: quote.costCny, pricingVersion: quote.metadata.pricing_version, pricingGroup: quote.metadata.pricing_group }
  }
  return { usageObserved, costObserved: false }
}

export function evaluateVideoProbePayload(payload: unknown): { ready: boolean; providerJobId?: string; reason?: string } {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : root
  const nestedData = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : {}
  const providerJobId = nonEmptyText(data.task_id) ?? nonEmptyText(data.job_id) ?? nonEmptyText(data.id)
  const relayCode = typeof root.code === 'number' || typeof root.code === 'string' ? String(root.code).trim() : undefined
  if (relayCode && !['0', '200', 'success'].includes(relayCode.toLowerCase())) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_relay_error_code' }
  const status = (nonEmptyText(data.status) ?? nonEmptyText(nestedData.status))?.toLowerCase()
  const artifact = [data.result_url, data.video_url, data.output_url, data.url, nestedData.result_url, nestedData.video_url, nestedData.output_url, nestedData.url].some(value => typeof value === 'string' && /^https:\/\//u.test(value)) || hasHttpsOutput(nestedData.output)
  if (status && ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_failed' }
  if (status && ['queued', 'pending', 'processing', 'running', 'submitted'].includes(status)) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_pending' }
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
  if (result.costObserved !== true || result.costCny === undefined || !result.costSource) return { ...result, state: 'blocked', detail: 'cost_evidence_missing' }
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
  if (!confirmCost && (modality === 'image' || modality === 'image_edit' || (modality === 'video' && !existingVideoTaskId))) return { ...common, state: 'not_run_cost_guard', detail: 'set MODEL_RELAY_CANARY_CONFIRM=true to run potentially billable media probes' }
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
            : { model, prompt: '创建一个最小成本的中转站测试任务', duration: videoDurationSeconds }
    const usesVideoStatusPath = Boolean(existingVideoTaskId && endpoint.includes('{job_id}'))
    const requestEndpoint = existingVideoTaskId ? endpoint.replace(/\{job_id\}/gu, encodeURIComponent(existingVideoTaskId)) : endpoint
    const response = await fetch(`${base}${requestEndpoint}`, {
      method: existingVideoTaskId ? usesVideoStatusPath ? 'GET' : 'POST' : 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${keyFor(modality)}`, 'x-damai-canary': 'true' },
      ...(!existingVideoTaskId ? { body: JSON.stringify(body) } : usesVideoStatusPath ? {} : { body: JSON.stringify({ job_id: existingVideoTaskId }) }),
      signal: controller.signal,
      redirect: 'error',
    })
    const payload = await readBoundedResponseText(response, 1 * 1024 * 1024, 'model relay response')
      .then(text => JSON.parse(text) as unknown)
      .catch(() => undefined)
    const providerRequestId = extractProviderRequestId(payload, response.headers)
    if (!response.ok) return blockHttpProbe(common, response.status, providerRequestId)
    let measured: Awaited<ReturnType<typeof evaluateRelayUsageEvidence>>
    try { measured = await evaluateRelayUsageEvidence(payload, response.headers, modality, model) }
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
    return finalizeSuccessfulProbe({
      ...common,
      httpStatus: response.status,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(videoEvaluation?.providerJobId ? { providerJobId: videoEvaluation.providerJobId } : {}),
      ...measured,
      responseValid: valid,
      ...(valid ? {} : { responseFailure: videoEvaluation?.reason ?? 'response_shape_incompatible' }),
    })
  } catch (error) {
    return { ...common, state: 'blocked', detail: error instanceof Error ? error.name === 'AbortError' ? 'timeout' : error.message : 'probe_failed' }
  } finally { clearTimeout(timer) }
}

export async function main() {
  if (process.argv.includes('--probe')) {
    const results: ProbeResult[] = []
    if (!base || (!key && !videoKey)) {
      console.error(JSON.stringify({ state: 'blocked', reason: !base ? 'MODEL_RELAY_BASE_URL missing' : 'MODEL_RELAY_API_KEY and VIDEO_MODEL_RELAY_API_KEY missing' }))
      process.exitCode = 1
    } else {
      try {
        if (!relaySecurity) throw new Error('MODEL_RELAY_BASE_URL/ALLOWED_HOSTS 不满足 relay 安全配置')
        for (const modality of ['text', 'image', 'image_edit', 'ocr', 'video'] as const) results.push(await probe(modality))
        // The evidence contract stores the relay origin; each result carries its
        // endpoint path. This keeps /v1 configuration paths out of the origin
        // field and makes generated evidence compatible with its validator.
        const relayOrigin = new URL(base).origin
        const evidence = { schema_version: '1', release_id: process.env.RELEASE_ID?.trim() || '', generated_at: new Date().toISOString(), environment: process.env.NODE_ENV?.trim() || '', simulated: false, relay: relayOrigin, results }
        const evidencePath = process.env.MODEL_RELAY_EVIDENCE_PATH?.trim()
        if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
        console.log(JSON.stringify(evidence, null, 2))
        if (results.some(result => result.state !== 'ready' || result.providerRequestId === undefined || result.usageObserved !== true || result.costObserved !== true)) process.exitCode = 1
      } catch (error) {
        console.error(JSON.stringify({ state: 'blocked', reason: error instanceof Error ? error.message : 'relay_probe_failed' }))
        process.exitCode = 1
      }
    }
  } else {
    console.error('使用 --probe 才会发起真实中转请求；媒体请求还需要 MODEL_RELAY_CANARY_CONFIRM=true。')
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
