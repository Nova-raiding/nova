import {
  ContinuousFeatureEntitlementService,
} from '../../../packages/application/src/continuous-feature-entitlement.js'
import type { CommercialEntitlementSnapshotV2 } from '../../../packages/persistence/src/commercial-contract-repository.js'

type EntitlementReadCode = 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE' | 'COMMERCIAL_ENTITLEMENT_REQUIRED' | 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS'

export interface SubscriptionV2Entitlement {
  schema_version: 'commercial.entitlement.v2'
  status: 'available' | 'unknown'
  plan: string | null
  period: { start: string; end: string } | null
  sourceVersion: string | null
  checksum: string | null
  entitlement_id: string | null
  subscription_period_id: string | null
  code: EntitlementReadCode | null
}

const unknown = (code: EntitlementReadCode): SubscriptionV2Entitlement => ({
  schema_version: 'commercial.entitlement.v2',
  status: 'unknown',
  plan: null,
  period: null,
  sourceVersion: null,
  checksum: null,
  entitlement_id: null,
  subscription_period_id: null,
  code,
})

/** Read only the tenant-scoped V2 snapshots; legacy subscription fields cannot grant access. */
export async function readSubscriptionV2Entitlement(input: {
  workspaceId: string
  listSnapshots: (workspaceId: string, limit: number) => Promise<readonly CommercialEntitlementSnapshotV2[]>
  now?: Date
}): Promise<SubscriptionV2Entitlement> {
  const now = input.now ?? new Date()
  let snapshots: readonly CommercialEntitlementSnapshotV2[]
  try {
    // A full page might omit another active entitlement. Refuse to choose one
    // from a truncated view rather than turn ambiguity into success.
    snapshots = await input.listSnapshots(input.workspaceId, 200)
  } catch {
    return unknown('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  }
  if (!Array.isArray(snapshots) || snapshots.length >= 200) return unknown('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  const selector = new ContinuousFeatureEntitlementService({
    projection: { listV2EntitlementSnapshots: async () => snapshots },
    now: () => now,
  })
  const decision = await selector.decide({ workspace_id: input.workspaceId, decided_at: now.toISOString() })
  if (!decision.allowed) return unknown(decision.code)
  const snapshot = snapshots.find(row => row.id === decision.snapshot_id)
  if (!snapshot) return unknown('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  return {
    schema_version: 'commercial.entitlement.v2',
    status: 'available',
    plan: snapshot.skuCode,
    period: { start: snapshot.periodStart, end: snapshot.periodEnd },
    sourceVersion: snapshot.catalogVersionId,
    checksum: snapshot.checksum,
    entitlement_id: snapshot.id,
    subscription_period_id: snapshot.subscriptionPeriodId,
    code: null,
  }
}
