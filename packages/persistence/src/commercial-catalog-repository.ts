import { SqlPool } from './repository.js'

export const PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY = 'commercial.private_sku.read' as const

export type CommercialCatalogLifecycle = 'draft' | 'pending_business_approval' | 'approved' | 'retired'
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

export interface CommercialCatalogReadOptions {
  includePrivate?: boolean
  capabilities?: readonly string[]
}

export class CommercialCatalogUnavailableError extends Error {
  readonly code = 'COMMERCIAL_CATALOG_UNAVAILABLE'
  constructor(message = 'approved executable commercial catalog entry is unavailable') {
    super(message)
    this.name = 'CommercialCatalogUnavailableError'
  }
}

export class CreativePointRateUnavailableError extends Error {
  readonly code = 'RATE_CARD_UNAVAILABLE'
  constructor() {
    super('exactly one approved executable creative-point rate is required')
    this.name = 'CreativePointRateUnavailableError'
  }
}

export interface CommercialCatalogRepository {
  list(options?: CommercialCatalogReadOptions): Promise<CommercialCatalogSkuSnapshot[]>
  get(code: string, options?: CommercialCatalogReadOptions): Promise<CommercialCatalogSkuSnapshot | undefined>
  resolveApprovedExecutableSku(code: string, options?: CommercialCatalogReadOptions): Promise<CommercialCatalogSkuSnapshot>
  resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate>
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
  constructor(
    private readonly snapshots: readonly CommercialCatalogSkuSnapshot[],
    private readonly rates: readonly (ApprovedCreativePointRate & { lifecycle?: CommercialCatalogLifecycle; executable?: boolean })[] = [],
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot[]> {
    return this.snapshots.filter(snapshot => canSee(snapshot, options)).map(cloneSnapshot)
  }

  async get(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot | undefined> {
    const snapshot = this.snapshots.find(item => item.code === code && canSee(item, options))
    return snapshot ? cloneSnapshot(snapshot) : undefined
  }

  async resolveApprovedExecutableSku(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot> {
    const candidates = this.snapshots.filter(item => item.code === code && canSee(item, options)
      && item.lifecycle === 'approved' && item.executable && item.effectiveAt !== null
      && Number.isFinite(Date.parse(item.effectiveAt)) && Date.parse(item.effectiveAt) <= this.now())
    if (candidates.length !== 1) throw new CommercialCatalogUnavailableError()
    return cloneSnapshot(candidates[0]!)
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
  rateCardId: string
  version: number
  actionCode: string
  unit: ApprovedCreativePointRate['unit']
  integerPoints: number | string
  checksum: string
  effectiveAt: string | Date
}

const catalogProjection = `
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
  constructor(private readonly pool: SqlPool) {}

  private async queryCatalog(where: string, values: readonly unknown[]): Promise<CommercialCatalogSkuSnapshot[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<CatalogRow>(`
        SELECT ${catalogProjection}
        FROM commercial_catalog_skus s
        JOIN commercial_catalog_sku_versions v ON v.sku_id = s.id
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
       AND v.lifecycle = 'approved' AND v.executable = true
       AND v.effective_at IS NOT NULL AND v.effective_at <= now()`,
      [code, includePrivate, capabilities],
    )
    if (rows.length !== 1) throw new CommercialCatalogUnavailableError()
    return rows[0]!
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
      const integerPoints = approvedRatePoints(row.integerPoints)
      const effectiveAt = approvedRateEffectiveAt(row.effectiveAt)
      return { ...row, integerPoints, effectiveAt }
    } finally {
      client.release?.()
    }
  }
}
