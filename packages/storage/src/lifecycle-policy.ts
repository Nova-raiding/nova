import type { ObjectZone } from './object-storage.js'

export interface StorageLifecyclePolicy { quarantineRetentionDays: number; cleanRetentionDays: number; deletionGraceDays: number }
export interface LifecycleObject { key: string; zone: ObjectZone; createdAt: string; lastReferencedAt?: string; deletionRequestedAt?: string }
export type LifecycleAction = 'retain' | 'delete'

const validDays = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function validateStorageLifecyclePolicy(input: unknown): StorageLifecyclePolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('STORAGE_LIFECYCLE_POLICY_INVALID')
  const value = input as Partial<StorageLifecyclePolicy>
  if (!validDays(value.quarantineRetentionDays) || !validDays(value.cleanRetentionDays) || !validDays(value.deletionGraceDays)) throw new Error('STORAGE_LIFECYCLE_POLICY_INVALID')
  if (value.quarantineRetentionDays! < 7 || value.cleanRetentionDays! < 30 || value.deletionGraceDays! < 7 || value.deletionGraceDays! > 30) throw new Error('STORAGE_LIFECYCLE_POLICY_TOO_SHORT')
  return { quarantineRetentionDays: value.quarantineRetentionDays!, cleanRetentionDays: value.cleanRetentionDays!, deletionGraceDays: value.deletionGraceDays! }
}

const date = (value: string, code: string) => { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error(code); return parsed }
/** Pure lifecycle decision; references always win over retention expiry. */
export function decideStorageLifecycle(input: { object: LifecycleObject; policy: StorageLifecyclePolicy; now: string }): { action: LifecycleAction; reason: string } {
  const now = date(input.now, 'STORAGE_LIFECYCLE_NOW_INVALID')
  const createdAt = date(input.object.createdAt, 'STORAGE_LIFECYCLE_CREATED_AT_INVALID')
  const referencedAt = input.object.lastReferencedAt === undefined ? undefined : date(input.object.lastReferencedAt, 'STORAGE_LIFECYCLE_REFERENCE_AT_INVALID')
  const deletionRequestedAt = input.object.deletionRequestedAt === undefined ? undefined : date(input.object.deletionRequestedAt, 'STORAGE_LIFECYCLE_DELETION_REQUEST_INVALID')
  if (input.object.zone !== 'quarantine' && input.object.zone !== 'clean') throw new Error('STORAGE_LIFECYCLE_ZONE_INVALID')
  if (createdAt > now) throw new Error('STORAGE_LIFECYCLE_CREATED_AT_IN_FUTURE')
  if (referencedAt !== undefined && referencedAt > now) throw new Error('STORAGE_LIFECYCLE_REFERENCE_IN_FUTURE')
  if (deletionRequestedAt !== undefined && deletionRequestedAt > now) throw new Error('STORAGE_LIFECYCLE_DELETION_REQUEST_IN_FUTURE')
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000)
  if (referencedAt !== undefined && referencedAt >= createdAt) return { action: 'retain', reason: 'active_reference' }
  if (deletionRequestedAt === undefined) {
    const retention = input.object.zone === 'quarantine' ? input.policy.quarantineRetentionDays : input.policy.cleanRetentionDays
    return ageDays >= retention ? { action: 'delete', reason: 'retention_expired' } : { action: 'retain', reason: 'retention_active' }
  }
  return (now - deletionRequestedAt) / 86_400_000 >= input.policy.deletionGraceDays ? { action: 'delete', reason: 'deletion_grace_expired' } : { action: 'retain', reason: 'deletion_grace_active' }
}
