import {
  ContinuousFeatureEntitlementService,
  type ContinuousFeatureEntitlementSnapshotV2,
} from '../../../packages/application/src/continuous-feature-entitlement.js'

export type CommercialCountBenefitCode = 'max_brands' | 'max_stores'

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
  const quantity = (benefits[0] as Record<string, unknown>).quantity
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new CommercialCountCapacityError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  }
  return quantity
}
