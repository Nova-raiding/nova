import type { MerchantService } from '../../../packages/application/src/service.js'
import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialAbsoluteCapacityError } from '../../../packages/persistence/src/commercial-capacity-admission.js'
import { CommercialStorageEntitlementError } from '../../../packages/persistence/src/storage-quota-repository.js'

export async function recoverKnownPlatformAccountAdmissionRollback(input: {
  workspaceId: string
  attempted: { id: string }
  attemptedRevision?: number
  error: unknown
  service: Pick<MerchantService, 'platformAccounts' | 'hydrateSnapshot'>
  readDurable(): Promise<Record<string, unknown> | undefined>
}) {
  // Only locally raised admission exceptions prove no commit was attempted.
  if (!(input.error instanceof CommercialAbsoluteCapacityError) && !(input.error instanceof CommercialStorageEntitlementError)) return 'unknown_outcome' as const
  const current = input.service.platformAccounts.get(input.attempted.id)
  if (current !== input.attempted || current.workspaceId !== input.workspaceId || (input.attemptedRevision !== undefined && current.revision !== input.attemptedRevision)) return 'superseded' as const
  let durable: Record<string, unknown> | undefined
  try { durable = await input.readDurable() } catch {
    // No proof of absence: retain the identity, but do not let this known-rejected
    // transient credential act as a successfully connected account.
    if (input.service.platformAccounts.get(input.attempted.id) === current && (input.attemptedRevision === undefined || current.revision === input.attemptedRevision)) input.service.platformAccounts.set(current.id, { ...current, tokenState: 'refresh_required' })
    return 'read_unavailable' as const
  }
  if (input.service.platformAccounts.get(input.attempted.id) !== current || (input.attemptedRevision !== undefined && current.revision !== input.attemptedRevision)) return 'superseded' as const
  if (durable) {
    if (durable.id !== current.id || durable.workspaceId !== input.workspaceId) {
      input.service.platformAccounts.set(current.id, { ...current, tokenState: 'refresh_required' })
      return 'read_unavailable' as const
    }
    input.service.hydrateSnapshot({ entityType: 'platform_account', entity: durable })
    return 'restored' as const
  }
  // hydrateSnapshot/registerPlatformAccount both key this map by entity.id.
  input.service.platformAccounts.delete(current.id)
  return 'removed' as const
}

export function requireKnownEffectiveStorageSnapshot(limitBytes: number, snapshot: { usedBytes: number; reservedBytes: number } | undefined) {
  if (!snapshot || ![limitBytes, snapshot.usedBytes, snapshot.reservedBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new DomainError('STORAGE_QUOTA_USAGE_UNAVAILABLE', '存储用量台账未建立或不可核实，请联系运营核对存储台账后重试', 503, { storage_usage_known: false, retryable: true })
  }
  return { limitBytes, usedBytes: snapshot.usedBytes, reservedBytes: snapshot.reservedBytes }
}
