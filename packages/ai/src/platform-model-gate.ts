export type PlatformModelKind = 'text' | 'image' | 'image_edit' | 'ocr' | 'video' | 'embedding'
export type ModelEnvironment = Record<string, string | undefined>

/** Configuration examples must never make a provider appear ready. Keep this
 * local to the AI boundary so readiness and provider factories share the same
 * fail-closed interpretation without importing runtime configuration state. */
export function isPlaceholderModelConfiguration(value: string | undefined): boolean {
  if (!value?.trim()) return true
  const normalized = value.trim().toLowerCase()
  return /(?:replace[_-]?with|your[_-]?|change[_-]?me|dummy|example\.com|test-secret|<secret>|<value>|\$\{[^}]+\}|由.+注入|你的)/u.test(normalized)
}
import { inspectOutboundUrl, isSecureEnvironment, type OutboundSecurityReason } from '../../connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'

type RelayCredential = 'model' | 'video'
type QuotaState = { checkedAt: number; expiresAt: number; available: number; reason?: string }
type RelayQuotaMonitor = {
  baseUrl: string
  modelKey: string
  videoKey: string
  states: Record<RelayCredential, QuotaState>
  retryAt: number
  timer: ReturnType<typeof setInterval>
}
let relayQuotaMonitor: RelayQuotaMonitor | undefined
const RELAY_QUOTA_REFRESH_MS = 30_000
const RELAY_QUOTA_MAX_AGE_MS = 90_000

/** Read-only relay token checks are cached across health and generation calls.
 * Unknown, stale, unlimited and expired quota always block production traffic. */
export function startPlatformRelayTokenQuotaMonitor(source: ModelEnvironment, fetcher: typeof fetch = fetch): () => void {
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim() ?? ''
  const modelKey = source.MODEL_RELAY_API_KEY?.trim() ?? ''
  const videoKey = source.VIDEO_MODEL_RELAY_API_KEY?.trim() || modelKey
  if (relayQuotaMonitor) clearInterval(relayQuotaMonitor.timer)
  const unknown = (): QuotaState => ({ checkedAt: 0, expiresAt: 0, available: 0, reason: 'relay_token_quota_unknown' })
  const monitor: RelayQuotaMonitor = { baseUrl, modelKey, videoKey, states: { model: unknown(), video: unknown() }, retryAt: 0, timer: undefined as unknown as ReturnType<typeof setInterval> }
  const retryAfterMs = (value: string | null): number => {
    const fallback = RELAY_QUOTA_REFRESH_MS
    if (!value?.trim()) return fallback
    const seconds = Number(value.trim())
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.max(seconds * 1000, fallback), 10 * 60_000)
    const date = Date.parse(value)
    return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), fallback), 10 * 60_000) : fallback
  }
  relayQuotaMonitor = monitor
  const refresh = async (credential: RelayCredential, key: string): Promise<void> => {
    if (monitor.retryAt > Date.now()) return
    let state: QuotaState
    try {
      const relay = evaluatePlatformModelRelayConfiguration(source)
      if (!relay.ready || !key) throw new Error('relay_token_configuration_invalid')
      const response = await fetcher(new URL('/api/usage/token/', baseUrl), {
        headers: { accept: 'application/json', authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        if (response.status === 429) {
          // The model and video lookups run concurrently. A shorter retry
          // window from the second response must not erase the first one.
          monitor.retryAt = Math.max(monitor.retryAt, Date.now() + retryAfterMs(response.headers.get('retry-after')))
          throw new Error('relay_token_quota_rate_limited')
        }
        throw new Error(response.status === 401 || response.status === 403 ? 'relay_token_auth_failed' : 'relay_token_quota_http_error')
      }
      if (monitor.retryAt <= Date.now()) monitor.retryAt = 0
      const root = JSON.parse(await readBoundedResponseText(response, 16 * 1024, 'relay token quota')) as { code?: unknown; success?: unknown; data?: Record<string, unknown> }
      const data = root?.data
      if ((root?.code !== true && root?.success !== true) || data?.object !== 'token_usage') throw new Error('relay_token_quota_invalid')
      const granted = data.total_granted
      const used = data.total_used
      const available = data.total_available
      const expiresAt = data.expires_at
      if (data.unlimited_quota !== false) throw new Error('relay_token_quota_unlimited')
      if (![granted, used, available, expiresAt].every(value => typeof value === 'number' && Number.isSafeInteger(value))
        || (granted as number) <= 0 || (used as number) < 0 || (available as number) <= 0
        || (used as number) + (available as number) !== granted || (expiresAt as number) < 0
        || ((expiresAt as number) !== 0 && (expiresAt as number) <= Date.now() / 1000)) {
        throw new Error('relay_token_quota_expired_or_exhausted')
      }
      state = { checkedAt: Date.now(), expiresAt: expiresAt as number, available: available as number }
    } catch (error) {
      const reason = error instanceof Error && error.message.startsWith('relay_token_') ? error.message : 'relay_token_quota_unavailable'
      state = { checkedAt: Date.now(), expiresAt: 0, available: 0, reason }
    }
    if (relayQuotaMonitor === monitor) monitor.states[credential] = state
  }
  const refreshBoth = () => { void refresh('model', modelKey); void refresh('video', videoKey) }
  refreshBoth()
  monitor.timer = setInterval(refreshBoth, RELAY_QUOTA_REFRESH_MS)
  monitor.timer.unref?.()
  return () => { if (relayQuotaMonitor === monitor) { clearInterval(monitor.timer); relayQuotaMonitor = undefined } }
}

function relayQuotaReasons(source: ModelEnvironment, credential: RelayCredential): string[] {
  if (source.NODE_ENV !== 'production') return []
  if (!relayQuotaMonitor) return ['relay_token_quota_monitor_unavailable']
  const monitor = relayQuotaMonitor
  const expectedKey = credential === 'video' ? source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim() || '' : source.MODEL_RELAY_API_KEY?.trim() || ''
  if (source.MODEL_RELAY_BASE_URL?.trim() !== monitor.baseUrl || expectedKey !== (credential === 'video' ? monitor.videoKey : monitor.modelKey)) return ['relay_token_monitor_config_mismatch']
  const state = monitor.states[credential]
  if (state.reason) return [state.reason]
  if (!state.checkedAt || Date.now() - state.checkedAt > RELAY_QUOTA_MAX_AGE_MS) return ['relay_token_quota_stale']
  if ((state.expiresAt !== 0 && state.expiresAt <= Date.now() / 1000) || state.available <= 0) return ['relay_token_quota_expired_or_exhausted']
  return []
}

/**
 * Classify an outbound-security rejection so readiness can report the same
 * verdict the adapters enforce. `relaySecurityFromEnv` refuses every one of
 * these reasons, so a gate that only surfaces `HOST_NOT_ALLOWLISTED` claims a
 * private, credentialed or otherwise unsafe relay is usable while no adapter
 * can ever be assembled from it.
 */
function outboundEndpointRejection(reason: OutboundSecurityReason | undefined): 'host_not_allowlisted' | 'host_blocked' | 'endpoint_invalid' | 'endpoint_must_use_https' | undefined {
  if (reason === undefined) return undefined
  if (reason === 'HOST_NOT_ALLOWLISTED') return 'host_not_allowlisted'
  if (reason === 'PRIVATE_ADDRESS_BLOCKED') return 'host_blocked'
  return reason === 'HTTPS_REQUIRED' ? 'endpoint_must_use_https' : 'endpoint_invalid'
}

export interface PlatformModelGateResult {
  ready: boolean
  https: boolean
  endpointHost?: string
  reasons: string[]
}

export interface PlatformModelCostGateResult {
  ready: boolean
  rpm: number
  tpm: number
  dailyCnyLimit: number
  reasons: string[]
}

export interface PlatformModelRequestCostResult {
  ready: boolean
  costCny: number
  limitCny: number
  reasons: string[]
}

export function evaluatePlatformModelTaskCostLimit(source: ModelEnvironment): PlatformModelRequestCostResult {
  const limitCny = Number(source.MODEL_MAX_TASK_COST_CNY ?? 0)
  const dailyCnyLimit = Number(source.MODEL_DAILY_CNY_LIMIT ?? 0)
  const reasons: string[] = []
  if (!Number.isFinite(limitCny) || limitCny <= 0) reasons.push('task_cny_limit_missing_or_invalid')
  if (Number.isFinite(limitCny) && limitCny > 0 && Number.isFinite(dailyCnyLimit) && dailyCnyLimit > 0 && limitCny > dailyCnyLimit) reasons.push('task_cny_limit_exceeds_daily_limit')
  return { ready: reasons.length === 0, costCny: 0, limitCny: Number.isFinite(limitCny) && limitCny > 0 ? limitCny : 0, reasons }
}

export function evaluatePlatformModelTaskRequestCost(costCny: number, source: ModelEnvironment): PlatformModelRequestCostResult {
  const limit = evaluatePlatformModelTaskCostLimit(source)
  const reasons = [...limit.reasons]
  if (!Number.isFinite(costCny) || costCny < 0) reasons.push('request_cost_missing_or_invalid')
  if (reasons.length === 0 && costCny > limit.limitCny) reasons.push('request_cost_exceeds_task_limit')
  return { ready: reasons.length === 0, costCny: Number.isFinite(costCny) && costCny >= 0 ? costCny : 0, limitCny: limit.limitCny, reasons }
}

export interface PlatformModelBudgetEstimate {
  ready: boolean
  amountCny: number
  version?: string
  reasons: string[]
}

const MODEL_BUDGET_ESTIMATE_KEYS: Record<PlatformModelKind, string> = {
  text: 'MODEL_TEXT_MAX_REQUEST_CNY', image: 'MODEL_IMAGE_MAX_REQUEST_CNY', image_edit: 'MODEL_IMAGE_EDIT_MAX_REQUEST_CNY', ocr: 'MODEL_OCR_MAX_REQUEST_CNY', video: 'MODEL_VIDEO_MAX_REQUEST_CNY', embedding: 'MODEL_EMBEDDING_MAX_REQUEST_CNY',
}

/** Versioned conservative request ceilings. Missing production estimates are
 * intentionally not defaulted, so provider traffic fails closed. */
export function evaluatePlatformModelBudgetEstimate(source: ModelEnvironment, kind: PlatformModelKind): PlatformModelBudgetEstimate {
  const amountCny = Number(source[MODEL_BUDGET_ESTIMATE_KEYS[kind]] ?? 0)
  const version = source.MODEL_COST_ESTIMATE_VERSION?.trim()
  const reasons: string[] = []
  if (!Number.isFinite(amountCny) || amountCny <= 0) reasons.push('request_estimate_missing_or_invalid')
  if (!version) reasons.push('estimate_version_missing')
  return { ready: reasons.length === 0, amountCny: Number.isFinite(amountCny) && amountCny > 0 ? Number(amountCny.toFixed(12)) : 0, ...(version ? { version } : {}), reasons }
}

function evaluatePlatformModelRelayConfiguration(source: ModelEnvironment): { ready: boolean; reasons: string[]; endpointHost?: string } {
  const relay = source.MODEL_RELAY_BASE_URL?.trim()
  if (!relay) return { ready: false, reasons: ['model_relay_endpoint_missing'] }
  try {
    const parsed = new URL(relay)
    if (parsed.protocol !== 'https:') return { ready: false, reasons: ['model_relay_endpoint_must_use_https'], endpointHost: parsed.host }
    const allowedHosts = (source.MODEL_RELAY_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
    if (isSecureEnvironment(source.NODE_ENV) && !allowedHosts.length) return { ready: false, reasons: ['model_relay_allowed_hosts_missing'], endpointHost: parsed.host }
    const reason = inspectOutboundUrl(relay, { environment: source.NODE_ENV, ...(allowedHosts.length ? { allowedHosts } : {}), resolveDns: false })
    const rejection = outboundEndpointRejection(reason)
    if (rejection === 'host_not_allowlisted') return { ready: false, reasons: ['model_relay_host_not_allowlisted'], endpointHost: parsed.host }
    if (rejection === 'host_blocked') return { ready: false, reasons: ['model_relay_host_blocked'], endpointHost: parsed.host }
    if (rejection === 'endpoint_must_use_https') return { ready: false, reasons: ['model_relay_endpoint_must_use_https'], endpointHost: parsed.host }
    if (rejection) return { ready: false, reasons: ['model_relay_endpoint_invalid'], endpointHost: parsed.host }
    return { ready: true, reasons: [], endpointHost: parsed.host }
  } catch { return { ready: false, reasons: ['model_relay_endpoint_invalid'] } }
}

export function evaluatePlatformModelRelayGate(source: ModelEnvironment, credential: RelayCredential | 'all' = 'all'): { ready: boolean; reasons: string[]; endpointHost?: string } {
  const configuration = evaluatePlatformModelRelayConfiguration(source)
  const reasons = [...configuration.reasons, ...(credential === 'video' ? [] : relayQuotaReasons(source, 'model')), ...(credential === 'model' ? [] : relayQuotaReasons(source, 'video'))]
  return { ...configuration, ready: reasons.length === 0, reasons }
}

export function evaluatePlatformModelGate(source: ModelEnvironment, kind: PlatformModelKind): PlatformModelGateResult {
  const endpoint = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = kind === 'video'
    ? source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim()
    : source.MODEL_RELAY_API_KEY?.trim()
  const model = kind === 'text'
    ? source.AI_MODEL?.trim() || source.MODEL_ID?.trim()
    : kind === 'image'
      ? source.IMAGE_MODEL?.trim() || source.AI_IMAGE_MODEL?.trim()
      : kind === 'image_edit'
        ? source.IMAGE_EDIT_MODEL?.trim() || source.IMAGE_MODEL?.trim() || source.AI_IMAGE_MODEL?.trim()
      : kind === 'ocr'
        ? source.OCR_MODEL?.trim() || source.AI_VISION_MODEL?.trim()
        : kind === 'embedding'
          ? source.EMBEDDING_MODEL?.trim()
          : source.VIDEO_MODEL?.trim() || source.AI_VIDEO_MODEL?.trim()
  const reasons: string[] = []
  let https = false
  let endpointHost: string | undefined
  if (!endpoint) reasons.push('endpoint_missing')
  else {
    try {
      const parsed = new URL(endpoint)
      https = parsed.protocol === 'https:'
      endpointHost = parsed.host
      if (!https) reasons.push('endpoint_must_use_https')
      const allowedHosts = (source.MODEL_RELAY_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
      if (isSecureEnvironment(source.NODE_ENV) && !allowedHosts.length) reasons.push('model_relay_allowed_hosts_missing')
      else {
        const rejection = outboundEndpointRejection(inspectOutboundUrl(endpoint, { environment: source.NODE_ENV, ...(allowedHosts.length ? { allowedHosts } : {}), resolveDns: false }))
        // `endpoint_must_use_https` is already reported from the protocol check above.
        if (rejection === 'host_not_allowlisted') reasons.push('model_relay_host_not_allowlisted')
        else if (rejection === 'host_blocked') reasons.push('model_relay_host_blocked')
        else if (rejection === 'endpoint_invalid') reasons.push('endpoint_invalid')
      }
    } catch { reasons.push('endpoint_invalid') }
  }
  if (!apiKey) reasons.push('api_key_missing')
  else if (isPlaceholderModelConfiguration(apiKey)) reasons.push('api_key_placeholder')
  if (!model) reasons.push('model_missing')
  else if (isPlaceholderModelConfiguration(model)) reasons.push('model_placeholder')
  reasons.push(...relayQuotaReasons(source, kind === 'video' ? 'video' : 'model'))
  return { ready: reasons.length === 0, https, ...(endpointHost ? { endpointHost } : {}), reasons }
}

export function evaluatePlatformModelCostGate(source: ModelEnvironment): PlatformModelCostGateResult {
  const rpm = Number(source.MODEL_RPM_LIMIT ?? 0)
  const tpm = Number(source.MODEL_TPM_LIMIT ?? 0)
  const dailyCnyLimit = Number(source.MODEL_DAILY_CNY_LIMIT ?? 0)
  const reasons: string[] = []
  if (!Number.isFinite(rpm) || rpm <= 0) reasons.push('rpm_missing_or_invalid')
  if (!Number.isFinite(tpm) || tpm <= 0) reasons.push('tpm_missing_or_invalid')
  if (!Number.isFinite(dailyCnyLimit) || dailyCnyLimit <= 0) reasons.push('daily_cny_limit_missing_or_invalid')
  return { ready: reasons.length === 0, rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 0, tpm: Number.isFinite(tpm) && tpm > 0 ? tpm : 0, dailyCnyLimit: Number.isFinite(dailyCnyLimit) && dailyCnyLimit > 0 ? dailyCnyLimit : 0, reasons }
}

export function evaluatePlatformModelRequestCost(costCny: number, limitCny: number): PlatformModelRequestCostResult {
  const reasons: string[] = []
  if (!Number.isFinite(costCny) || costCny < 0) reasons.push('request_cost_missing_or_invalid')
  if (!Number.isFinite(limitCny) || limitCny <= 0) reasons.push('daily_cny_limit_missing_or_invalid')
  if (reasons.length === 0 && costCny > limitCny) reasons.push('request_cost_exceeds_daily_limit')
  return { ready: reasons.length === 0, costCny: Number.isFinite(costCny) && costCny >= 0 ? costCny : 0, limitCny: Number.isFinite(limitCny) && limitCny > 0 ? limitCny : 0, reasons }
}
