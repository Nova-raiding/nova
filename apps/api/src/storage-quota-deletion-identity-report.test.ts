import { describe, expect, it } from 'vitest'
import { MemoryStorageQuotaRepository } from '../../../packages/persistence/src/index.js'
import { operationalAlertsForTests, releaseStorageQuotaAfterConfirmedDeletion } from './server.js'

/**
 * Evidence for `storage-quota-deletion-identity-mismatch-is-reported` in
 * `tests/invariants/registry.ts`, mutation-tested by `npm run invariants:verify`.
 *
 * The refusal this drives is the one the reservation-key invariant added:
 * `assertDeletionIdentity` (packages/persistence/src/storage-quota-repository.ts)
 * refuses to repay a settled row when the deletion receipt names a different
 * object than the reservation key, because honouring it would credit bytes whose
 * object is still stored. Its only production caller deletes the object *first*
 * and then wrapped the release in a bare `catch {}` - so on the path that
 * matters the object is gone, the row keeps its bytes, `used_bytes` stays
 * inflated, and nothing anywhere says so. Reconciliation is a read-only
 * snapshot, so nothing repairs it either.
 *
 * The subject here is the caller's *reporting*, not the refusal: the refusal is
 * the guard, and this file asserts that it is (a) still a refusal - the row
 * stays charged - and (b) recorded as an operational alert naming the row and
 * the delete receipt that did not match it.
 *
 * The ledger is the memory repository the API ships as its non-durable
 * persistence, and the refusal comes from the same exported
 * `assertDeletionIdentity` both implementations call, so nothing about the
 * decision is faked here. The mutations registered for this row break the
 * reporting in both directions: removing it (the shipped `catch {}`), and making
 * it unconditional (an alert for a release that was legitimately repaid).
 */

/**
 * The assertion message the row registers as `evidenceFailsWith`. The gate
 * refuses to score "the process exited non-zero" as proof, so the sentence the
 * failing run prints is part of the row - and the same sentence has to come out
 * whichever direction of the reporting is broken.
 */
const SILENT_REFUSAL = 'a refused release must be recorded as an operational alert, not swallowed'

/**
 * One workspace per case, because the alert repository is process-wide: a
 * shared workspace would let the refusal case's alert be read as the repair
 * case's.
 */
async function settleRow(input: { workspaceId: string; reservationKey: string }) {
  const quota = new MemoryStorageQuotaRepository()
  await quota.reserve({ workspaceId: input.workspaceId, reservationKey: input.reservationKey, assetId: 'asset_identity', bytes: 100, limitBytes: 1_000 })
  await quota.settle({ workspaceId: input.workspaceId, reservationKey: input.reservationKey, actualBytes: 100 })
  expect((await quota.getSnapshot(input.workspaceId))?.usedBytes).toBe(100)
  return quota
}

describe('a refused storage-quota release is reported, not swallowed', () => {
  it('records an operational alert when the delete receipt names a different object', async () => {
    const workspaceId = 'ws_quota_identity_mismatch'
    // The object the reservation key names...
    const reservationKey = 'asset:asset_identity/photo.png'
    // ...and the receipt for a *different* object of the same asset that was
    // deleted. Honouring the pair would repay bytes whose object is still
    // stored, so the ledger refuses it.
    const deletedObjectKey = `clean/${workspaceId}/asset_identity/sibling.png`
    const quota = await settleRow({ workspaceId, reservationKey })

    let deletions = 0
    await releaseStorageQuotaAfterConfirmedDeletion({
      quota,
      workspaceId,
      reservationKey,
      objectKey: deletedObjectKey,
      deleteObject: async () => { deletions += 1; return true },
    })
    expect(deletions, 'the object deletion is confirmed before the release is attempted').toBe(1)

    // The refusal itself holds: the settled row keeps its bytes. That is exactly
    // why it cannot be silent.
    expect((await quota.getSnapshot(workspaceId))?.usedBytes).toBe(100)
    const alerts = await operationalAlertsForTests.list(workspaceId, 'open')
    expect(alerts.map(alert => alert.code), SILENT_REFUSAL).toEqual(['STORAGE_QUOTA_DELETION_IDENTITY_MISMATCH'])
    expect(alerts[0]).toMatchObject({
      severity: 'high',
      entityType: 'storage_quota',
      entityId: reservationKey,
      evidence: { reservation_key: reservationKey, object_key: deletedObjectKey },
    })
  })

  it('repays the row and raises nothing when the receipt names the object the reservation is for', async () => {
    const workspaceId = 'ws_quota_identity_repaired'
    const reservationKey = 'asset:asset_identity/clean_photo.png'
    const quota = await settleRow({ workspaceId, reservationKey })

    await releaseStorageQuotaAfterConfirmedDeletion({
      quota,
      workspaceId,
      reservationKey,
      objectKey: `clean/${workspaceId}/asset_identity/clean_photo.png`,
      deleteObject: async () => true,
    })

    // The legitimate release still repays the row...
    expect((await quota.getSnapshot(workspaceId))?.usedBytes).toBe(0)
    // ...and reporting it would be the mirror defect: an alert an operator
    // cannot act on, for a row that is already correct.
    expect((await operationalAlertsForTests.list(workspaceId, 'open')).map(alert => alert.code), SILENT_REFUSAL).toEqual([])
  })
})
