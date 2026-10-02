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
import { createHash, randomUUID } from 'node:crypto'

export type RelayCredential = 'model' | 'video'
export type RelayQuotaSnapshot = { configFingerprint: string; checkedAt: number; expiresAt: number; available: number; reason?: string; nextRetryAt?: number }
/**
 * Cross-process storage for the platform quota snapshot.  The monitor never
 * puts a user request on this path: one process acquires the short lease and
 * refreshes the relay, while every other process only reads the snapshot.
 */
export interface RelayQuotaSnapshotStore {
  read(credential: RelayCredential): Promise<RelayQuotaSnapshot | undefined>
  write(credential: RelayCredential, snapshot: RelayQuotaSnapshot, ttlMs: number, ownerId: string): Promise<void>
  tryAcquire(credential: RelayCredential, ownerId: string, ttlMs: number): Promise<boolean>
  release(credential: RelayCredential, ownerId: string): Promise<void>
  close?: () => Promise<void>
}
export interface PlatformRelayQuotaMonitorOptions {
  store?: RelayQuotaSnapshotStore
  /** Production app processes set this so no-Redis deployments stay unknown. */
  requireSharedStore?: boolean
  refreshIntervalMs?: number
  maxAgeMs?: number
  cacheTtlMs?: number
  /** Background Redis reads; this never changes upstream polling cadence. */
  sharedSyncIntervalMs?: number
  ownerId?: string
}
type QuotaState = RelayQuotaSnapshot
type RelayQuotaMonitor = {
  baseUrl: string
  modelKey: string
  videoKey: string
  states: Record<RelayCredential, QuotaState>
  retryAt: Record<RelayCredential, number>
  fingerprints: Record<RelayCredential, string>
  store?: RelayQuotaSnapshotStore
  requireSharedStore: boolean
  ownerId: string
  refreshIntervalMs: number
  maxAgeMs: number
  cacheTtlMs: number
  syncIntervalMs: number
  timer: ReturnType<typeof setInterval>
}
let relayQuotaMonitor: RelayQuotaMonitor | undefined
export const DEFAULT_RELAY_QUOTA_REFRESH_MS = 5 * 60_000
export const DEFAULT_RELAY_QUOTA_MAX_AGE_MS = 15 * 60_000
export const MIN_RELAY_QUOTA_REFRESH_MS = 30_000
export const MAX_RELAY_QUOTA_REFRESH_MS = 60 * 60_000
export const MIN_RELAY_QUOTA_MAX_AGE_MS = 90_000
export const MAX_RELAY_QUOTA_MAX_AGE_MS = 24 * 60 * 60_000
export const MIN_RELAY_QUOTA_CACHE_TTL_MS = 20 * 60_000

function boundedMilliseconds(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
}

export interface RelayQuotaMonitorTiming {
  refreshIntervalMs: number
  maxAgeMs: number
  cacheTtlMs: number
}

export function relayQuotaMonitorTiming(source: ModelEnvironment, options: PlatformRelayQuotaMonitorOptions = {}): RelayQuotaMonitorTiming {
  const refreshIntervalMs = boundedMilliseconds(options.refreshIntervalMs === undefined ? source.MODEL_RELAY_QUOTA_REFRESH_MS : String(options.refreshIntervalMs), DEFAULT_RELAY_QUOTA_REFRESH_MS, MIN_RELAY_QUOTA_REFRESH_MS, MAX_RELAY_QUOTA_REFRESH_MS)
  const configuredMaxAge = boundedMilliseconds(options.maxAgeMs === undefined ? source.MODEL_RELAY_QUOTA_MAX_AGE_MS : String(options.maxAgeMs), DEFAULT_RELAY_QUOTA_MAX_AGE_MS, MIN_RELAY_QUOTA_MAX_AGE_MS, MAX_RELAY_QUOTA_MAX_AGE_MS)
  // A snapshot must survive at least one missed poll, while still failing
  // closed before the relay's budget can drift indefinitely.
  const maxAgeMs = Math.max(configuredMaxAge, refreshIntervalMs * 2)
  const configuredTtl = boundedMilliseconds(options.cacheTtlMs === undefined ? source.MODEL_RELAY_QUOTA_CACHE_TTL_MS : String(options.cacheTtlMs), MIN_RELAY_QUOTA_CACHE_TTL_MS, MIN_RELAY_QUOTA_CACHE_TTL_MS, 7 * 24 * 60 * 60_000)
  return { refreshIntervalMs, maxAgeMs, cacheTtlMs: Math.max(configuredTtl, maxAgeMs + refreshIntervalMs) }
}

function relayQuotaConfigFingerprint(baseUrl: string, key: string): string {
  return createHash('sha256').update(`${baseUrl}\n${key}`).digest('hex')
}

/** Read-only relay token checks are cached across health and generation calls.
 * Unknown, stale, unlimited and expired quota always block production traffic.
 * With a shared store, only one site process polls the relay; user requests
 * synchronously inspect the last snapshot and never call the relay directly. */
export function startPlatformRelayTokenQuotaMonitor(source: ModelEnvironment, fetcher: typeof fetch = fetch, options: PlatformRelayQuotaMonitorOptions = {}): () => Promise<void> {
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim() ?? ''
  const modelKey = source.MODEL_RELAY_API_KEY?.trim() ?? ''
  const videoKey = source.VIDEO_MODEL_RELAY_API_KEY?.trim() || modelKey
  if (relayQuotaMonitor) clearInterval(relayQuotaMonitor.timer)
  const fingerprints = { model: relayQuotaConfigFingerprint(baseUrl, modelKey), video: relayQuotaConfigFingerprint(baseUrl, videoKey) }
  const unknown = (credential: RelayCredential): QuotaState => ({ configFingerprint: fingerprints[credential], checkedAt: 0, expiresAt: 0, available: 0, reason: 'relay_token_quota_unknown' })
  const timing = relayQuotaMonitorTiming(source, options)
  const monitor: RelayQuotaMonitor = {
    baseUrl, modelKey, videoKey, fingerprints, states: { model: unknown('model'), video: unknown('video') }, retryAt: { model: 0, video: 0 },
    ...(options.store ? { store: options.store } : {}), requireSharedStore: options.requireSharedStore === true,
    ownerId: options.ownerId?.trim() || `relay-quota-${randomUUID()}`, ...timing,
    syncIntervalMs: options.sharedSyncIntervalMs !== undefined && Number.isSafeInteger(options.sharedSyncIntervalMs) && options.sharedSyncIntervalMs > 0
      ? Math.min(options.sharedSyncIntervalMs, timing.refreshIntervalMs)
      : options.store ? Math.min(15_000, timing.refreshIntervalMs) : timing.refreshIntervalMs,
    timer: undefined as unknown as ReturnType<typeof setInterval>,
  }
  const retryAfterMs = (value: string | null): number => {
    const fallback = monitor.refreshIntervalMs
    if (!value?.trim()) return fallback
    const seconds = Number(value.trim())
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.max(seconds * 1000, fallback), 10 * 60_000)
    const date = Date.parse(value)
    return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), fallback), 10 * 60_000) : fallback
  }
  relayQuotaMonitor = monitor
  // When model and video use the same relay credential, both modalities must
  // share the Redis snapshot and lease as well as the in-process fetch. This
  // prevents two replicas from acquiring different modality leases for one
  // upstream token at the same time.
  const sharedCredential = (credential: RelayCredential): RelayCredential => modelKey && modelKey === videoKey ? 'model' : credential
  const applySharedSnapshot = (credential: RelayCredential, snapshot: RelayQuotaSnapshot | undefined): boolean => {
    const now = Date.now()
    if (!snapshot || snapshot.configFingerprint !== monitor.fingerprints[credential]
      || !Number.isSafeInteger(snapshot.checkedAt) || snapshot.checkedAt < 0 || snapshot.checkedAt > now + 5 * 60_000
      || !Number.isSafeInteger(snapshot.expiresAt) || snapshot.expiresAt < 0
      || !Number.isSafeInteger(snapshot.available) || snapshot.available < 0
      || (snapshot.reason !== undefined && !/^relay_token_[a-z0-9_]+$/u.test(snapshot.reason))
      || (snapshot.nextRetryAt !== undefined && (!Number.isSafeInteger(snapshot.nextRetryAt) || snapshot.nextRetryAt < 0))) return false
    const current = monitor.states[credential]
    if (snapshot.checkedAt < current.checkedAt) return true
    monitor.states[credential] = {
      configFingerprint: monitor.fingerprints[credential],
      checkedAt: snapshot.checkedAt,
      expiresAt: Number.isSafeInteger(snapshot.expiresAt) ? snapshot.expiresAt : 0,
      available: Number.isSafeInteger(snapshot.available) ? snapshot.available : 0,
      ...(typeof snapshot.reason === 'string' ? { reason: snapshot.reason } : {}),
      ...(Number.isSafeInteger(snapshot.nextRetryAt) ? { nextRetryAt: snapshot.nextRetryAt } : {}),
    }
    monitor.retryAt[credential] = snapshot.nextRetryAt ?? 0
    return true
  }
  const markSharedStoreUnavailable = (credential: RelayCredential): void => {
    monitor.states[credential] = {
      configFingerprint: monitor.fingerprints[credential], checkedAt: 0, expiresAt: 0, available: 0,
      reason: 'relay_token_quota_shared_store_unavailable',
    }
    monitor.retryAt[credential] = 0
  }
  const readSharedSnapshot = async (credential: RelayCredential): Promise<boolean> => {
    if (!monitor.store) return true
    try {
      const hadSnapshot = monitor.states[credential].checkedAt > 0
      const snapshot = await monitor.store.read(sharedCredential(credential))
      if (!snapshot) {
        if (hadSnapshot) markSharedStoreUnavailable(credential)
        return true
      }
      if (!applySharedSnapshot(credential, snapshot) && hadSnapshot) markSharedStoreUnavailable(credential)
      return true
    } catch {
      // A failed shared read must not fall back to one poll per replica or
      // continue using a snapshot whose cross-process freshness is unknown.
      markSharedStoreUnavailable(credential)
      return false
    }
  }
  const retrySharedRead = async (credential: RelayCredential): Promise<void> => {
    if (!monitor.store) return
    // Give the lease owner a short opportunity to publish its result at
    // startup. This is bounded and runs in the background, never in a request.
    for (const delayMs of [25, 50, 100]) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs))
      if (!await readSharedSnapshot(credential)) return
      if (monitor.states[credential].checkedAt > 0) return
    }
  }
  const fetchSnapshot = async (credential: RelayCredential, key: string): Promise<QuotaState> => {
    if (monitor.retryAt[credential] > Date.now()) return monitor.states[credential]
    let state: QuotaState
    try {
      const relay = evaluatePlatformModelRelayConfiguration(source)
      if (!relay.ready || !key) throw new Error('relay_token_configuration_invalid')
      const response = await fetcher(new URL('/api/usage/token/', baseUrl), {
        headers: { accept: 'application/json', authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        if (response.status === 429) {
          // The model and video retry windows remain independent.
          monitor.retryAt[credential] = Math.max(monitor.retryAt[credential], Date.now() + retryAfterMs(response.headers.get('retry-after')))
          throw new Error('relay_token_quota_rate_limited')
        }
        throw new Error(response.status === 401 || response.status === 403 ? 'relay_token_auth_failed' : 'relay_token_quota_http_error')
      }
      if (monitor.retryAt[credential] <= Date.now()) monitor.retryAt[credential] = 0
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
      monitor.retryAt[credential] = 0
      state = { configFingerprint: monitor.fingerprints[credential], checkedAt: Date.now(), expiresAt: expiresAt as number, available: available as number }
    } catch (error) {
      const reason = error instanceof Error && error.message.startsWith('relay_token_') ? error.message : 'relay_token_quota_unavailable'
      const nextRetryAt = monitor.retryAt[credential]
      state = { configFingerprint: monitor.fingerprints[credential], checkedAt: Date.now(), expiresAt: 0, available: 0, reason, ...(nextRetryAt > 0 ? { nextRetryAt } : {}) }
    }
    return state
  }
  const refresh = async (credential: RelayCredential, key: string): Promise<void> => {
    if (monitor.store && !await readSharedSnapshot(credential)) return
    if (monitor.requireSharedStore && !monitor.store) return
    const current = monitor.states[credential]
    const now = Date.now()
    if ((current.checkedAt > 0 && now - current.checkedAt < monitor.refreshIntervalMs) || (current.nextRetryAt !== undefined && current.nextRetryAt > now)) return
    let acquired = true
    if (monitor.store) {
      try { acquired = await monitor.store.tryAcquire(sharedCredential(credential), monitor.ownerId, Math.max(15_000, Math.min(120_000, monitor.refreshIntervalMs / 2))) } catch { markSharedStoreUnavailable(credential); return }
      if (!acquired) { await retrySharedRead(credential); return }
    }
    try {
      const state = await fetchSnapshot(credential, key)
      if (relayQuotaMonitor === monitor) monitor.states[credential] = state
      if (monitor.store) {
        try { await monitor.store.write(sharedCredential(credential), state, monitor.cacheTtlMs, monitor.ownerId) } catch { markSharedStoreUnavailable(credential) }
      }
    } finally {
      if (monitor.store && acquired) await monitor.store.release(sharedCredential(credential), monitor.ownerId).catch(() => undefined)
    }
  }
  const refreshBoth = () => {
    // A relay token shared by both modalities has one quota document. Avoid
    // issuing two identical upstream reads while preserving per-credential
    // state and retry windows when separate keys are configured.
    if (modelKey && modelKey === videoKey) {
      void refresh('model', modelKey).then(async () => {
        if (relayQuotaMonitor !== monitor) return
        const state = monitor.states.model
        monitor.states.video = { ...state }
        monitor.retryAt.video = monitor.retryAt.model
        // The model write already populated the shared key. Do not write a
        // second copy after the model lease has been released.
      })
      return
    }
    void refresh('model', modelKey)
    void refresh('video', videoKey)
  }
  refreshBoth()
  // Shared stores are synchronized frequently without increasing upstream
  // traffic: refresh() reads Redis every sync tick but fetches only when the
  // snapshot reaches refreshIntervalMs.
  monitor.timer = setInterval(refreshBoth, monitor.syncIntervalMs)
  monitor.timer.unref?.()
  return async () => {
    if (relayQuotaMonitor === monitor) {
      clearInterval(monitor.timer)
      relayQuotaMonitor = undefined
      const close = monitor.store?.close
      if (close) await close().catch(() => undefined)
    }
  }
}

function relayQuotaReasons(source: ModelEnvironment, credential: RelayCredential): string[] {
  if (source.NODE_ENV !== 'production') return []
  if (!relayQuotaMonitor) return ['relay_token_quota_monitor_unavailable']
  const monitor = relayQuotaMonitor
  const expectedKey = credential === 'video' ? source.VIDEO_MODEL_RELAY_API_KEY?.trim() || source.MODEL_RELAY_API_KEY?.trim() || '' : source.MODEL_RELAY_API_KEY?.trim() || ''
  if (source.MODEL_RELAY_BASE_URL?.trim() !== monitor.baseUrl || expectedKey !== (credential === 'video' ? monitor.videoKey : monitor.modelKey)) return ['relay_token_monitor_config_mismatch']
  const state = monitor.states[credential]
  if (state.reason) return [state.reason]
  if (!state.checkedAt || Date.now() - state.checkedAt > monitor.maxAgeMs) return ['relay_token_quota_stale']
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
