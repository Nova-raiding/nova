export type PlatformModelKind = 'text' | 'image' | 'image_edit' | 'ocr' | 'video'
export type ModelEnvironment = Record<string, string | undefined>

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

export function evaluatePlatformModelRelayGate(source: ModelEnvironment): { ready: boolean; reasons: string[]; endpointHost?: string } {
  const relay = source.MODEL_RELAY_BASE_URL?.trim()
  if (!relay) return { ready: false, reasons: ['model_relay_endpoint_missing'] }
  try {
    const parsed = new URL(relay)
    if (parsed.protocol !== 'https:') return { ready: false, reasons: ['model_relay_endpoint_must_use_https'], endpointHost: parsed.host }
    return { ready: true, reasons: [], endpointHost: parsed.host }
  } catch { return { ready: false, reasons: ['model_relay_endpoint_invalid'] } }
}

export function evaluatePlatformModelGate(source: ModelEnvironment, kind: PlatformModelKind): PlatformModelGateResult {
  const endpoint = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = kind === 'video'
    ? source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim()
    : source.MODEL_RELAY_API_KEY?.trim()
  const model = kind === 'text'
    ? source.AI_MODEL?.trim() ?? source.MODEL_ID?.trim()
    : kind === 'image'
      ? source.IMAGE_MODEL?.trim() ?? source.AI_IMAGE_MODEL?.trim()
      : kind === 'image_edit'
        ? source.IMAGE_EDIT_MODEL?.trim() ?? source.IMAGE_MODEL?.trim() ?? source.AI_IMAGE_MODEL?.trim()
      : kind === 'ocr'
        ? source.OCR_MODEL?.trim() ?? source.AI_VISION_MODEL?.trim()
        : source.VIDEO_MODEL?.trim() ?? source.AI_VIDEO_MODEL?.trim()
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
    } catch { reasons.push('endpoint_invalid') }
  }
  if (!apiKey) reasons.push('api_key_missing')
  if (!model) reasons.push('model_missing')
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
