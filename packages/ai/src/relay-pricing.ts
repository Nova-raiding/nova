import type { RelayUsageRecord } from './relay-usage.js'
import { assertRelayUrl, relaySecurityFromEnv, type RelaySecurityPolicy } from './relay-security.js'

type FetchLike = typeof fetch

interface PricingModel {
  model_name: string
  quota_type: number
  model_ratio: number
  model_price: number
  completion_ratio: number
  enable_groups: string[]
  pricing_version?: string
  billing_mode?: string
  duration_pricing?: { fallback_price?: number; size_prices?: Record<string, number> }
}

interface PricingPayload {
  pricing_version: string
  group_ratio: Record<string, number>
  data: PricingModel[]
}

interface StatusPayload {
  data: {
    quota_per_unit: number
    usd_exchange_rate: number
    quota_display_type?: string
  }
}

export interface RelayPricingMetadata {
  pricing_version: string
  pricing_group: string
  group_ratio: number
  usd_exchange_rate: number
  quota_per_unit: number
  quota_type: number
  model_pricing_version?: string
  model_ratio: number
  model_price: number
  completion_ratio: number
  raw_quota: number
  rounded_quota: number
  formula_version: 'new-api-quota-v1' | 'relay-video-cny-per-second-v1' | 'relay-video-resolution-v1'
  video_price_cny_per_second?: number
}

export interface RelayPricingQuote {
  costCny: number
  metadata: RelayPricingMetadata & {
    cost_source: 'relay_pricing_snapshot'
  }
}

/**
 * A request-side estimate used for budget preauthorization, never for
 * settlement. It is deliberately a separate type from `RelayPricingQuote` and
 * carries a different `cost_source`, so an estimate can never be handed to a
 * settlement sink or mistaken for provider-verified cost evidence.
 */
export interface RelayPricingEstimate {
  costCny: number
  metadata: RelayPricingMetadata & {
    cost_source: 'relay_pricing_snapshot_estimate'
    estimate: true
  }
}

/**
 * The two pricing boundaries a caller may ask for.
 *
 * - `settlement` requires provider-reported metering evidence and is the only
 *   boundary that may be persisted as cost evidence.
 * - `request_estimate` accepts the caller's own bounded request-side inputs
 *   (for example the requested video duration) and must never be recorded as
 *   an actual cost.
 */
export type RelayPricingBoundary = 'settlement' | 'request_estimate'

/** Snapshot reads are internal settlement dependencies, so bound them in time
 * instead of inheriting undici's default (which is neither configured nor
 * cancellable by this process). */
const DEFAULT_PRICING_REQUEST_TIMEOUT_MS = 10_000

export class RelayPricingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RelayPricingError'
  }
}

export interface RelayPricingClientOptions {
  baseUrl: string
  apiKey: string
  group: string
  modalityGroups?: Partial<Record<RelayUsageRecord['modality'], string>>
  /** Explicit provider price overrides for relays whose duration ratio is quota-only. */
  videoPriceCnyPerSecond?: Record<string, number>
  fetch?: FetchLike
  ttlMs?: number
  /** Hard bound for each snapshot request; a stalled relay must not hold a
   * settlement or API request open until undici's default timeout. */
  requestTimeoutMs?: number
  relaySecurity?: RelaySecurityPolicy
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function pricingOrigin(baseUrl: string) {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:') throw new RelayPricingError('MODEL_PRICING_ENDPOINT_INVALID', 'relay pricing requires HTTPS')
  return parsed.origin
}

async function json(fetchImpl: FetchLike, url: string, apiKey: string | undefined, requestTimeoutMs: number): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      redirect: 'error',
      // A relay that accepts the connection and then stalls must fail the
      // settlement/settlement-preflight read deterministically instead of
      // pinning the caller (and its durable lease) for undici's default.
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new RelayPricingError('MODEL_PRICING_FETCH_TIMEOUT', `relay pricing did not answer within ${requestTimeoutMs}ms`)
    throw error
  }
  if (!response.ok) throw new RelayPricingError('MODEL_PRICING_FETCH_FAILED', `relay pricing returned HTTP ${response.status}`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new RelayPricingError('MODEL_PRICING_RESPONSE_TOO_LARGE', 'relay pricing response is too large')
  try { return JSON.parse(text) as unknown } catch { throw new RelayPricingError('MODEL_PRICING_RESPONSE_INVALID', 'relay pricing response is not JSON') }
}

function parsePricing(value: unknown): PricingPayload {
  const root = value as Partial<PricingPayload> | undefined
  if (!root || typeof root !== 'object' || typeof root.pricing_version !== 'string' || !root.pricing_version.trim() || !root.group_ratio || typeof root.group_ratio !== 'object' || !Array.isArray(root.data)) {
    throw new RelayPricingError('MODEL_PRICING_RESPONSE_INVALID', 'relay pricing snapshot is incomplete')
  }
  return root as PricingPayload
}

function parseStatus(value: unknown): StatusPayload['data'] {
  const data = (value as Partial<StatusPayload> | undefined)?.data
  if (!data || !finitePositive(data.quota_per_unit) || !finitePositive(data.usd_exchange_rate)) {
    throw new RelayPricingError('MODEL_PRICING_CURRENCY_INVALID', 'relay quota conversion evidence is incomplete')
  }
  return data
}

export class RelayPricingClient {
  private readonly fetchImpl: FetchLike
  private readonly requestTimeoutMs: number
  private snapshot?: { expiresAt: number; pricing: PricingPayload; status: StatusPayload['data'] }

  constructor(private readonly options: RelayPricingClientOptions) {
    if (!options.apiKey.trim() || !options.group.trim()) throw new RelayPricingError('MODEL_PRICING_CONFIG_INVALID', 'relay pricing key and group are required')
    pricingOrigin(options.baseUrl)
    this.fetchImpl = options.fetch ?? fetch
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_PRICING_REQUEST_TIMEOUT_MS
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new RelayPricingError('MODEL_PRICING_CONFIG_INVALID', 'relay pricing request timeout must be positive')
    this.requestTimeoutMs = requestTimeoutMs
  }

  private async load() {
    if (this.snapshot && this.snapshot.expiresAt > Date.now()) return this.snapshot
    const origin = pricingOrigin(this.options.baseUrl)
    if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(origin, this.options.relaySecurity)
    const [pricing, status] = await Promise.all([
      json(this.fetchImpl, `${origin}/api/pricing`, this.options.apiKey, this.requestTimeoutMs).then(parsePricing),
      // Pricing and currency conversion are one authenticated relay snapshot.
      // Do not let the status half of the snapshot cross the boundary without
      // the same credential as the pricing half.
      json(this.fetchImpl, `${origin}/api/status`, this.options.apiKey, this.requestTimeoutMs).then(parseStatus),
    ])
    this.snapshot = { pricing, status, expiresAt: Date.now() + (this.options.ttlMs ?? 60_000) }
    return this.snapshot
  }

  /** Provider/settlement-evidence pricing. Rejects every request-side estimate. */
  async quote(usage: RelayUsageRecord): Promise<RelayPricingQuote> {
    const derived = await this.deriveCost(usage, 'settlement')
    return { costCny: derived.costCny, metadata: { cost_source: 'relay_pricing_snapshot', ...derived.metadata } }
  }

  /**
   * Budget preauthorization pricing for a call that has not happened yet.
   *
   * This is the only entry point that accepts a caller-supplied duration, and
   * it only reads `preauthorization_duration_seconds` (never the provider
   * `duration_seconds`/`duration_evidence` pair), so the settlement boundary
   * in `quote()` stays intact. The returned metadata is marked as an estimate
   * and must not be persisted as actual cost.
   */
  async estimateRequestCost(usage: RelayUsageRecord): Promise<RelayPricingEstimate> {
    const derived = await this.deriveCost(usage, 'request_estimate')
    return { costCny: derived.costCny, metadata: { cost_source: 'relay_pricing_snapshot_estimate', estimate: true, ...derived.metadata } }
  }

  private async deriveCost(usage: RelayUsageRecord, boundary: RelayPricingBoundary): Promise<{ costCny: number; metadata: RelayPricingMetadata }> {
    const { pricing, status } = await this.load()
    const group = (this.options.modalityGroups?.[usage.modality] ?? this.options.group).trim()
    const groupRatio = pricing.group_ratio[group]
    if (!finitePositive(groupRatio)) throw new RelayPricingError('MODEL_PRICING_GROUP_INVALID', `relay pricing group ${group} has no positive ratio`)
    const model = pricing.data.find(item => item.model_name === usage.model)
    if (!model) throw new RelayPricingError('MODEL_PRICING_MODEL_MISSING', `relay pricing is missing model ${usage.model}`)
    if (!model.enable_groups.includes(group) && !model.enable_groups.includes('all')) {
      throw new RelayPricingError('MODEL_PRICING_GROUP_UNAVAILABLE', `model ${usage.model} is not enabled for relay group ${group}`)
    }

    let rawQuota: number
    let directCostCny: number | undefined
    let formulaVersion: RelayPricingQuote['metadata']['formula_version'] = 'new-api-quota-v1'
    let videoPriceCnyPerSecond: number | undefined
    if (model.quota_type === 0) {
      if (!finiteNonNegative(model.model_ratio) || !finiteNonNegative(model.completion_ratio) || !finiteNonNegative(usage.inputTokens) || !finiteNonNegative(usage.outputTokens)) {
        throw new RelayPricingError('MODEL_PRICING_TOKEN_EVIDENCE_MISSING', 'token pricing requires input and output token evidence')
      }
      const weightedTokens = usage.inputTokens + usage.outputTokens * model.completion_ratio
      rawQuota = weightedTokens * model.model_ratio * groupRatio
    } else if (model.quota_type === 1 && (usage.modality === 'image' || usage.modality === 'image_edit')) {
      if (!finitePositive(model.model_price)) throw new RelayPricingError('MODEL_PRICING_FIXED_PRICE_INVALID', 'fixed image price must be positive')
      const rawUnits = usage.metadata?.billing_units
      const units = typeof rawUnits === 'number' && Number.isInteger(rawUnits) && rawUnits > 0 ? rawUnits : 1
      rawQuota = model.model_price * units * groupRatio * status.quota_per_unit
    } else if (model.quota_type === 1 && usage.modality === 'video') {
      // The provider-reported duration and the caller's requested duration are
      // different facts. Settlement may only use the former; the request-side
      // estimate boundary may only use the latter, so neither path can silently
      // borrow the other's evidence.
      const estimatedDuration = usage.metadata?.preauthorization_estimate === true ? usage.metadata?.preauthorization_duration_seconds : undefined
      const rawDuration = usage.metadata?.duration_seconds
      const durationEvidence = usage.metadata?.duration_evidence
      const durationSeconds = boundary === 'request_estimate'
        ? (typeof estimatedDuration === 'number' && Number.isFinite(estimatedDuration) && estimatedDuration > 0 ? estimatedDuration : undefined)
        : (durationEvidence === 'provider_usage' && typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined)
      if (!durationSeconds) {
        throw boundary === 'request_estimate'
          ? new RelayPricingError('MODEL_PRICING_ESTIMATE_DURATION_MISSING', 'duration-priced video requires a positive request-side preauthorization duration estimate')
          : new RelayPricingError('MODEL_PRICING_DURATION_EVIDENCE_MISSING', 'duration-priced video requires positive duration evidence')
      }
      videoPriceCnyPerSecond = this.options.videoPriceCnyPerSecond?.[usage.model]
      if (model.billing_mode === 'per_duration' && model.duration_pricing) {
        videoPriceCnyPerSecond = undefined
        const resolution = typeof usage.metadata?.resolution === 'string' ? usage.metadata.resolution.toUpperCase() : undefined
        const price = resolution ? model.duration_pricing.size_prices?.[resolution] : undefined
        if (!finitePositive(price)) throw new RelayPricingError('MODEL_PRICING_RESOLUTION_REQUIRED', 'video pricing requires an explicitly priced output resolution')
        rawQuota = price * durationSeconds * groupRatio * status.quota_per_unit
        formulaVersion = 'relay-video-resolution-v1'
      } else if (finitePositive(videoPriceCnyPerSecond)) {
        // Some New API relays expose model_ratio as an internal quota ratio,
        // while their actual billing is published directly in CNY/second.
        // Do not convert that ratio into money a second time.
        directCostCny = videoPriceCnyPerSecond * durationSeconds
        rawQuota = directCostCny / status.usd_exchange_rate * status.quota_per_unit
        formulaVersion = 'relay-video-cny-per-second-v1'
      } else {
        if (!finitePositive(model.model_ratio)) throw new RelayPricingError('MODEL_PRICING_DURATION_RATIO_INVALID', 'duration-priced video ratio must be positive')
        rawQuota = model.model_ratio / 2 * durationSeconds * groupRatio * status.quota_per_unit
      }
    } else {
      throw new RelayPricingError('MODEL_PRICING_MODE_UNSUPPORTED', `cannot derive ${usage.modality} cost from this pricing mode`)
    }
    const roundedQuota = Math.floor(rawQuota + 0.5)
    const costCny = directCostCny !== undefined
      ? Number(directCostCny.toFixed(12))
      : Number((roundedQuota / status.quota_per_unit * status.usd_exchange_rate).toFixed(12))
    if (!finiteNonNegative(costCny)) throw new RelayPricingError('MODEL_PRICING_COST_INVALID', 'derived relay cost is invalid')
    return {
      costCny,
      metadata: {
        pricing_version: pricing.pricing_version,
        pricing_group: group,
        group_ratio: groupRatio,
        usd_exchange_rate: status.usd_exchange_rate,
        quota_per_unit: status.quota_per_unit,
        quota_type: model.quota_type,
        ...(model.pricing_version ? { model_pricing_version: model.pricing_version } : {}),
        model_ratio: model.model_ratio,
        model_price: model.model_price,
        completion_ratio: model.completion_ratio,
        raw_quota: rawQuota,
        rounded_quota: roundedQuota,
        formula_version: formulaVersion,
        ...(videoPriceCnyPerSecond !== undefined ? { video_price_cny_per_second: videoPriceCnyPerSecond } : {}),
      },
    }
  }
}

export function createRelayPricingClientFromEnv(source: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike) {
  if (source.MODEL_RELAY_PRICING_DERIVATION_ENABLED !== 'true') return undefined
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.MODEL_RELAY_API_KEY?.trim()
  const group = source.MODEL_RELAY_PRICING_GROUP?.trim()
  if (!baseUrl || !apiKey || !group) return undefined
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity) return undefined
  const modalityGroups = {
    ...(source.MODEL_RELAY_TEXT_PRICING_GROUP?.trim() ? { text: source.MODEL_RELAY_TEXT_PRICING_GROUP.trim() } : {}),
    ...(source.MODEL_RELAY_IMAGE_PRICING_GROUP?.trim() ? { image: source.MODEL_RELAY_IMAGE_PRICING_GROUP.trim() } : {}),
    ...(source.MODEL_RELAY_IMAGE_EDIT_PRICING_GROUP?.trim() ? { image_edit: source.MODEL_RELAY_IMAGE_EDIT_PRICING_GROUP.trim() } : {}),
    ...(source.MODEL_RELAY_OCR_PRICING_GROUP?.trim() ? { ocr: source.MODEL_RELAY_OCR_PRICING_GROUP.trim() } : {}),
    ...(source.MODEL_RELAY_VIDEO_PRICING_GROUP?.trim() ? { video: source.MODEL_RELAY_VIDEO_PRICING_GROUP.trim() } : {}),
    ...(source.MODEL_RELAY_EMBEDDING_PRICING_GROUP?.trim() ? { embedding: source.MODEL_RELAY_EMBEDDING_PRICING_GROUP.trim() } : {}),
  }
  let videoPriceCnyPerSecond: Record<string, number> | undefined
  const rawVideoPrices = source.MODEL_RELAY_VIDEO_PRICING_OVERRIDES?.trim()
  if (rawVideoPrices) {
    try {
      const parsed = JSON.parse(rawVideoPrices) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const valid = Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[0] === 'string' && finitePositive(entry[1]))
        if (valid.length) videoPriceCnyPerSecond = Object.fromEntries(valid)
      }
    } catch {
      throw new RelayPricingError('MODEL_PRICING_VIDEO_OVERRIDE_INVALID', 'video pricing overrides must be valid JSON')
    }
  }
  return new RelayPricingClient({ baseUrl, apiKey, group, relaySecurity, ...(Object.keys(modalityGroups).length ? { modalityGroups } : {}), ...(videoPriceCnyPerSecond ? { videoPriceCnyPerSecond } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) })
}
