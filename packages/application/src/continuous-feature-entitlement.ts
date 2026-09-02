/**
 * Runtime admission for subscription-backed, continuous merchant features.
 *
 * Only V2 entitlement snapshots are accepted as authority. Legacy task quota,
 * add-ons, RMB wallet balances and image-entitlement counters may be attached
 * as shadow evidence for migration diagnostics, but are intentionally absent
 * from every allow condition.
 */

export interface ContinuousFeatureEntitlementSnapshotV2 {
  readonly id: string
  readonly workspaceId: string
  readonly subscriptionPeriodId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodStatus: string
  readonly catalogVersionId: string
  readonly skuCode: string
  readonly resolvedBenefits: readonly unknown[]
  readonly unresolvedBlockers: readonly string[]
  readonly executable: boolean
  readonly checksum: string
  readonly createdAt: string
}

export type LegacyCommercialShadowSource = 'task_quota' | 'addon' | 'rmb_wallet' | 'image_entitlement'

export interface ContinuousFeatureEntitlementPort {
  /** Must read workspace_entitlement_snapshots_v2, never a legacy commercial projection. */
  listV2EntitlementSnapshots(input: { readonly workspace_id: string }): Promise<readonly ContinuousFeatureEntitlementSnapshotV2[]>
}

export type ContinuousFeatureEntitlementDecision =
  | {
      readonly allowed: true
      readonly code: 'OK'
      readonly snapshot_id: string
      readonly subscription_period_id: string
      readonly catalog_version_id: string
      readonly checksum: string
      readonly ignored_legacy_sources: readonly LegacyCommercialShadowSource[]
    }
  | {
      readonly allowed: false
      readonly code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE' | 'COMMERCIAL_ENTITLEMENT_REQUIRED' | 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS'
      readonly snapshot_id: null
      readonly subscription_period_id: null
      readonly catalog_version_id: null
      readonly checksum: null
      readonly ignored_legacy_sources: readonly LegacyCommercialShadowSource[]
    }

export interface ContinuousFeatureEntitlementServiceOptions {
  readonly projection: ContinuousFeatureEntitlementPort
  readonly now?: () => Date
}

const SHA256 = /^[a-f0-9]{64}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u
const LEGACY_SOURCE_ORDER: readonly LegacyCommercialShadowSource[] = ['task_quota', 'addon', 'rmb_wallet', 'image_entitlement']

function canonicalInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined
  return parsed
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function featureBearingBenefits(value: readonly unknown[]): boolean {
  const codes = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const candidate = item as Record<string, unknown>
    if (!identifier(candidate.code)) return false
    codes.add(candidate.code)
  }
  // Point packs only carry `creative_points`; they must never manufacture
  // continuous access even if an invalid migration row references a period.
  return codes.has('max_brands') && codes.has('max_stores')
}

function ignoredLegacySources(value: readonly LegacyCommercialShadowSource[] | undefined): readonly LegacyCommercialShadowSource[] {
  if (!value) return []
  const selected = new Set(value)
  return LEGACY_SOURCE_ORDER.filter(source => selected.has(source))
}

function denied(
  code: Exclude<ContinuousFeatureEntitlementDecision['code'], 'OK'>,
  ignored: readonly LegacyCommercialShadowSource[],
): ContinuousFeatureEntitlementDecision {
  return {
    allowed: false,
    code,
    snapshot_id: null,
    subscription_period_id: null,
    catalog_version_id: null,
    checksum: null,
    ignored_legacy_sources: ignored,
  }
}

function isAuthoritativeSnapshot(
  snapshot: ContinuousFeatureEntitlementSnapshotV2,
  workspaceId: string,
  now: number,
): boolean {
  if (snapshot.workspaceId !== workspaceId || snapshot.periodStatus !== 'active' || !snapshot.executable) return false
  if (!identifier(snapshot.id) || !identifier(snapshot.subscriptionPeriodId) || !identifier(snapshot.catalogVersionId) || !identifier(snapshot.skuCode)) return false
  if (!SHA256.test(snapshot.checksum) || snapshot.unresolvedBlockers.length !== 0) return false
  if (!snapshot.unresolvedBlockers.every(identifier) || !featureBearingBenefits(snapshot.resolvedBenefits)) return false
  const start = canonicalInstant(snapshot.periodStart)
  const end = canonicalInstant(snapshot.periodEnd)
  const created = canonicalInstant(snapshot.createdAt)
  return start !== undefined && end !== undefined && created !== undefined && start < end && start <= now && now < end && created <= now
}

export class ContinuousFeatureEntitlementService {
  readonly #projection: ContinuousFeatureEntitlementPort
  readonly #now: () => Date

  constructor(options: ContinuousFeatureEntitlementServiceOptions) {
    this.#projection = options.projection
    this.#now = options.now ?? (() => new Date())
  }

  async decide(input: {
    readonly workspace_id: string
    /** Reuse the enclosing commercial decision time to avoid cross-gate clock drift. */
    readonly decided_at?: string
    /** Migration diagnostics only. Presence, balances and quantities are ignored. */
    readonly observed_legacy_sources?: readonly LegacyCommercialShadowSource[]
  }): Promise<ContinuousFeatureEntitlementDecision> {
    if (!identifier(input.workspace_id)) throw new Error('continuous feature entitlement workspace_id is invalid')
    const ignored = ignoredLegacySources(input.observed_legacy_sources)
    const current = input.decided_at === undefined ? this.#now() : new Date(input.decided_at)
    if (!(current instanceof Date) || Number.isNaN(current.valueOf()) || (input.decided_at !== undefined && current.toISOString() !== input.decided_at)) return denied('COMMERCIAL_ENTITLEMENT_UNAVAILABLE', ignored)

    let snapshots: readonly ContinuousFeatureEntitlementSnapshotV2[]
    try {
      snapshots = await this.#projection.listV2EntitlementSnapshots({ workspace_id: input.workspace_id })
    } catch {
      return denied('COMMERCIAL_ENTITLEMENT_UNAVAILABLE', ignored)
    }
    if (!Array.isArray(snapshots)) return denied('COMMERCIAL_ENTITLEMENT_UNAVAILABLE', ignored)

    const authoritative = snapshots.filter(snapshot => isAuthoritativeSnapshot(snapshot, input.workspace_id, current.valueOf()))
    if (authoritative.length === 0) return denied('COMMERCIAL_ENTITLEMENT_REQUIRED', ignored)
    if (authoritative.length !== 1) return denied('COMMERCIAL_ENTITLEMENT_AMBIGUOUS', ignored)

    const snapshot = authoritative[0]!
    return {
      allowed: true,
      code: 'OK',
      snapshot_id: snapshot.id,
      subscription_period_id: snapshot.subscriptionPeriodId,
      catalog_version_id: snapshot.catalogVersionId,
      checksum: snapshot.checksum,
      ignored_legacy_sources: ignored,
    }
  }
}
