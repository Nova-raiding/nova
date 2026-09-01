export type PlatformModelKind = 'text' | 'image' | 'image_edit' | 'ocr' | 'video'
export type ModelEnvironment = Record<string, string | undefined>

/** Configuration examples must never make a provider appear ready. Keep this
 * local to the AI boundary so readiness and provider factories share the same
 * fail-closed interpretation without importing runtime configuration state. */
export function isPlaceholderModelConfiguration(value: string | undefined): boolean {
  if (!value?.trim()) return true
  const normalized = value.trim().toLowerCase()
  return /(?:replace[_-]?with|your[_-]?|change[_-]?me|dummy|example\.com|test-secret|<secret>|<value>|\$\{[^}]+\}|由.+注入|你的)/u.test(normalized)
}
import { inspectOutboundUrl, isSecureEnvironment } from '../../connectors/src/outbound-security.js'

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
  text: 'MODEL_TEXT_MAX_REQUEST_CNY', image: 'MODEL_IMAGE_MAX_REQUEST_CNY', image_edit: 'MODEL_IMAGE_EDIT_MAX_REQUEST_CNY', ocr: 'MODEL_OCR_MAX_REQUEST_CNY', video: 'MODEL_VIDEO_MAX_REQUEST_CNY',
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

export function evaluatePlatformModelRelayGate(source: ModelEnvironment): { ready: boolean; reasons: string[]; endpointHost?: string } {
  const relay = source.MODEL_RELAY_BASE_URL?.trim()
  if (!relay) return { ready: false, reasons: ['model_relay_endpoint_missing'] }
  try {
    const parsed = new URL(relay)
    if (parsed.protocol !== 'https:') return { ready: false, reasons: ['model_relay_endpoint_must_use_https'], endpointHost: parsed.host }
    const allowedHosts = (source.MODEL_RELAY_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
    if (isSecureEnvironment(source.NODE_ENV) && !allowedHosts.length) return { ready: false, reasons: ['model_relay_allowed_hosts_missing'], endpointHost: parsed.host }
    const reason = inspectOutboundUrl(relay, { environment: source.NODE_ENV, ...(allowedHosts.length ? { allowedHosts } : {}), resolveDns: false })
    if (reason === 'HOST_NOT_ALLOWLISTED') return { ready: false, reasons: ['model_relay_host_not_allowlisted'], endpointHost: parsed.host }
    return { ready: true, reasons: [], endpointHost: parsed.host }
  } catch { return { ready: false, reasons: ['model_relay_endpoint_invalid'] } }
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
      else if (allowedHosts.length && inspectOutboundUrl(endpoint, { environment: source.NODE_ENV, allowedHosts, resolveDns: false }) === 'HOST_NOT_ALLOWLISTED') reasons.push('model_relay_host_not_allowlisted')
    } catch { reasons.push('endpoint_invalid') }
  }
  if (!apiKey) reasons.push('api_key_missing')
  else if (isPlaceholderModelConfiguration(apiKey)) reasons.push('api_key_placeholder')
  if (!model) reasons.push('model_missing')
  else if (isPlaceholderModelConfiguration(model)) reasons.push('model_placeholder')
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
