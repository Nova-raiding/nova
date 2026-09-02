import { randomUUID } from 'node:crypto'
import {
  ERROR_CODES,
  assertCommercialAccessDecision,
  defineCommercialOperationRegistry,
  resolveCommercialOperation,
  type CommercialAccessDecision,
  type CommercialAccessErrorCode,
  type CommercialOperationPolicy,
  type CommercialOperationRef,
} from '@merchant-marketing/contracts'
import {
  ContinuousFeatureEntitlementService,
  type ContinuousFeatureEntitlementPort,
} from './continuous-feature-entitlement.js'

export type CreativePointBalanceProjection =
  | {
      readonly state: 'unknown'
    }
  | {
      readonly state: 'known'
      readonly available_points: number
      readonly access_revision: string
      readonly freshness: 'fresh' | 'stale'
    }

export interface CreativePointBalanceProjectionPort {
  /** Reads the creative-point fact projection only; it must not consult RMB wallets or legacy task/add-on quota. */
  projectCreativePointBalance(input: { readonly workspace_id: string }): Promise<CreativePointBalanceProjection>
}

export type ApprovedCreativePointRate =
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'approved'
      readonly quoted_points: number
      readonly rate_card_version: string
    }

export interface ApprovedCreativePointRateResolver {
  /** Resolves an approved, versioned points rate. This is a quote only and never reserves points. */
  resolveApprovedRate(input: {
    readonly workspace_id: string
    readonly operation: CommercialOperationRef
    readonly rate_action: string
  }): Promise<ApprovedCreativePointRate>
}

export interface CommercialAccessRequest extends CommercialOperationRef {
  readonly workspace_id: string
  /** Workers may pin the revision captured when work was admitted. */
  readonly required_access_revision?: string
}

interface CommercialAccessDecisionTrace {
  readonly decision_id: string
  readonly decided_at: string
}

export type CommercialAccessServiceResult = CommercialAccessDecisionTrace & (
  | { readonly outcome: 'DECISION'; readonly decision: CommercialAccessDecision }
  | { readonly outcome: 'DENY_DISABLED'; readonly policy: CommercialOperationPolicy }
  | { readonly outcome: 'DENY_UNCLASSIFIED'; readonly policy: null }
  | { readonly outcome: 'DENY_NON_COMMERCIAL'; readonly policy: CommercialOperationPolicy }
)

export interface CommercialAccessServiceOptions {
  readonly registry: readonly CommercialOperationPolicy[]
  readonly registry_version: string
  readonly balance_projection: CreativePointBalanceProjectionPort
  readonly rate_resolver: ApprovedCreativePointRateResolver
  /** V2 subscription snapshot authority for every non-recovery merchant feature. */
  readonly entitlement_projection: ContinuousFeatureEntitlementPort
  /** Only server-authorized recovery actions may be exposed to clients. */
  readonly next_actions?: (error: CommercialAccessErrorCode) => readonly string[]
  /** Injectable for deterministic tests; production defaults to cryptographic UUIDs. */
  readonly id_factory?: () => string
  /** Injectable for deterministic tests; production defaults to the current clock. */
  readonly now?: () => Date
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function normalizeNextActions(
  resolver: CommercialAccessServiceOptions['next_actions'],
  error: CommercialAccessErrorCode,
): readonly string[] {
  if (!resolver) return []
  try {
    const actions = resolver(error)
    if (!Array.isArray(actions) || actions.some(action => !isNonEmptyText(action))) return []
    return [...new Set(actions)]
  } catch {
    return []
  }
}

function normalizeBalance(value: CreativePointBalanceProjection): CreativePointBalanceProjection {
  if (!value || value.state !== 'known') return { state: 'unknown' }
  if (!Number.isSafeInteger(value.available_points) || value.available_points < 0) return { state: 'unknown' }
  if (!isNonEmptyText(value.access_revision)) return { state: 'unknown' }
  if (value.freshness !== 'fresh' && value.freshness !== 'stale') return { state: 'unknown' }
  return value
}

function normalizeRate(value: ApprovedCreativePointRate): ApprovedCreativePointRate {
  if (!value || value.state !== 'approved') return { state: 'unavailable' }
  if (!Number.isSafeInteger(value.quoted_points) || value.quoted_points <= 0) return { state: 'unavailable' }
  if (!isNonEmptyText(value.rate_card_version)) return { state: 'unavailable' }
  return value
}

/**
 * Central commercial access policy. It classifies exact operations, reads only
 * creative-point facts, and produces a quote/decision. Point reservation and
 * consumption intentionally remain in the persistence unit of work.
 */
export class CommercialAccessService {
  readonly #registry: readonly CommercialOperationPolicy[]
  readonly #registryVersion: string
  readonly #balanceProjection: CreativePointBalanceProjectionPort
  readonly #rateResolver: ApprovedCreativePointRateResolver
  readonly #continuousEntitlement: ContinuousFeatureEntitlementService
  readonly #nextActions?: CommercialAccessServiceOptions['next_actions']
  readonly #idFactory: () => string
  readonly #now: () => Date

  constructor(options: CommercialAccessServiceOptions) {
    if (!isNonEmptyText(options.registry_version)) throw new Error('commercial access registry_version must be non-empty')
    this.#registry = Object.freeze([...defineCommercialOperationRegistry([...options.registry])])
    this.#registryVersion = options.registry_version
    this.#balanceProjection = options.balance_projection
    this.#rateResolver = options.rate_resolver
    this.#continuousEntitlement = new ContinuousFeatureEntitlementService({ projection: options.entitlement_projection, now: options.now })
    this.#nextActions = options.next_actions
    this.#idFactory = options.id_factory ?? randomUUID
    this.#now = options.now ?? (() => new Date())
  }

  async decide(request: CommercialAccessRequest): Promise<CommercialAccessServiceResult> {
    if (!isNonEmptyText(request.workspace_id)) throw new Error('commercial access workspace_id must be non-empty')
    if (request.required_access_revision !== undefined && !isNonEmptyText(request.required_access_revision)) {
      throw new Error('required_access_revision must be non-empty when provided')
    }

    const trace = this.#createTrace()

    const ref: CommercialOperationRef = { surface: request.surface, operation: request.operation }
    const resolution = resolveCommercialOperation(this.#registry, ref)
    if (resolution.outcome !== 'REGISTERED') return { ...trace, ...resolution }
    const policy = resolution.policy
    if (policy.domain !== 'COMMERCIAL') return { ...trace, outcome: 'DENY_NON_COMMERCIAL', policy }

    if (policy.classification === 'RECOVERY_CONTROL') {
      return {
        ...trace,
        outcome: 'DECISION',
        decision: assertCommercialAccessDecision({
          ...trace,
          schema_version: 'commercial-access.v1',
          registry_version: this.#registryVersion,
          workspace_id: request.workspace_id,
          ...ref,
          classification: policy.classification,
          balance_state: 'unknown',
          available_points: null,
          quoted_points: null,
          rate_card_version: null,
          access_revision: null,
          allowed: true,
          error_code: null,
          next_actions: [],
        }),
      }
    }

    let balance: CreativePointBalanceProjection
    try {
      balance = normalizeBalance(await this.#balanceProjection.projectCreativePointBalance({ workspace_id: request.workspace_id }))
    } catch {
      balance = { state: 'unknown' }
    }

    const decisionBase = {
      ...trace,
      schema_version: 'commercial-access.v1' as const,
      registry_version: this.#registryVersion,
      workspace_id: request.workspace_id,
      ...ref,
      classification: policy.classification,
    }

    if (balance.state === 'unknown') {
      return this.#decision(trace, {
        ...decisionBase,
        balance_state: 'unknown',
        available_points: null,
        quoted_points: null,
        rate_card_version: null,
        access_revision: null,
        allowed: false,
        error_code: ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE,
        next_actions: normalizeNextActions(this.#nextActions, ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE),
      })
    }

    const knownBase = {
      ...decisionBase,
      balance_state: 'known' as const,
      available_points: balance.available_points,
      access_revision: balance.access_revision,
    }

    // Zero is authoritative and precedes rate lookup: no business operation is usable.
    if (balance.available_points === 0) {
      return this.#decision(trace, {
        ...knownBase,
        quoted_points: null,
        rate_card_version: null,
        allowed: false,
        error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED,
        next_actions: normalizeNextActions(this.#nextActions, ERROR_CODES.CREATIVE_POINTS_EXHAUSTED),
      })
    }

    const revisionIsStale = balance.freshness === 'stale'
      || (request.required_access_revision !== undefined && request.required_access_revision !== balance.access_revision)

    if (policy.classification === 'POINT_REQUIRED_NO_CHARGE') {
      if (revisionIsStale) {
        return this.#decision(trace, {
          ...knownBase,
          quoted_points: null,
          rate_card_version: null,
          allowed: false,
          error_code: ERROR_CODES.COMMERCIAL_ACCESS_STALE,
          next_actions: normalizeNextActions(this.#nextActions, ERROR_CODES.COMMERCIAL_ACCESS_STALE),
        })
      }
      const candidate = {
        ...knownBase,
        quoted_points: null,
        rate_card_version: null,
        allowed: true,
        error_code: null,
        next_actions: [],
      } as const
      return this.#entitlementDecision(trace, candidate)
    }

    let rate: ApprovedCreativePointRate
    try {
      rate = normalizeRate(await this.#rateResolver.resolveApprovedRate({
        workspace_id: request.workspace_id,
        operation: ref,
        rate_action: policy.rate_action,
      }))
    } catch {
      rate = { state: 'unavailable' }
    }

    if (rate.state === 'unavailable') {
      return this.#decision(trace, {
        ...knownBase,
        quoted_points: null,
        rate_card_version: null,
        allowed: false,
        error_code: ERROR_CODES.RATE_CARD_UNAVAILABLE,
        next_actions: normalizeNextActions(this.#nextActions, ERROR_CODES.RATE_CARD_UNAVAILABLE),
      })
    }

    const quoteBase = {
      ...knownBase,
      quoted_points: rate.quoted_points,
      rate_card_version: rate.rate_card_version,
    }
    if (revisionIsStale) {
      return this.#decision(trace, {
        ...quoteBase,
        allowed: false,
        error_code: ERROR_CODES.COMMERCIAL_ACCESS_STALE,
        next_actions: normalizeNextActions(this.#nextActions, ERROR_CODES.COMMERCIAL_ACCESS_STALE),
      })
    }
    if (balance.available_points < rate.quoted_points) {
      return this.#decision(trace, {
        ...quoteBase,
        allowed: false,
        error_code: ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT,
        next_actions: normalizeNextActions(this.#nextActions, ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT),
      })
    }
    return this.#entitlementDecision(trace, { ...quoteBase, allowed: true, error_code: null, next_actions: [] })
  }

  #createTrace(): CommercialAccessDecisionTrace {
    const decisionId = this.#idFactory()
    if (!isNonEmptyText(decisionId)) throw new Error('commercial access id_factory returned an invalid decision_id')
    const decidedAt = this.#now()
    if (!(decidedAt instanceof Date) || Number.isNaN(decidedAt.getTime())) throw new Error('commercial access now returned an invalid date')
    return { decision_id: decisionId, decided_at: decidedAt.toISOString() }
  }

  #decision(trace: CommercialAccessDecisionTrace, decision: CommercialAccessDecision): CommercialAccessServiceResult {
    return { ...trace, outcome: 'DECISION', decision: assertCommercialAccessDecision(decision) }
  }

  async #entitlementDecision(
    trace: CommercialAccessDecisionTrace,
    candidate: CommercialAccessDecision,
  ): Promise<CommercialAccessServiceResult> {
    const entitlement = await this.#continuousEntitlement.decide({ workspace_id: candidate.workspace_id, decided_at: trace.decided_at })
    if (entitlement.allowed) return this.#decision(trace, candidate)
    return this.#decision(trace, {
      ...candidate,
      allowed: false,
      error_code: entitlement.code,
      next_actions: normalizeNextActions(this.#nextActions, entitlement.code),
    })
  }
}
