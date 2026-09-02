/**
 * The one scope contract shared by canonical-first application operations.
 *
 * A legacy product id is an explicitly persisted projection only. This module
 * never derives it from a title, platform name, or array position.
 */
export interface UnifiedCanonicalScope {
  workspaceId: string
  brandId: string
  canonicalProductId: string
  listingId: string
  platform: string
  accountId: string
}

export interface LegacyProductProjection {
  productId: string
  workspaceId: string
  brandId: string
  platform: string
  accountId: string
  canonicalProductId: string
  listingId: string
}

export interface LegacyProductCandidate {
  productId: string
  workspaceId: string
  brandId?: string
  platform?: string
  accountId?: string
  canonicalProductId?: string
  listingId?: string
}

export type UnifiedCanonicalScopeResult =
  | {
      status: 'verified'
      scope: UnifiedCanonicalScope
      legacyProjection?: LegacyProductProjection
    }
  | {
      status: 'blocked'
      code:
        | 'CANONICAL_SCOPE_REQUIRED'
        | 'CANONICAL_SCOPE_INVALID'
        | 'LEGACY_PRODUCT_MAPPING_REQUIRED'
        | 'LEGACY_PRODUCT_MAPPING_AMBIGUOUS'
        | 'LEGACY_PROJECTION_SCOPE_MISMATCH'
      reason: string
    }

const required = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

const scopeMatches = (candidate: LegacyProductCandidate, scope: UnifiedCanonicalScope): boolean => (
  candidate.workspaceId === scope.workspaceId
  && candidate.brandId === scope.brandId
  && candidate.platform === scope.platform
  && candidate.accountId === scope.accountId
  && candidate.canonicalProductId === scope.canonicalProductId
  && candidate.listingId === scope.listingId
)

/**
 * Resolve the complete scope needed by content, review, billing and publish
 * application paths. Legacy callers may provide a persisted product id; when
 * they do, exactly one complete projection must match the canonical scope.
 */
export function resolveUnifiedCanonicalScope(input: {
  scope: Partial<UnifiedCanonicalScope>
  legacyProductId?: string
  legacyCandidates?: readonly LegacyProductCandidate[]
}): UnifiedCanonicalScopeResult {
  const workspaceId = required(input.scope.workspaceId)
  const brandId = required(input.scope.brandId)
  const canonicalProductId = required(input.scope.canonicalProductId)
  const listingId = required(input.scope.listingId)
  const platform = required(input.scope.platform)
  const accountId = required(input.scope.accountId)
  if (!workspaceId || !brandId || !canonicalProductId || !listingId || !platform || !accountId) {
    return { status: 'blocked', code: 'CANONICAL_SCOPE_REQUIRED', reason: 'CANONICAL_SCOPE_INCOMPLETE' }
  }
  const scope: UnifiedCanonicalScope = { workspaceId, brandId, canonicalProductId, listingId, platform, accountId }

  const legacyProductId = required(input.legacyProductId)
  if (!legacyProductId) return { status: 'verified', scope }

  const candidates = (input.legacyCandidates ?? []).filter(candidate => candidate.productId === legacyProductId)
  if (candidates.length === 0) {
    return { status: 'blocked', code: 'LEGACY_PRODUCT_MAPPING_REQUIRED', reason: 'LEGACY_PRODUCT_MAPPING_MISSING' }
  }
  if (candidates.length > 1) {
    return { status: 'blocked', code: 'LEGACY_PRODUCT_MAPPING_AMBIGUOUS', reason: 'LEGACY_PRODUCT_MAPPING_CONFLICT' }
  }
  const candidate = candidates[0]!
  if (!scopeMatches(candidate, scope)) {
    return { status: 'blocked', code: 'LEGACY_PROJECTION_SCOPE_MISMATCH', reason: 'LEGACY_PROJECTION_SCOPE_MISMATCH' }
  }
  return {
    status: 'verified',
    scope,
    legacyProjection: {
      productId: candidate.productId,
      ...scope,
    },
  }
}
