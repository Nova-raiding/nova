import { createHash, randomUUID } from 'node:crypto'
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

export interface CreativePointRateSnapshot {
  id: string
  rateCardId: string
  version: number
  actionCode: string
  unit: ApprovedCreativePointRate['unit']
  integerPoints: number | null
  pricingMode: 'fixed' | 'starts_at' | 'unresolved'
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
  action: 'create' | 'approve' | 'publish' | 'retire'
  code: string
  kind?: CommercialCatalogSkuSnapshot['kind']
  visibility?: CommercialCatalogVisibility
  requiredCapability?: string | null
  priceFen?: number | null
  priceMode?: CommercialCatalogSkuSnapshot['priceMode']
  durationDays?: number | null
  payload?: Record<string, unknown>
  benefits?: CommercialCatalogBenefit[]
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
  listRates(): Promise<CreativePointRateSnapshot[]>
  resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate>
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
  constructor(
    snapshots: readonly CommercialCatalogSkuSnapshot[],
    private readonly rates: readonly (ApprovedCreativePointRate & { lifecycle?: CommercialCatalogLifecycle; executable?: boolean })[] = [],
    private readonly now: () => number = () => Date.now(),
  ) { this.mutableSnapshots = snapshots.map(cloneSnapshot) }

  async list(options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot[]> {
    return this.mutableSnapshots.filter(snapshot => canSee(snapshot, options)).map(cloneSnapshot)
  }

  async get(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot | undefined> {
    const snapshot = this.mutableSnapshots.find(item => item.code === code && canSee(item, options))
    return snapshot ? cloneSnapshot(snapshot) : undefined
  }

  async resolveApprovedExecutableSku(code: string, options: CommercialCatalogReadOptions = {}): Promise<CommercialCatalogSkuSnapshot> {
    const candidates = this.mutableSnapshots.filter(item => item.code === code && canSee(item, options)
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

  async mutate(input: CommercialCatalogMutationInput): Promise<CommercialCatalogSkuSnapshot> {
    const existing = this.mutableSnapshots.filter(item => item.code === input.code).sort((a, b) => b.version - a.version)[0]
    if (input.action !== 'create' && !existing) throw new CommercialCatalogUnavailableError('catalog SKU does not exist')
    const base = existing ?? {
      id: `sku-${input.code}`,
      code: input.code,
      kind: input.kind ?? 'monthly',
      visibility: input.visibility ?? 'public',
      requiredCapability: input.requiredCapability ?? null,
      versionId: '', version: 0, lifecycle: 'draft' as const, executable: false,
      priceFen: null, currency: 'CNY' as const, priceMode: 'fixed' as const, durationDays: null,
      payload: {}, checksum: '', effectiveAt: null, benefits: [],
    }
    const payload = input.action === 'retire' ? existing!.payload : { ...(existing?.payload ?? {}), ...(input.payload ?? {}) }
    const snapshot: CommercialCatalogSkuSnapshot = {
      ...base,
      versionId: `${base.id}-v${base.version + 1}-${randomUUID()}`,
      version: base.version + 1,
      lifecycle: input.action === 'retire' ? 'retired' : input.action === 'create' ? 'draft' : 'approved',
      executable: input.action === 'publish',
      priceFen: input.action === 'retire' ? base.priceFen : (input.priceFen ?? base.priceFen),
      priceMode: input.action === 'retire' ? base.priceMode : (input.priceMode ?? base.priceMode),
      durationDays: input.action === 'retire' ? base.durationDays : (input.durationDays ?? base.durationDays),
      payload,
      checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      effectiveAt: input.action === 'publish' ? new Date().toISOString() : null,
      benefits: input.action === 'retire' ? base.benefits : (input.benefits ?? base.benefits),
    }
    this.mutableSnapshots.push(snapshot)
    return cloneSnapshot(snapshot)
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
  lifecycle?: CommercialCatalogLifecycle
  approvalStatus?: CreativePointRateSnapshot['approvalStatus']
  executable?: boolean
  ruleExecutable?: boolean
  checksum: string
  effectiveAt: string | Date | null
  blockers?: unknown
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

  async listRates(): Promise<CreativePointRateSnapshot[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<RateRow>(`
        SELECT r.id, c.id AS "rateCardId", c.version, r.action_code AS "actionCode",
          r.unit, r.integer_points AS "integerPoints", r.pricing_mode AS "pricingMode",
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

  async mutate(input: CommercialCatalogMutationInput): Promise<CommercialCatalogSkuSnapshot> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<CatalogRow & { skuId: string; code: string }>(`
        SELECT latest.id, s.id AS "skuId", s.code, s.kind, s.visibility, s.required_capability AS "requiredCapability",
          latest.version, latest.lifecycle, latest.executable, latest.price_fen AS "priceFen", latest.currency,
          latest.price_mode AS "priceMode", latest.duration_days AS "durationDays", latest.payload, latest.checksum,
          latest.effective_at AS "effectiveAt", benefit_rows.benefits
        FROM commercial_catalog_skus s
        LEFT JOIN LATERAL (
          SELECT v.* FROM commercial_catalog_sku_versions v WHERE v.sku_id = s.id ORDER BY v.version DESC LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('code', b.benefit_code, 'quantity', b.quantity, 'rawValue', b.raw_value, 'rawUnit', b.raw_unit, 'normalizedValue', b.normalized_value, 'policyRef', b.policy_ref, 'metadata', b.metadata) ORDER BY b.benefit_code), '[]'::jsonb) AS benefits
          FROM commercial_catalog_sku_benefits b WHERE b.sku_version_id = latest.id
        ) benefit_rows ON true
        WHERE s.code = $1
        ORDER BY latest.version DESC LIMIT 1
      `, [input.code])
      const row = current.rows[0]
      if (input.action === 'retire' && !row) throw new CommercialCatalogUnavailableError('catalog SKU does not exist')
      const skuId = row?.skuId ?? `sku-${input.code}`
      const baseVersion = row?.version ?? 0
      const payload = input.action === 'retire' || input.action === 'approve' || input.action === 'publish' ? row!.payload : { ...(row?.payload ?? {}), ...(input.payload ?? {}) }
      const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      const versionId = `${skuId}-v${baseVersion + 1}-${randomUUID()}`
      await client.query(`INSERT INTO commercial_catalog_skus (id, code, kind, visibility, required_capability) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`, [skuId, input.code, input.kind ?? row?.kind ?? 'monthly', input.visibility ?? row?.visibility ?? 'public', input.requiredCapability ?? row?.requiredCapability ?? null])
      const lifecycle = input.action === 'retire' ? 'retired' : input.action === 'approve' ? 'approved' : 'draft'
      const executable = input.action === 'publish'
      const effectiveAt = executable ? new Date().toISOString() : null
      await client.query(`INSERT INTO commercial_catalog_sku_versions (id, sku_id, version, lifecycle, executable, price_fen, currency, price_mode, duration_days, payload, checksum, effective_at) VALUES ($1,$2,$3,$4,$5,$6,'CNY',$7,$8,$9::jsonb,$10,$11)`, [versionId, skuId, baseVersion + 1, lifecycle, executable, input.action === 'retire' || input.action === 'approve' || input.action === 'publish' ? row!.priceFen : (input.priceFen ?? row?.priceFen ?? null), input.action === 'retire' || input.action === 'approve' || input.action === 'publish' ? row!.priceMode : (input.priceMode ?? row?.priceMode ?? 'fixed'), input.action === 'retire' || input.action === 'approve' || input.action === 'publish' ? row!.durationDays : (input.durationDays ?? row?.durationDays ?? null), JSON.stringify(payload), checksum, effectiveAt])
      const benefits = input.action === 'retire' || input.action === 'approve' || input.action === 'publish' ? (row?.benefits ?? []) : (input.benefits ?? row?.benefits ?? [])
      for (const benefit of benefits) await client.query(`INSERT INTO commercial_catalog_sku_benefits (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit, normalized_value, policy_ref, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [randomUUID(), versionId, benefit.code, benefit.quantity, benefit.rawValue, benefit.rawUnit, benefit.normalizedValue, benefit.policyRef, JSON.stringify(benefit.metadata ?? {})])
      const eventType = input.action === 'retire' ? 'retired' : input.action === 'approve' ? 'approved' : input.action === 'publish' ? 'published' : 'source_imported'
      await client.query(`INSERT INTO commercial_catalog_events_v2 (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision) VALUES ($1,'sku_version',$2,$3,$4,$5,$6::jsonb,$7)`, [randomUUID(), versionId, eventType, input.actorId, input.reason, JSON.stringify(input.evidence), baseVersion + 1])
      await client.query('COMMIT')
      const rows = await this.queryCatalog('v.id = $1', [versionId])
      if (!rows[0]) throw new CommercialCatalogUnavailableError('catalog mutation was not readable after commit')
      return rows[0]
    } catch (error) { try { await client.query('ROLLBACK') } catch { /* preserve original */ } throw error } finally { client.release?.() }
  }
}
