import { ERROR_CODES, type ErrorCode } from './errors.js'

/** The only three commercial classes approved by the canonical PRD. */
export const COMMERCIAL_ACCESS_CLASSES = [
  'RECOVERY_CONTROL',
  'POINT_REQUIRED_NO_CHARGE',
  'POINT_CHARGED',
] as const

export type CommercialAccessClass = (typeof COMMERCIAL_ACCESS_CLASSES)[number]
export type CommercialOperationSurface = 'MCP' | 'HTTP' | 'WORKER'
export type CommercialRegistryDomain = 'COMMERCIAL' | 'OPS_CONTROL' | 'MACHINE_INFRASTRUCTURE'

export interface CommercialOperationRef {
  readonly surface: CommercialOperationSurface
  /** Exact native identifier: MCP method, HTTP operation, or Worker action. */
  readonly operation: string
}

interface CommercialOperationBase extends CommercialOperationRef {
  readonly domain: 'COMMERCIAL'
  /** False means the exact legacy/incomplete operation remains fail-closed. */
  readonly enabled: boolean
  /** Existing MCP authorization policy retained by MCP and linked HTTP entries. */
  readonly authorization_policy_ref?: string | null
  readonly classification: CommercialAccessClass
}

export interface RecoveryControlOperation extends CommercialOperationBase {
  readonly classification: 'RECOVERY_CONTROL'
  readonly rate_action: null
}

export interface PointRequiredNoChargeOperation extends CommercialOperationBase {
  readonly classification: 'POINT_REQUIRED_NO_CHARGE'
  readonly rate_action: null
}

export interface PointChargedOperation extends CommercialOperationBase {
  readonly classification: 'POINT_CHARGED'
  /** Rate-card lookup key only. This contract intentionally contains no price. */
  readonly rate_action: string
}

export type CommercialOperationPolicy =
  | RecoveryControlOperation
  | PointRequiredNoChargeOperation
  | PointChargedOperation
  | NonCommercialOperationPolicy

export interface NonCommercialOperationPolicy extends CommercialOperationRef {
  readonly domain: 'OPS_CONTROL' | 'MACHINE_INFRASTRUCTURE'
  readonly enabled: boolean
  readonly authorization_policy_ref?: string | null
  /** Infrastructure and independent Ops controls are not point classifications. */
  readonly classification: null
  readonly rate_action: null
}

/**
 * Reviewed MCP foundation only, deliberately not a total runtime registry.
 * Legacy purchase/change endpoints stay disabled until their V2 contracts are
 * implemented; unknown methods remain denied by resolveCommercialOperation.
 */
export const COMMERCIAL_MCP_FOUNDATION_POLICIES = defineCommercialOperationRegistry([
  { surface: 'MCP', operation: 'subscription.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'subscription.orders.list', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'billing.status', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'billing.recharge.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'billing.recharge.list', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'billing.transactions', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'billing.export', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'workspace.data.delete.request', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'workspace.bootstrap', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'commercial.access.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'commercial.catalog.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'creative-points.balance.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'creative-points.statement.list', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'subscription.order.create', domain: 'COMMERCIAL', enabled: false, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'subscription.change', domain: 'COMMERCIAL', enabled: false, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'billing.recharge.create', domain: 'COMMERCIAL', enabled: false, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'merchant.start', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
  { surface: 'MCP', operation: 'platform.connect', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
  { surface: 'MCP', operation: 'catalog.sync', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
  { surface: 'MCP', operation: 'content.export', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
  { surface: 'MCP', operation: 'catalog.image.generate', domain: 'COMMERCIAL', enabled: false, classification: 'POINT_CHARGED', rate_action: 'catalog.image.generate' },
  { surface: 'MCP', operation: 'multimodal.image.edit', domain: 'COMMERCIAL', enabled: false, classification: 'POINT_CHARGED', rate_action: 'multimodal.image.edit' },
  { surface: 'MCP', operation: 'content.generate', domain: 'COMMERCIAL', enabled: false, classification: 'POINT_CHARGED', rate_action: 'content.generate' },
  { surface: 'MCP', operation: 'multimodal.video.request', domain: 'COMMERCIAL', enabled: false, classification: 'POINT_CHARGED', rate_action: 'multimodal.video.request' },
] as const)

export const COMMERCIAL_ACCESS_ERROR_CODES = [
  ERROR_CODES.CREATIVE_POINTS_EXHAUSTED,
  ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT,
  ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE,
  ERROR_CODES.RATE_CARD_UNAVAILABLE,
  ERROR_CODES.COMMERCIAL_ACCESS_STALE,
] as const

export type CommercialAccessErrorCode = (typeof COMMERCIAL_ACCESS_ERROR_CODES)[number]

export const COMMERCIAL_BALANCE_STATES = ['known', 'unknown'] as const
export type CommercialBalanceState = (typeof COMMERCIAL_BALANCE_STATES)[number]

export interface CommercialAccessDecisionBase extends CommercialOperationRef {
  readonly schema_version: 'commercial-access.v1'
  /** Server-issued immutable identifier; clients must never synthesize it. */
  readonly decision_id: string
  readonly decided_at: string
  readonly registry_version: string
  readonly workspace_id: string
  readonly classification: CommercialAccessClass
  readonly allowed: boolean
  readonly quoted_points: number | null
  readonly rate_card_version: string | null
  readonly access_revision: string | null
  readonly error_code: CommercialAccessErrorCode | null
  /** Server-authorized recovery actions only; clients must not synthesize them. */
  readonly next_actions: readonly string[]
}

export interface KnownCommercialAccessDecision extends CommercialAccessDecisionBase {
  readonly balance_state: 'known'
  readonly available_points: number
  readonly access_revision: string
}

export interface UnknownCommercialAccessDecision extends CommercialAccessDecisionBase {
  readonly balance_state: 'unknown'
  /** Unknown is represented as null and must never be projected as zero. */
  readonly available_points: null
}

export type CommercialAccessDecision = KnownCommercialAccessDecision | UnknownCommercialAccessDecision

export interface CommercialAccessGetResult {
  readonly decision: CommercialAccessDecision
}

export type CommercialSkuKind = 'IMPLEMENTATION' | 'MONTHLY_PLAN' | 'PRIVATE_TRIAL' | 'POINT_PACK'

export interface CommercialCatalogBenefit {
  readonly code: string
  readonly value: string
  readonly unit: string | null
}

export interface CommercialCatalogSku {
  readonly sku_id: string
  readonly sku_version_id: string
  readonly kind: CommercialSkuKind
  readonly visibility: 'PUBLIC' | 'PRIVATE'
  readonly name: string
  readonly price_cny: string
  readonly included_points: number | null
  readonly benefits: readonly CommercialCatalogBenefit[]
}

export type CommercialCatalogGetResult =
  | { readonly state: 'known'; readonly catalog_version: string; readonly skus: readonly CommercialCatalogSku[]; readonly error_code: null }
  | { readonly state: 'unknown' | 'unavailable'; readonly catalog_version: null; readonly skus: null; readonly error_code: 'CREATIVE_POINTS_UNAVAILABLE' }

export type CreativePointsBalanceGetResult =
  | { readonly balance_state: 'known'; readonly available_points: number; readonly access_revision: string; readonly next_expiry_at: string | null; readonly expiring_points: number; readonly error_code: null }
  | { readonly balance_state: 'unknown'; readonly available_points: null; readonly access_revision: string | null; readonly next_expiry_at: null; readonly expiring_points: null; readonly error_code: 'CREATIVE_POINTS_UNAVAILABLE' }

export interface CreativePointStatementEntry {
  readonly ledger_event_id: string
  readonly occurred_at: string
  readonly operation_id: string
  readonly kind: 'GRANT' | 'RESERVE' | 'SETTLE' | 'RELEASE' | 'REFUND' | 'REVERSE' | 'EXPIRE' | 'ADJUST'
  readonly points_delta: number
  readonly remaining_points: number
  readonly expires_at: string | null
  readonly source_ref: string | null
}

export type CreativePointsStatementListResult =
  | { readonly state: 'known'; readonly entries: readonly CreativePointStatementEntry[]; readonly next_cursor: string | null; readonly access_revision: string; readonly error_code: null }
  | { readonly state: 'unknown' | 'unavailable'; readonly entries: null; readonly next_cursor: null; readonly access_revision: string | null; readonly error_code: 'CREATIVE_POINTS_UNAVAILABLE' }

export interface CommercialAccessErrorDetails {
  readonly request_id: string
  readonly trace_id: string
  readonly balance_state: CommercialBalanceState
  readonly available_points: number | null
  readonly quoted_points: number | null
  readonly access_revision: string | null
  readonly rate_card_version: string | null
  readonly next_actions: readonly string[]
}

export type CommercialOperationResolution =
  | { readonly outcome: 'REGISTERED'; readonly policy: CommercialOperationPolicy }
  | { readonly outcome: 'DENY_DISABLED'; readonly policy: CommercialOperationPolicy }
  | { readonly outcome: 'DENY_UNCLASSIFIED'; readonly policy: null }

function operationKey({ surface, operation }: CommercialOperationRef): string {
  return `${surface}\u0000${operation}`
}

function assertOperationRef(ref: CommercialOperationRef): void {
  if (!ref.operation || ref.operation.trim() !== ref.operation || /[\u0000-\u001f\u007f]/u.test(ref.operation)) {
    throw new Error(`invalid ${ref.surface} commercial operation identifier`)
  }
}

/**
 * Builds a registry from explicitly reviewed entries. It does not claim that
 * every runtime entry point is covered; use assertCommercialOperationRegistryTotality
 * with manifests generated from the HTTP, MCP and Worker runtimes before cutover.
 */
export function defineCommercialOperationRegistry<const T extends readonly CommercialOperationPolicy[]>(entries: T): T {
  const seen = new Set<string>()
  for (const entry of entries) {
    assertOperationRef(entry)
    const key = operationKey(entry)
    if (seen.has(key)) throw new Error(`duplicate commercial operation: ${entry.surface}:${entry.operation}`)
    seen.add(key)
    const rateAction: unknown = (entry as { readonly rate_action: unknown }).rate_action
    if (entry.domain !== 'COMMERCIAL') {
      if (entry.classification !== null || rateAction !== null) throw new Error(`non-commercial operation cannot declare a point classification: ${entry.surface}:${entry.operation}`)
    } else if (entry.classification === 'POINT_CHARGED') {
      if (typeof rateAction !== 'string' || !rateAction || rateAction.trim() !== rateAction) throw new Error(`charged operation lacks an exact rate action: ${entry.surface}:${entry.operation}`)
    } else if (rateAction !== null) {
      throw new Error(`non-charged operation must not declare a rate action: ${entry.surface}:${entry.operation}`)
    }
  }
  return entries
}

export function resolveCommercialOperation(
  registry: readonly CommercialOperationPolicy[],
  ref: CommercialOperationRef,
): CommercialOperationResolution {
  const key = operationKey(ref)
  const policy = registry.find(candidate => operationKey(candidate) === key)
  if (!policy) return { outcome: 'DENY_UNCLASSIFIED', policy: null }
  return policy.enabled ? { outcome: 'REGISTERED', policy } : { outcome: 'DENY_DISABLED', policy }
}

export interface CommercialRegistryCoverage {
  readonly registered: number
  readonly manifest_operations: number
  readonly by_surface: Readonly<Record<CommercialOperationSurface, number>>
}

/**
 * CI totality gate. Missing entries prevent an unclassified runtime operation
 * from shipping; stale entries prevent a removed/renamed operation from being
 * mistaken for live coverage.
 */
export function assertCommercialOperationRegistryTotality(
  runtimeManifest: readonly CommercialOperationRef[],
  registry: readonly CommercialOperationPolicy[],
): CommercialRegistryCoverage {
  defineCommercialOperationRegistry(registry)
  const manifestKeys = new Set<string>()
  for (const ref of runtimeManifest) {
    assertOperationRef(ref)
    const key = operationKey(ref)
    if (manifestKeys.has(key)) throw new Error(`duplicate runtime commercial operation: ${ref.surface}:${ref.operation}`)
    manifestKeys.add(key)
  }

  const registryKeys = new Set(registry.map(operationKey))
  const missing = runtimeManifest.filter(ref => !registryKeys.has(operationKey(ref)))
  const stale = registry.filter(ref => !manifestKeys.has(operationKey(ref)))
  if (missing.length || stale.length) {
    const parts = [
      ...(missing.length ? [`missing classifications: ${missing.map(ref => `${ref.surface}:${ref.operation}`).join(', ')}`] : []),
      ...(stale.length ? [`stale classifications: ${stale.map(ref => `${ref.surface}:${ref.operation}`).join(', ')}`] : []),
    ]
    throw new Error(parts.join('; '))
  }

  return {
    registered: registry.length,
    manifest_operations: runtimeManifest.length,
    by_surface: {
      MCP: registry.filter(entry => entry.surface === 'MCP').length,
      HTTP: registry.filter(entry => entry.surface === 'HTTP').length,
      WORKER: registry.filter(entry => entry.surface === 'WORKER').length,
    },
  }
}

export function isCommercialAccessErrorCode(code: string): code is CommercialAccessErrorCode {
  return (COMMERCIAL_ACCESS_ERROR_CODES as readonly string[]).includes(code)
}

/** Validates the wire-level null and fail-closed invariants. */
export function assertCommercialAccessDecision(decision: CommercialAccessDecision): CommercialAccessDecision {
  assertOperationRef(decision)
  if (!decision.decision_id || decision.decision_id.trim() !== decision.decision_id) throw new Error('commercial access decision lacks a valid decision_id')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(decision.decided_at) || Number.isNaN(Date.parse(decision.decided_at))) throw new Error('commercial access decision lacks a valid decided_at timestamp')
  if (!decision.workspace_id || !decision.registry_version) throw new Error('commercial access decision lacks workspace or registry version')
  if (decision.balance_state === 'unknown' && decision.available_points !== null) throw new Error('unknown commercial balance must use null available_points')
  if (decision.balance_state === 'known' && (!Number.isSafeInteger(decision.available_points) || decision.available_points < 0)) throw new Error('known available_points must be a non-negative safe integer')
  if (decision.quoted_points !== null && (!Number.isSafeInteger(decision.quoted_points) || decision.quoted_points <= 0)) throw new Error('quoted_points must be null or a positive safe integer')
  if (decision.allowed === (decision.error_code !== null)) throw new Error('allowed decisions cannot have an error_code and denied decisions require one')

  if (decision.classification === 'RECOVERY_CONTROL') {
    if (!decision.allowed || decision.error_code !== null || decision.quoted_points !== null || decision.rate_card_version !== null) {
      throw new Error('recovery controls cannot be commercially denied or charged')
    }
    return decision
  }

  if (decision.balance_state === 'unknown') {
    if (decision.allowed || decision.error_code !== ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE) throw new Error('unknown business access must fail closed as CREATIVE_POINTS_UNAVAILABLE')
    return decision
  }

  if (decision.allowed && decision.available_points <= 0) throw new Error('point-required operation cannot be allowed with zero points')
  if (decision.available_points === 0 && decision.error_code !== ERROR_CODES.CREATIVE_POINTS_EXHAUSTED) throw new Error('zero points must fail as CREATIVE_POINTS_EXHAUSTED')
  if (decision.available_points === 0) {
    if (decision.quoted_points !== null || decision.rate_card_version !== null) throw new Error('exhausted access must not resolve or expose a rate quote')
    return decision
  }
  if (decision.error_code === ERROR_CODES.CREATIVE_POINTS_EXHAUSTED) throw new Error('CREATIVE_POINTS_EXHAUSTED requires zero available_points')

  if (decision.classification === 'POINT_REQUIRED_NO_CHARGE') {
    if (decision.quoted_points !== null || decision.rate_card_version !== null) throw new Error('no-charge operation cannot carry a rate quote')
    if (decision.error_code === ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT || decision.error_code === ERROR_CODES.RATE_CARD_UNAVAILABLE) throw new Error('no-charge operation cannot fail on quote or rate card')
    return decision
  }

  if (decision.error_code === ERROR_CODES.RATE_CARD_UNAVAILABLE) {
    if (decision.quoted_points !== null || decision.rate_card_version !== null) throw new Error('unavailable rate card must not expose a quote or version')
    return decision
  }
  if (decision.quoted_points === null || !decision.rate_card_version) throw new Error('charged operation requires an approved versioned quote')
  if (decision.allowed && decision.available_points < decision.quoted_points) throw new Error('charged operation cannot be allowed with insufficient points')
  if (decision.error_code === ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT && decision.available_points >= decision.quoted_points) throw new Error('insufficient error requires available_points below quoted_points')
  return decision
}
