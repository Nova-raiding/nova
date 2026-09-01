/**
 * The application-facing, read-only projection of a commercial entitlement.
 *
 * This module deliberately has no persistence or API dependencies.  A caller
 * may use it to turn an untrusted/partial snapshot into a safe value for a
 * merchant surface.  Missing or malformed evidence must never become an
 * available entitlement.
 */

export type CommercialEntitlementProjectionStatus = 'available' | 'blocked' | 'unknown'

export interface CommercialEntitlementPeriod {
  start: string
  end: string
}

export interface CommercialEntitlementProjection {
  plan: string | null
  period: CommercialEntitlementPeriod | null
  status: CommercialEntitlementProjectionStatus
  sourceVersion: string | null
  checksum: string | null
}

export interface CommercialEntitlementProjectionInput {
  plan?: unknown
  period?: unknown
  status?: unknown
  sourceVersion?: unknown
  checksum?: unknown
}

const SHA256 = /^[a-f0-9]{64}$/u
const AVAILABLE_SOURCE_STATUSES = new Set(['active', 'available', 'trialing'])
const BLOCKED_SOURCE_STATUSES = new Set(['active_restricted', 'blocked', 'canceled', 'expired', 'paused', 'past_due'])

const emptyProjection = (status: CommercialEntitlementProjectionStatus): CommercialEntitlementProjection => ({
  plan: null,
  period: null,
  status,
  sourceVersion: null,
  checksum: null,
})

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function validPeriod(value: unknown): CommercialEntitlementPeriod | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const start = text(candidate.start)
  const end = text(candidate.end)
  if (!start || !end) return undefined

  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return undefined
  // Canonical ISO strings make the projection deterministic across callers.
  if (new Date(startMs).toISOString() !== start || new Date(endMs).toISOString() !== end) return undefined
  return { start, end }
}

/**
 * Projects a commercial entitlement without making availability assumptions.
 *
 * `active`/`available` is only accepted when every evidence field is valid.
 * Known non-usable source states become `blocked`; missing or unrecognized
 * source state/evidence becomes `unknown`.  In both cases all entitlement
 * fields are redacted so consumers cannot accidentally render partial data as
 * usable quota.
 */
export function projectCommercialEntitlement(input: CommercialEntitlementProjectionInput): CommercialEntitlementProjection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyProjection('unknown')

  const sourceStatus = text(input.status)
  const plan = text(input.plan)
  const sourceVersion = text(input.sourceVersion)
  const checksum = text(input.checksum)
  const period = validPeriod(input.period)

  if (sourceStatus && BLOCKED_SOURCE_STATUSES.has(sourceStatus)) return emptyProjection('blocked')
  if (!sourceStatus || !AVAILABLE_SOURCE_STATUSES.has(sourceStatus)) return emptyProjection('unknown')
  if (!plan || !period || !sourceVersion || !checksum || !SHA256.test(checksum)) return emptyProjection('unknown')

  return { plan, period, status: 'available', sourceVersion, checksum }
}

export const projectCommercialEntitlementProjection = projectCommercialEntitlement
