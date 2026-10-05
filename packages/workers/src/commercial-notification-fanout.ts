/** Publication fanout is a separate bounded worker: no publish transaction walks members. */
export interface CommercialNotificationLease { eventId: string; token: string }
export interface CommercialNotificationBatch { scanned: number; delivered: number; complete: boolean }
export interface CommercialNotificationFanoutRepository {
  claim(leaseSeconds?: number): Promise<CommercialNotificationLease | undefined>
  fanout(lease: CommercialNotificationLease, limit?: number): Promise<CommercialNotificationBatch>
}
export interface CommercialNotificationTickResult extends CommercialNotificationBatch { eventId?: string }
export async function runCommercialNotificationTick(repository: CommercialNotificationFanoutRepository): Promise<CommercialNotificationTickResult> {
  const lease = await repository.claim(60)
  if (!lease) return { scanned: 0, delivered: 0, complete: true }
  // Persist cursor and notifications atomically, then release the lease. A crash
  // before commit replays the same page; after commit resumes the next page.
  return { eventId: lease.eventId, ...await repository.fanout(lease, 200) }
}

export interface CommercialPurchaseResultNotificationRepository {
 seedPurchaseResults(workspaceId: string, limit?: number): Promise<number>
 claimPurchaseResult(workspaceId: string, leaseSeconds?: number): Promise<CommercialNotificationLease | undefined>
 fanoutPurchaseResult(workspaceId: string, lease: CommercialNotificationLease, limit?: number): Promise<CommercialNotificationBatch>
}
export async function runCommercialPurchaseResultNotificationTick(repository: CommercialPurchaseResultNotificationRepository, workspaceId: string): Promise<CommercialNotificationTickResult> {
 if (!workspaceId.trim()) throw new Error('COMMERCIAL_NOTIFICATION_WORKSPACE_REQUIRED')
 await repository.seedPurchaseResults(workspaceId, 200)
 const lease = await repository.claimPurchaseResult(workspaceId, 60)
 if (!lease) return { scanned: 0, delivered: 0, complete: true }
 return { eventId: lease.eventId, ...await repository.fanoutPurchaseResult(workspaceId, lease, 200) }
}
