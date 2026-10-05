import { createHash, randomUUID } from 'node:crypto'
import { assertSupportedCommercialCycleGrantPolicy } from '@merchant-marketing/application/commercial-upgrade-policy'
import { SqlPool } from './repository.js'
import { COMMERCIAL_BENEFIT_DEFINITIONS } from './commercial-benefit-definitions.js'
import { commercialPlanIdentity, commercialPurchasePolicy } from './commercial-transaction-policy.js'

export const PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY = 'commercial.private_sku.read' as const

export type CommercialCatalogLifecycle = 'draft' | 'pending_business_approval' | 'approved' | 'rejected' | 'retired'
export type CommercialSaleState = 'unlisted' | 'on_sale' | 'off_sale' | 'archived' | 'deleted'
export type CommercialCatalogVisibility = 'public' | 'private'

export interface CommercialCatalogBenefit {
  code: string
  quantity: number | null
  rawValue: string | null
  rawUnit: string | null
  normalizedValue: number | null
  policyRef: string | null
  metadata: Record<string, unknown>
}

export interface CommercialCatalogSkuSnapshot {
  id: string
  code: string
  saleState?: CommercialSaleState | null
  saleRevision?: number | null
  currentSaleVersionId?: string | null
  kind: 'onboarding' | 'monthly' | 'point_pack' | 'private_trial'
  visibility: CommercialCatalogVisibility
  requiredCapability: string | null
  versionId: string
  version: number
  lifecycle: CommercialCatalogLifecycle
  executable: boolean
  priceFen: number | null
  currency: 'CNY' | null
  priceMode: 'fixed' | 'starts_at' | 'custom'
  durationDays: number | null
  payload: Record<string, unknown>
  checksum: string
  effectiveAt: string | null
  benefits: CommercialCatalogBenefit[]
}

export interface ApprovedCreativePointRate {
  rateCardId: string
  version: number
  actionCode: string
  unit: 'image' | 'video' | 'request'
  integerPoints: number
  checksum: string
  effectiveAt: string
}

export interface ApprovedOcrCostRate {
  rateCardId: string
  version: number
  actionCode: 'ocr.extract'
  unit: 'request'
  pricingMode: 'variable'
  variableFormula: { kind: 'cost_cny_x2_ceil_min1' } | {
    kind: 'cost_cny_threshold_x2_ceil_v1'
    free_when_cost_cny_lte: 0.3
    multiplier: 2
    min_paid_points: 1
  }
  checksum: string
  effectiveAt: string
}

export interface CreativePointRateSnapshot {
  id: string
  rateCardId: string
  version: number
  actionCode: string
  unit: ApprovedCreativePointRate['unit']
  integerPoints: number | null
  pricingMode: 'fixed' | 'starts_at' | 'unresolved' | 'variable'
  variableFormula?: Record<string, unknown> | null
  lifecycle: CommercialCatalogLifecycle
  approvalStatus: 'pending_business_approval' | 'approved' | 'rejected'
  executable: boolean
  ruleExecutable: boolean
  checksum: string
  effectiveAt: string | null
  blockers: string[]
}

export interface CommercialCatalogReadOptions {
  includePrivate?: boolean
  capabilities?: readonly string[]
}

export interface CommercialCatalogMutationInput {
  action: 'create' | 'submit' | 'approve' | 'reject' | 'publish' | 'retire' | 'archive' | 'delete_draft'
  code: string
  kind?: CommercialCatalogSkuSnapshot['kind']
  visibility?: CommercialCatalogVisibility
  requiredCapability?: string | null
  priceFen?: number | null
  priceMode?: CommercialCatalogSkuSnapshot['priceMode']
  durationDays?: number | null
  payload?: Record<string, unknown>
  benefits?: CommercialCatalogBenefit[]
  expectedRevision?: number
  idempotencyKey?: string
  versionId?: string
  actorId: string
  reason: string
  evidence: Record<string, unknown>
}

export class CommercialCatalogUnavailableError extends Error {
  readonly code = 'COMMERCIAL_CATALOG_UNAVAILABLE'
  constructor(message = 'approved executable commercial catalog entry is unavailable') {
    super(message)
    this.name = 'CommercialCatalogUnavailableError'
  }
}

export class CommercialCatalogConflictError extends Error {
  readonly code = 'COMMERCIAL_CATALOG_CONFLICT'
  constructor(message: string) { super(message); this.name = 'CommercialCatalogConflictError' }
}

export function commercialCatalogContentHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => [key,canonical(item)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function mutationHash(input: CommercialCatalogMutationInput): string { return commercialCatalogContentHash(input) }

function validateMutation(input: CommercialCatalogMutationInput): void {
  if (!['create','submit','approve','reject','publish','retire','archive','delete_draft'].includes(input.action)) throw new CommercialCatalogUnavailableError('unknown catalog action')
  if (input.kind !== undefined && !['monthly','onboarding','point_pack','private_trial'].includes(input.kind)) throw new CommercialCatalogUnavailableError('unregistered product kind')
  if (input.payload !== undefined && (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload) || JSON.stringify(input.payload).length > 33000)) throw new CommercialCatalogUnavailableError('payload must be a bounded object')
  for (const b of input.benefits ?? []) {
    if (typeof b.code !== 'string' || !b.code.trim() || b.code.length > 128 || [b.quantity,b.normalizedValue].some(v => v !== null && (!Number.isSafeInteger(v) || v < 0)))
      throw new CommercialCatalogUnavailableError('benefit quantities must be safe non-negative integers')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.code) || !input.actorId?.trim() || !input.reason?.trim())
    throw new CommercialCatalogUnavailableError('valid SKU, actor and reason are required')
  if (!input.idempotencyKey?.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0)
    throw new CommercialCatalogConflictError('idempotencyKey and expectedRevision are required')
  if (input.action !== 'create' && [input.kind, input.visibility, input.requiredCapability, input.priceFen, input.priceMode, input.durationDays, input.payload, input.benefits].some(value => value !== undefined))
    throw new CommercialCatalogConflictError('lifecycle actions cannot change approved content')
  if (input.priceFen !== undefined && input.priceFen !== null && (!Number.isSafeInteger(input.priceFen) || input.priceFen < 0))
    throw new CommercialCatalogUnavailableError('priceFen must be safe integer fen')
  if (input.durationDays !== undefined && input.durationDays !== null && (!Number.isSafeInteger(input.durationDays) || input.durationDays < 1))
    throw new CommercialCatalogUnavailableError('durationDays must be positive integer')
  if (input.benefits && (input.benefits.length > 100 || new Set(input.benefits.map(b => b.code)).size !== input.benefits.length))
    throw new CommercialCatalogUnavailableError('benefits must be bounded and unique')
}

function nextCatalogSnapshot(base: CommercialCatalogSkuSnapshot, input: CommercialCatalogMutationInput, version: number, at: string): CommercialCatalogSkuSnapshot {
  if (input.kind && input.kind !== base.kind || input.visibility && input.visibility !== base.visibility || input.requiredCapability !== undefined && input.requiredCapability !== base.requiredCapability)
    throw new CommercialCatalogConflictError('SKU identity and visibility are immutable; create a new SKU')
  if (input.action === 'publish' && base.lifecycle !== 'approved') throw new CommercialCatalogConflictError('only an approved version can be published')
  if (input.action === 'submit' && base.lifecycle !== 'draft') throw new CommercialCatalogConflictError('submission requires a draft')
  if (input.action === 'reject' && !['draft', 'pending_business_approval'].includes(base.lifecycle)) throw new CommercialCatalogConflictError('rejection requires a draft or submitted version')
  if (input.action === 'approve' && !['draft', 'pending_business_approval'].includes(base.lifecycle)) throw new CommercialCatalogConflictError('approval requires a draft or submitted version')
  const content = input.action === 'create'
  const payload = content ? { ...base.payload, ...(input.payload ?? {}) } : base.payload
  if (base.payload.tierRank !== undefined && payload.tierRank !== base.payload.tierRank || base.payload.planFamily !== undefined && payload.planFamily !== base.payload.planFamily)
    throw new CommercialCatalogConflictError('plan family and tier rank are immutable')
  const result: CommercialCatalogSkuSnapshot = {
    ...base, versionId: `${base.id}-v${version}-${randomUUID()}`, version,
    lifecycle: ['retire', 'archive', 'delete_draft'].includes(input.action) ? 'retired' : input.action === 'submit' ? 'pending_business_approval' : input.action === 'reject' ? 'rejected' : ['approve', 'publish'].includes(input.action) ? 'approved' : 'draft',
    executable: input.action === 'publish',
    priceFen: content && input.priceFen !== undefined ? input.priceFen : base.priceFen,
    priceMode: content ? input.priceMode ?? base.priceMode : base.priceMode,
    durationDays: content && input.durationDays !== undefined ? input.durationDays : base.durationDays,
    payload: structuredClone(payload), benefits: structuredClone(content ? input.benefits ?? base.benefits : base.benefits),
    effectiveAt: input.action === 'publish' ? at : null,
  }
  if (input.action === 'publish') {
    for (const b of result.benefits) {
      if (!COMMERCIAL_BENEFIT_DEFINITIONS.some(d => d.code === b.code) || !Number.isSafeInteger(b.quantity) || b.quantity! < 0 || !b.policyRef)
        throw new CommercialCatalogUnavailableError(`unregistered or unresolved benefit ${b.code}`)
      if (b.code.startsWith('feature.') && b.quantity !== 0 && b.quantity !== 1) throw new CommercialCatalogUnavailableError('feature grant must be boolean 0/1')
      if (b.code === 'cloud_storage' && (!Number.isSafeInteger(b.normalizedValue) || b.normalizedValue! < 0))
        throw new CommercialCatalogUnavailableError('normalized storage bytes are required')
    }
    try {
      commercialPurchasePolicy(result)
      if (result.kind === 'monthly') {
        // New publication requires explicit approved identity/cycle; the transaction
        // reader's old-monthly default is compatibility, not approval evidence.
        if (payload.cycle === undefined) throw new Error('COMMERCIAL_CYCLE_POLICY_UNRESOLVED')
        assertSupportedCommercialCycleGrantPolicy({ cycle: payload.cycle, pointGrantPolicy: payload.pointGrantPolicy })
        commercialPlanIdentity(result)
      }
    } catch (error) {
      throw new CommercialCatalogUnavailableError(`approved order expiry policy and executable plan terms are required: ${error instanceof Error ? error.message : 'unresolved policy'}`)
    }
    if (result.kind === 'onboarding') {
      const schedule = payload.grantSchedule as Record<string, unknown> | undefined
      const policy = payload.policyRef as Record<string, unknown> | undefined
      const schedulePolicy = schedule?.policyRef as Record<string, unknown> | undefined
      if (!policy || policy.policyId !== 'commercial.onboarding' || policy.version !== 'v2' || !schedulePolicy || schedulePolicy.policyId !== policy.policyId || schedulePolicy.version !== policy.version || !schedule || !Number.isSafeInteger(schedule.grantCount) || (schedule.grantCount as number) < 1 || (schedule.grantCount as number) > 24 || !Number.isSafeInteger(schedule.pointsPerGrant) || (schedule.pointsPerGrant as number) < 1 || schedule.cadence !== 'monthly' || schedule.timezone !== 'UTC' || schedule.startsAt !== 'payment_verified' || schedule.grantExpiresAtRule !== 'next_monthly_anniversary' || schedule.schedulingStatus !== 'resolved')
        throw new CommercialCatalogUnavailableError('approved registered onboarding grant schedule is required')
      for (const [code, value] of [['grant_count', schedule.grantCount], ['points_per_grant', schedule.pointsPerGrant]] as const) {
        const benefit = result.benefits.find(b => b.code === code)
        if (benefit && benefit.quantity !== value) throw new CommercialCatalogUnavailableError('onboarding benefit and grant schedule disagree')
      }
    }
    if (result.kind === 'point_pack' && !result.benefits.some(b => b.code === 'creative_points' && Number.isSafeInteger(b.quantity) && b.quantity! > 0)) throw new CommercialCatalogUnavailableError('point-pack creative point consumer requires a positive registered benefit')
    if (result.kind === 'point_pack' && (payload.expiryRule !== 'purchase_plus_30_natural_days' || payload.expiryDays !== 30))
      throw new CommercialCatalogUnavailableError('point-pack expiry consumer is unresolved')
    if (result.priceMode !== 'fixed' || result.priceFen === null || result.priceFen <= 0 || !Array.isArray(payload.blockers) || payload.blockers.length)
      throw new CommercialCatalogUnavailableError('fixed positive price and explicitly resolved blockers are required for publication')
    if (result.kind === 'monthly' && !result.benefits.some(b => b.code === 'monthly_creative_points' && Number.isSafeInteger(b.quantity) && b.quantity! > 0))
      throw new CommercialCatalogUnavailableError('monthly creative point consumer requires a positive registered benefit')
    if (payload.product_type === 'benefit_pack' && (result.kind !== 'point_pack' || !result.benefits.some(b => b.code === 'creative_points' && Number.isSafeInteger(b.quantity) && b.quantity! > 0)))
      throw new CommercialCatalogUnavailableError('only registered point-pack consumers may sell independent benefit packs')
  }
  result.benefits.sort((a,b) => a.code.localeCompare(b.code))
  result.checksum = commercialCatalogContentHash({ priceFen: result.priceFen, priceMode: result.priceMode, durationDays: result.durationDays, payload: result.payload, benefits: result.benefits })
  return result
}

export class CreativePointRateUnavailableError extends Error {
  readonly code = 'RATE_CARD_UNAVAILABLE'
  constructor() {
    super('exactly one approved executable creative-point rate is required')
    this.name = 'CreativePointRateUnavailableError'
  }
}

function isOcrCostFormula(value: unknown): value is ApprovedOcrCostRate['variableFormula'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const formula = value as Record<string, unknown>
  if (formula.kind === 'cost_cny_x2_ceil_min1') return Object.keys(formula).length === 1
  return formula.kind === 'cost_cny_threshold_x2_ceil_v1'
    && Object.keys(formula).length === 4
    && formula.free_when_cost_cny_lte === 0.3
    && formula.multiplier === 2
    && formula.min_paid_points === 1
}

export interface CommercialCatalogRepository {
  list(options?: CommercialCatalogReadOptions): Promise<CommercialCatalogSkuSnapshot[]>
  get(code: string, options?: CommercialCatalogReadOptions): Promise<CommercialCatalogSkuSnapshot | undefined>
  resolveApprovedExecutableSku(code: string, options?: CommercialCatalogReadOptions): Promise<CommercialCatalogSkuSnapshot>
  listRates(): Promise<CreativePointRateSnapshot[]>
  resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate>
  resolveApprovedOcrCostRate(): Promise<ApprovedOcrCostRate>
  mutate(input: CommercialCatalogMutationInput): Promise<CommercialCatalogSkuSnapshot>
}

function canSee(snapshot: CommercialCatalogSkuSnapshot, options: CommercialCatalogReadOptions = {}): boolean {
  if (snapshot.visibility === 'public') return true
  return options.includePrivate === true
    && snapshot.requiredCapability !== null
    && (options.capabilities ?? []).includes(snapshot.requiredCapability)
}

function cloneSnapshot(snapshot: CommercialCatalogSkuSnapshot): CommercialCatalogSkuSnapshot {
  return structuredClone(snapshot)
}

export class MemoryCommercialCatalogRepository implements CommercialCatalogRepository {
  private readonly mutableSnapshots: CommercialCatalogSkuSnapshot[]
  private readonly sales = new Map<string, { state: CommercialSaleState; revision: number; versionId: string | null }>()
  private readonly replays = new Map<string, { hash: string; snapshot: CommercialCatalogSkuSnapshot }>()
  constructor(
    snapshots: readonly CommercialCatalogSkuSnapshot[],
    private readonly rates: readonly (ApprovedCreativePointRate & { lifecycle?: CommercialCatalogLifecycle; executable?: boolean })[] = [],
    private readonly now: () => number = () => Date.now(),
  ) {
    this.mutableSnapshots = snapshots.map(cloneSnapshot)
    for (const code of new Set(snapshots.map(s => s.code))) {
      const versions = snapshots.filter(s => s.code === code).sort((a, b) => b.version - a.version)
      const eligible = versions.filter(s => s.lifecycle === 'approved' && s.executable)
      const state = versions[0]?.lifecycle === 'retired' ? 'off_sale' : eligible.length === 1 ? 'on_sale' : 'unlisted'
      this.sales.set(code, { state, revision: 0, versionId: state === 'on_sale' ? eligible[0]!.versionId : null })
    }
  }

  private withSale(snapshot: CommercialCatalogSkuSnapshot): CommercialCatalogSkuSnapshot {
    const sale = this.sales.get(snapshot.code)
    return { ...cloneSnapshot(snapshot), saleState: sale?.state ?? 'unlisted', saleRevision: sale?.revision ?? 0, currentSaleVersionId: sale?.versionId ?? null }
  }

  async list(options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot[]> {
    return this.mutableSnapshots.filter(snapshot => canSee(snapshot, options)).map(s => this.withSale(s))
  }

  async get(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot | undefined> {
    const snapshot = this.mutableSnapshots.filter(item => item.code === code && canSee(item, options)).sort((a, b) => b.version - a.version)[0]
    return snapshot ? this.withSale(snapshot) : undefined
  }

  async resolveApprovedExecutableSku(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot> {
    const sale = this.sales.get(code)
    const candidates = this.mutableSnapshots.filter(item => sale?.state === 'on_sale' && item.versionId === sale.versionId && item.code === code && canSee(item, options)
      && item.lifecycle === 'approved' && item.executable && item.effectiveAt !== null
      && Number.isFinite(Date.parse(item.effectiveAt)) && Date.parse(item.effectiveAt) <= this.now())
    if (candidates.length !== 1) throw new CommercialCatalogUnavailableError()
    return cloneSnapshot(candidates[0]!)
  }

  async listRates(): Promise<CreativePointRateSnapshot[]> {
    return this.rates.map((rate, index): CreativePointRateSnapshot => ({
      id: `${rate.rateCardId}:${rate.actionCode}:${index + 1}`,
      rateCardId: rate.rateCardId,
      version: rate.version,
      actionCode: rate.actionCode,
      unit: rate.unit,
      integerPoints: rate.integerPoints,
      pricingMode: 'fixed',
      lifecycle: rate.lifecycle ?? 'approved',
      approvalStatus: (rate.lifecycle ?? 'approved') === 'approved' ? 'approved' : 'pending_business_approval',
      executable: rate.executable ?? true,
      ruleExecutable: rate.executable ?? true,
      checksum: rate.checksum,
      effectiveAt: rate.effectiveAt,
      blockers: [],
    })).map(rate => structuredClone(rate))
  }

  async resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate> {
    const candidates = this.rates.filter(rate => rate.actionCode === actionCode
      && (rate.lifecycle ?? 'approved') === 'approved' && (rate.executable ?? true)
      && Number.isSafeInteger(rate.integerPoints) && rate.integerPoints > 0
      && Number.isFinite(Date.parse(rate.effectiveAt)) && Date.parse(rate.effectiveAt) <= this.now())
    if (candidates.length !== 1) throw new CreativePointRateUnavailableError()
    const { lifecycle: _lifecycle, executable: _executable, ...rate } = candidates[0]!
    return structuredClone(rate)
  }

  async resolveApprovedOcrCostRate(): Promise<ApprovedOcrCostRate> {
    throw new CreativePointRateUnavailableError()
  }

  async mutate(input: CommercialCatalogMutationInput): Promise<CommercialCatalogSkuSnapshot> {
    validateMutation(input)
    if (input.payload?.bundleRefs !== undefined) throw new CommercialCatalogUnavailableError('bundle references require the durable bundle repository')
    const hash = mutationHash(input), key = `${input.actorId}:${input.idempotencyKey}`
    const replay = this.replays.get(key)
    if (replay) { if (replay.hash !== hash) throw new CommercialCatalogConflictError('idempotency key reused with different content'); return cloneSnapshot(replay.snapshot) }
    const versions = this.mutableSnapshots.filter(s => s.code === input.code).sort((a, b) => b.version - a.version)
    const existing = input.versionId ? versions.find(s => s.versionId === input.versionId) : versions[0]
    if ((!existing && input.action !== 'create') || input.versionId && !existing) throw new CommercialCatalogUnavailableError('catalog version does not exist')
    const sale = this.sales.get(input.code) ?? { state: 'unlisted' as CommercialSaleState, revision: 0, versionId: null }
    if (input.expectedRevision !== sale.revision || ['archived', 'deleted'].includes(sale.state)) throw new CommercialCatalogConflictError('catalog revision changed or SKU archived')
    if (input.action === 'delete_draft' && versions.some(s => s.lifecycle === 'approved' || s.executable)) throw new CommercialCatalogConflictError('published or approved SKU must be archived')
    const base = existing ?? { id: `sku-${input.code}`, code: input.code, kind: input.kind ?? 'monthly', visibility: input.visibility ?? 'public', requiredCapability: input.requiredCapability ?? null, versionId: '', version: 0, lifecycle: 'draft' as const, executable: false, priceFen: null, currency: 'CNY' as const, priceMode: 'fixed' as const, durationDays: null, payload: {}, checksum: '', effectiveAt: null, benefits: [] }
    const next = nextCatalogSnapshot(base, input, (versions[0]?.version ?? 0) + 1, new Date(this.now()).toISOString())
    const state = input.action === 'publish' ? 'on_sale' : input.action === 'retire' ? 'off_sale' : input.action === 'archive' ? 'archived' : input.action === 'delete_draft' ? 'deleted' : sale.state
    this.sales.set(input.code, { state, revision: sale.revision + 1, versionId: input.action === 'publish' ? next.versionId : ['retire', 'archive', 'delete_draft'].includes(input.action) ? null : sale.versionId })
    this.mutableSnapshots.push(next)
    const result = this.withSale(next)
    this.replays.set(key, { hash, snapshot: result })
    return cloneSnapshot(result)
  }
}

interface CatalogRow {
  id: string
  code: string
  kind: CommercialCatalogSkuSnapshot['kind']
  visibility: CommercialCatalogVisibility
  requiredCapability: string | null
  versionId: string
  version: number
  lifecycle: CommercialCatalogLifecycle
  executable: boolean
  priceFen: number | string | null
  currency: 'CNY' | null
  priceMode: CommercialCatalogSkuSnapshot['priceMode']
  durationDays: number | null
  payload: Record<string, unknown>
  checksum: string
  effectiveAt: string | Date | null
  benefits: Array<{
    code: string
    quantity: number | string | null
    rawValue: string | null
    rawUnit: string | null
    normalizedValue: number | string | null
    policyRef: string | null
    metadata: Record<string, unknown>
  }>
}

interface RateRow {
  id?: string
  rateCardId: string
  version: number
  actionCode: string
  unit: ApprovedCreativePointRate['unit']
  integerPoints: number | string | null
  pricingMode?: CreativePointRateSnapshot['pricingMode']
  variableFormula?: unknown
  lifecycle?: CommercialCatalogLifecycle
  approvalStatus?: CreativePointRateSnapshot['approvalStatus']
  executable?: boolean
  ruleExecutable?: boolean
  checksum: string
  effectiveAt: string | Date | null
  blockers?: unknown
}

const catalogProjection = `
  sale.state AS "saleState", sale.revision AS "saleRevision", sale.current_version_id AS "currentSaleVersionId",
  s.id,
  s.code,
  s.kind,
  s.visibility,
  s.required_capability AS "requiredCapability",
  v.id AS "versionId",
  v.version,
  v.lifecycle,
  v.executable,
  v.price_fen AS "priceFen",
  v.currency,
  v.price_mode AS "priceMode",
  v.duration_days AS "durationDays",
  v.payload,
  v.checksum,
  v.effective_at AS "effectiveAt",
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'code', b.benefit_code,
      'quantity', b.quantity,
      'rawValue', b.raw_value,
      'rawUnit', b.raw_unit,
      'normalizedValue', b.normalized_value,
      'policyRef', b.policy_ref,
      'metadata', b.metadata
    ) ORDER BY b.benefit_code)
    FROM commercial_catalog_sku_benefits b
    WHERE b.sku_version_id = v.id
  ), '[]'::jsonb) AS benefits`

function finiteSafeInteger(value: number | string | null, field: string): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CommercialCatalogUnavailableError(`${field} is not a safe non-negative integer`)
  return parsed
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new CommercialCatalogUnavailableError('catalog timestamp is invalid')
  return parsed.toISOString()
}

function approvedRatePoints(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CreativePointRateUnavailableError()
  return parsed
}

function ratePoints(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CommercialCatalogUnavailableError('rate integerPoints is invalid')
  return parsed
}

function rateBlockers(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new CommercialCatalogUnavailableError('rate blockers are invalid')
  return [...value]
}

function approvedRateEffectiveAt(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new CreativePointRateUnavailableError()
  return parsed.toISOString()
}

function mapCatalog(row: CatalogRow): CommercialCatalogSkuSnapshot {
  return {
    ...row,
    priceFen: finiteSafeInteger(row.priceFen, 'priceFen'),
    effectiveAt: iso(row.effectiveAt),
    payload: structuredClone(row.payload),
    benefits: row.benefits.map(benefit => ({
      ...benefit,
      quantity: finiteSafeInteger(benefit.quantity, 'benefit.quantity'),
      normalizedValue: finiteSafeInteger(benefit.normalizedValue, 'benefit.normalizedValue'),
      metadata: structuredClone(benefit.metadata),
    })),
  }
}

function visibilityParams(options: CommercialCatalogReadOptions): [boolean, readonly string[]] {
  return [options.includePrivate === true, [...new Set(options.capabilities ?? [])]]
}

export class PostgresCommercialCatalogRepository implements CommercialCatalogRepository {
  constructor(private readonly pool: SqlPool, private readonly fixtureMutationClock?: () => Date) {}

  private async queryCatalog(where: string, values: readonly unknown[]): Promise<CommercialCatalogSkuSnapshot[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<CatalogRow>(`
        SELECT ${catalogProjection}
        FROM commercial_catalog_skus s
        JOIN commercial_catalog_sku_versions v ON v.sku_id = s.id
        LEFT JOIN commercial_catalog_sales_v3 sale ON sale.sku_id = s.id
        WHERE ${where}
        ORDER BY s.code, v.version DESC
      `, values)
      return result.rows.map(mapCatalog)
    } finally {
      client.release?.()
    }
  }

  async list(options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot[]> {
    const [includePrivate, capabilities] = visibilityParams(options)
    return this.queryCatalog(
      `(s.visibility = 'public' OR ($1::boolean AND s.required_capability = ANY($2::text[])))`,
      [includePrivate, capabilities],
    )
  }

  async get(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot | undefined> {
    const [includePrivate, capabilities] = visibilityParams(options)
    const rows = await this.queryCatalog(
      `s.code = $1 AND (s.visibility = 'public' OR ($2::boolean AND s.required_capability = ANY($3::text[])))`,
      [code, includePrivate, capabilities],
    )
    return rows[0]
  }

  async resolveApprovedExecutableSku(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot> {
    const [includePrivate, capabilities] = visibilityParams(options)
    const rows = await this.queryCatalog(
      `s.code = $1
       AND (s.visibility = 'public' OR ($2::boolean AND s.required_capability = ANY($3::text[])))
       AND sale.state = 'on_sale' AND sale.current_version_id = v.id
       AND v.lifecycle = 'approved' AND v.executable = true
       AND v.effective_at IS NOT NULL AND v.effective_at <= now()`,
      [code, includePrivate, capabilities],
    )
    if (rows.length !== 1) throw new CommercialCatalogUnavailableError()
    return rows[0]!
  }

  async listRates(): Promise<CreativePointRateSnapshot[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<RateRow>(`
        SELECT r.id, c.id AS "rateCardId", c.version, r.action_code AS "actionCode",
          r.unit, r.integer_points AS "integerPoints", r.pricing_mode AS "pricingMode",
          r.variable_formula AS "variableFormula",
          c.lifecycle, c.approval_status AS "approvalStatus", c.executable,
          r.executable AS "ruleExecutable", c.checksum, c.effective_at AS "effectiveAt",
          r.blockers
        FROM creative_point_rate_card_versions_v2 c
        JOIN creative_point_rate_rules_v2 r ON r.rate_card_version_id = c.id
        ORDER BY c.version DESC, r.action_code
      `)
      return result.rows.map(row => ({
        id: row.id!, rateCardId: row.rateCardId, version: row.version, actionCode: row.actionCode,
        unit: row.unit, integerPoints: ratePoints(row.integerPoints), pricingMode: row.pricingMode!,
        variableFormula: row.variableFormula === null ? null : isOcrCostFormula(row.variableFormula) ? structuredClone(row.variableFormula) : null,
        lifecycle: row.lifecycle!, approvalStatus: row.approvalStatus!, executable: row.executable!,
        ruleExecutable: row.ruleExecutable!, checksum: row.checksum, effectiveAt: iso(row.effectiveAt),
        blockers: rateBlockers(row.blockers),
      }))
    } finally {
      client.release?.()
    }
  }

  async resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<RateRow>(`
        SELECT c.id AS "rateCardId", c.version, r.action_code AS "actionCode",
          r.unit, r.integer_points AS "integerPoints", c.checksum,
          c.effective_at AS "effectiveAt"
        FROM creative_point_rate_card_versions_v2 c
        JOIN creative_point_rate_rules_v2 r ON r.rate_card_version_id = c.id
        WHERE r.action_code = $1
          AND c.lifecycle = 'approved' AND c.approval_status = 'approved'
          AND c.executable = true AND c.effective_at IS NOT NULL AND c.effective_at <= now()
          AND r.executable = true AND r.pricing_mode = 'fixed' AND r.integer_points > 0
        ORDER BY c.effective_at DESC, c.version DESC
        LIMIT 2
      `, [actionCode])
      if (result.rows.length !== 1) throw new CreativePointRateUnavailableError()
      const row = result.rows[0]!
      const integerPoints = approvedRatePoints(row.integerPoints!)
      const effectiveAt = approvedRateEffectiveAt(row.effectiveAt!)
      return { ...row, integerPoints, effectiveAt }
    } finally {
      client.release?.()
    }
  }

  async resolveApprovedOcrCostRate(): Promise<ApprovedOcrCostRate> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<RateRow>(`
        SELECT c.id AS "rateCardId", c.version, r.action_code AS "actionCode",
          r.unit, r.integer_points AS "integerPoints", r.executable AS "ruleExecutable",
          r.pricing_mode AS "pricingMode", r.variable_formula AS "variableFormula",
          c.checksum, c.effective_at AS "effectiveAt"
        FROM creative_point_rate_card_versions_v2 c
        JOIN creative_point_rate_rules_v2 r ON r.rate_card_version_id = c.id
        WHERE r.action_code = 'ocr.extract'
          AND c.lifecycle = 'approved' AND c.approval_status = 'approved'
          AND c.executable = true AND c.effective_at IS NOT NULL AND c.effective_at <= now()
        ORDER BY c.effective_at DESC, c.version DESC
        LIMIT 1
      `)
      const row = result.rows[0]
      if (!row || row.actionCode !== 'ocr.extract' || row.unit !== 'request' || row.pricingMode !== 'variable'
        || row.ruleExecutable !== true || row.integerPoints !== null
        || !isOcrCostFormula(row.variableFormula) || !row.rateCardId || !Number.isSafeInteger(row.version)
        || !/^[0-9a-f]{64}$/u.test(row.checksum) || !row.effectiveAt) throw new CreativePointRateUnavailableError()
      return {
        rateCardId: row.rateCardId, version: row.version, actionCode: 'ocr.extract', unit: 'request',
        pricingMode: 'variable', variableFormula: structuredClone(row.variableFormula),
        checksum: row.checksum, effectiveAt: approvedRateEffectiveAt(row.effectiveAt),
      }
    } catch (error) {
      if (error instanceof CreativePointRateUnavailableError) throw error
      throw new CreativePointRateUnavailableError()
    } finally {
      client.release?.()
    }
  }

  async mutate(input: CommercialCatalogMutationInput): Promise<CommercialCatalogSkuSnapshot> {
    validateMutation(input)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('commercial_catalog_v3'),hashtext($1))`, [input.code])
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('commercial_catalog_request'),hashtext($1))`, [`${input.actorId}:${input.idempotencyKey}`])
      const hash = mutationHash(input)
      const replay = await client.query<{ requestHash: string; result: CommercialCatalogSkuSnapshot }>(`SELECT request_hash AS "requestHash", result FROM commercial_catalog_mutations_v3 WHERE actor_id=$1 AND idempotency_key=$2`, [input.actorId, input.idempotencyKey])
      if (replay.rows[0]) {
        if (replay.rows[0].requestHash !== hash) throw new CommercialCatalogConflictError('idempotency key reused with different content')
        await client.query('COMMIT'); return replay.rows[0].result
      }
      const versions = await client.query<CatalogRow>(`SELECT ${catalogProjection} FROM commercial_catalog_skus s JOIN commercial_catalog_sku_versions v ON v.sku_id=s.id LEFT JOIN commercial_catalog_sales_v3 sale ON sale.sku_id=s.id WHERE s.code=$1 ORDER BY v.version DESC`, [input.code])
      const latest = versions.rows[0] ? mapCatalog(versions.rows[0]) : undefined
      const base = input.versionId ? versions.rows.find(v => v.versionId === input.versionId) : latest
      if ((!base && input.action !== 'create') || input.versionId && !base) throw new CommercialCatalogUnavailableError('catalog version does not exist')
      if (!latest) {
        await client.query(`INSERT INTO commercial_catalog_skus (id,code,kind,visibility,required_capability) VALUES ($1,$2,$3,$4,$5)`, [`sku-${input.code}`,input.code,input.kind ?? 'monthly',input.visibility ?? 'public',input.requiredCapability ?? null])
        await client.query(`INSERT INTO commercial_catalog_sales_v3(sku_id,state,revision) VALUES ($1,'unlisted',0)`, [`sku-${input.code}`])
      }
      const locked = await client.query<{ state: CommercialSaleState; revision: number; versionId: string | null }>(`SELECT state,revision,current_version_id AS "versionId" FROM commercial_catalog_sales_v3 WHERE sku_id=$1 FOR UPDATE`, [latest?.id ?? `sku-${input.code}`])
      const sale = locked.rows[0]
      if (!sale || sale.revision !== input.expectedRevision || ['archived','deleted'].includes(sale.state)) throw new CommercialCatalogConflictError('catalog revision changed or SKU archived')
      if (input.action === 'delete_draft' && versions.rows.some(v => v.lifecycle === 'approved' || v.executable)) throw new CommercialCatalogConflictError('approved or published SKU must be archived')
      const empty: CommercialCatalogSkuSnapshot = { id: `sku-${input.code}`,code:input.code,kind:input.kind ?? 'monthly',visibility:input.visibility ?? 'public',requiredCapability:input.requiredCapability ?? null,versionId:'',version:0,lifecycle:'draft',executable:false,priceFen:null,currency:'CNY',priceMode:'fixed',durationDays:null,payload:{},checksum:'',effectiveAt:null,benefits:[] }
      let resolvedInput = input
      const refs = input.action === 'create' ? input.payload?.bundleRefs ?? (base as CommercialCatalogSkuSnapshot | undefined)?.payload.bundleRefs : (base as CommercialCatalogSkuSnapshot | undefined)?.payload.bundleRefs
      const refIds: string[] = []
      if (refs !== undefined) {
        if (!Array.isArray(refs) || refs.length > 20) throw new CommercialCatalogUnavailableError('bundle references must be an array of at most 20')
        const expanded = [...(input.benefits ?? (base as CommercialCatalogSkuSnapshot | undefined)?.benefits ?? [])].filter(b => !b.metadata?.bundleVersionId)
        for (const ref of refs) {
          if (!ref || typeof ref.code !== 'string' || typeof ref.versionId !== 'string' || refIds.includes(ref.versionId)) throw new CommercialCatalogUnavailableError('bundle references must have unique code and versionId')
          const found = await client.query<{ benefits: CommercialCatalogBenefit[]; lifecycle: string; state: string }>(`SELECT v.benefits,v.lifecycle,b.state FROM commercial_benefit_bundles_v3 b JOIN commercial_benefit_bundle_versions_v3 v ON v.bundle_id=b.id WHERE b.code=$1 AND v.id=$2 FOR SHARE OF b`, [ref.code,ref.versionId])
          const bundle = found.rows[0]
          if (!bundle || bundle.lifecycle !== 'approved' || ['create','publish'].includes(input.action) && bundle.state !== 'active') throw new CommercialCatalogUnavailableError('only active approved bundle versions can be bound')
          refIds.push(ref.versionId)
          for (const submitted of input.benefits ?? []) {
            if (submitted.metadata?.bundleVersionId !== ref.versionId) continue
            const authoritative = bundle.benefits.find(b => b.code === submitted.code)
            if (!authoritative || authoritative.quantity !== submitted.quantity || authoritative.normalizedValue !== submitted.normalizedValue || authoritative.policyRef !== submitted.policyRef)
              throw new CommercialCatalogConflictError('bound bundle benefits cannot be edited; select a new approved bundle version')
          }
          if (input.action === 'create') expanded.push(...bundle.benefits.map(b => ({...b,metadata:{...b.metadata,bundleVersionId:ref.versionId}})))
        }
        if (input.action === 'create') {
          if (expanded.length > 100 || new Set(expanded.map(b => b.code)).size !== expanded.length) throw new CommercialCatalogUnavailableError('expanded benefits overlap or exceed limit')
          resolvedInput = {...input,benefits:expanded}
        }
      }
      const databaseClock = await client.query<{ at: Date | string }>(`SELECT clock_timestamp() AS at`)
      const mutationAt = this.fixtureMutationClock?.() ?? databaseClock.rows[0]!.at
      if (!(mutationAt instanceof Date || typeof mutationAt === 'string') || !Number.isFinite(new Date(mutationAt).getTime())) throw new CommercialCatalogUnavailableError('fixture mutation clock is invalid')
      const next = nextCatalogSnapshot(base ? mapCatalog(base as CatalogRow) : empty,resolvedInput,(latest?.version ?? 0)+1,iso(mutationAt)!)
      await client.query(`INSERT INTO commercial_catalog_sku_versions (id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,duration_days,payload,checksum,effective_at) VALUES ($1,$2,$3,$4,$5,$6,'CNY',$7,$8,$9::jsonb,$10,$11)`, [next.versionId,next.id,next.version,next.lifecycle,next.executable,next.priceFen,next.priceMode,next.durationDays,JSON.stringify(next.payload),next.checksum,next.effectiveAt])
      for (const b of next.benefits) await client.query(`INSERT INTO commercial_catalog_sku_benefits(id,sku_version_id,benefit_code,quantity,raw_value,raw_unit,normalized_value,policy_ref,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [randomUUID(),next.versionId,b.code,b.quantity,b.rawValue,b.rawUnit,b.normalizedValue,b.policyRef,JSON.stringify(b.metadata ?? {})])
      for (const refId of refIds) await client.query(`INSERT INTO commercial_catalog_bundle_refs_v3(sku_version_id,bundle_version_id) VALUES($1,$2)`,[next.versionId,refId])
      const state: CommercialSaleState = input.action === 'publish' ? 'on_sale' : input.action === 'retire' ? 'off_sale' : input.action === 'archive' ? 'archived' : input.action === 'delete_draft' ? 'deleted' : sale.state
      const currentSaleVersionId = input.action === 'publish' ? next.versionId : ['retire','archive','delete_draft'].includes(input.action) ? null : sale.versionId
      await client.query(`UPDATE commercial_catalog_sales_v3 SET state=$2,current_version_id=$3,revision=revision+1,updated_at=now() WHERE sku_id=$1`, [next.id,state,currentSaleVersionId])
      const eventId = randomUUID()
      const eventType = input.action === 'publish' ? 'published' : input.action === 'approve' ? 'approved' : input.action === 'submit' ? 'submitted' : ['retire','archive','delete_draft'].includes(input.action) ? 'retired' : 'source_imported'
      await client.query(`INSERT INTO commercial_catalog_events_v2(id,aggregate_type,aggregate_id,event_type,actor_id,reason,evidence,revision) VALUES ($1,'sku_version',$2,$3,$4,$5,$6::jsonb,$7)`, [eventId,next.versionId,eventType,input.actorId,input.reason,JSON.stringify({...input.evidence,action:input.action,source_version_id:base?.versionId ?? null,source_checksum:base?.checksum ?? null}),next.version])
      if (input.action === 'publish') await client.query(`INSERT INTO commercial_catalog_publish_outbox(event_id,sku_code,version,visibility,payload) VALUES ($1::uuid,$2,$3,$4,$5::jsonb)`, [eventId,next.code,next.version,next.visibility,JSON.stringify({sku_code:next.code,version_id:next.versionId,version:next.version,name:next.payload.name ?? next.code,price_fen:next.priceFen,currency:next.currency,duration_days:next.durationDays,benefits:next.benefits,cycle:next.payload.cycle,required_capability:next.requiredCapability})])
      const result = {...next,saleState:state,saleRevision:sale.revision+1,currentSaleVersionId}
      await client.query(`INSERT INTO commercial_catalog_mutations_v3(actor_id,idempotency_key,request_hash,result) VALUES ($1,$2,$3,$4::jsonb)`, [input.actorId,input.idempotencyKey,hash,JSON.stringify(result)])
      await client.query('COMMIT')
      return result
    } catch (error) { try { await client.query('ROLLBACK') } catch { /* preserve original */ } throw error } finally { client.release?.() }
  }
}
