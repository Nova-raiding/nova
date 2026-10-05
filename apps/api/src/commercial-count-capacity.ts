import {
  ContinuousFeatureEntitlementService,
  type ContinuousFeatureEntitlementSnapshotV2,
} from '../../../packages/application/src/continuous-feature-entitlement.js'

export type CommercialCountBenefitCode = 'max_brands' | 'max_stores' | 'cloud_storage'

export class CommercialCountCapacityError extends Error {
  constructor(
    readonly code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE' | 'COMMERCIAL_ENTITLEMENT_REQUIRED' | 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS',
  ) {
    super(code)
  }
}

export async function resolveCommercialCountBenefit(input: {
  readonly workspaceId: string
  readonly code: CommercialCountBenefitCode
  readonly snapshots: readonly ContinuousFeatureEntitlementSnapshotV2[]
  readonly now?: Date
}): Promise<number> {
  const now = input.now ?? new Date()
  for (const snapshot of input.snapshots) {
    if (snapshot.workspaceId !== input.workspaceId || snapshot.periodStatus !== 'active'
      || Date.parse(snapshot.periodStart) > now.getTime() || Date.parse(snapshot.periodEnd) <= now.getTime()
      || !snapshot.executable || !/^[a-f0-9]{64}$/iu.test(snapshot.checksum)) continue
    if (!Array.isArray(snapshot.resolvedBenefits)) throw new CommercialCountCapacityError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
    const matches = snapshot.resolvedBenefits.filter(value => value && typeof value === 'object' && (value as Record<string, unknown>).code === input.code)
    if (!matches.length) continue
    const value = matches[0] as Record<string, unknown>
    const quantity = input.code === 'cloud_storage' ? value.normalizedValue : value.quantity
    if (matches.length !== 1 || typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) throw new CommercialCountCapacityError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  }
  const entitlement = new ContinuousFeatureEntitlementService({
    projection: { listV2EntitlementSnapshots: async () => input.snapshots },
    now: () => now,
  })
  const decision = await entitlement.decide({ workspace_id: input.workspaceId, decided_at: now.toISOString() })
  if (!decision.allowed) throw new CommercialCountCapacityError(decision.code)

  const snapshot = input.snapshots.find(candidate => candidate.id === decision.snapshot_id)
  if (!snapshot) throw new CommercialCountCapacityError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  const benefits = snapshot.resolvedBenefits.filter(value => {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).code === input.code
  })
  if (benefits.length !== 1) throw new CommercialCountCapacityError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  const benefit = benefits[0] as Record<string, unknown>
  const quantity = input.code === 'cloud_storage' ? benefit.normalizedValue : benefit.quantity
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new CommercialCountCapacityError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  }
  return quantity
}
