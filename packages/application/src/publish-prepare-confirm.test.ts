import { describe, expect, it } from 'vitest'
import { bindPublishReceipt, preparePublish, PublishConfirmationLedger, PublishPrepareConfirmError, type PublishPrepareInput } from './publish-prepare-confirm.js'

const input: PublishPrepareInput = {
  workspaceId: 'ws_publish', taskId: 'task_1', listingId: 'listing_1', canonicalProductId: 'canonical_1', contextHash: 'a'.repeat(64),
  taskRevision: 4, contentVersionId: 'content_1', contentVersionRevision: 2, remoteSnapshotHash: 'b'.repeat(64), payloadHash: 'c'.repeat(64),
}

describe('publish prepare/confirm contract', () => {
  it('freezes a versioned preparation and requires a matching second confirmation', () => {
    const preparation = preparePublish(input, '2026-09-01T01:00:00.000Z')
    const ledger = new PublishConfirmationLedger()
    expect(() => ledger.confirm({ preparation, idempotencyKey: 'confirm-1', currentTaskRevision: 4, currentContentVersionRevision: 2, currentRemoteSnapshotHash: input.remoteSnapshotHash })).toThrowError(expect.objectContaining({ code: 'PUBLISH_CONFIRMATION_REQUIRED' }))
    const confirmed = ledger.confirm({ preparation, idempotencyKey: 'confirm-1', currentTaskRevision: 4, currentContentVersionRevision: 2, currentRemoteSnapshotHash: input.remoteSnapshotHash, secondConfirmation: { confirmedBy: 'operator_1', confirmedAt: '2026-09-01T01:01:00.000Z', confirmationHash: preparation.confirmationHash } })
    expect(confirmed.confirmationHash).toBe(preparation.confirmationHash)
    expect(Object.isFrozen(preparation)).toBe(true)
  })

  it.each([
    ['task revision', { currentTaskRevision: 5 }],
    ['content revision', { currentContentVersionRevision: 3 }],
    ['remote snapshot', { currentRemoteSnapshotHash: 'd'.repeat(64) }],
  ])('rejects %s drift after preparation', (_name, change) => {
    const preparation = preparePublish(input)
    expect(() => new PublishConfirmationLedger().confirm({ preparation, idempotencyKey: 'drift', currentTaskRevision: 4, currentContentVersionRevision: 2, currentRemoteSnapshotHash: input.remoteSnapshotHash, secondConfirmation: { confirmedBy: 'operator_1', confirmedAt: '2026-09-01T01:01:00.000Z', confirmationHash: preparation.confirmationHash }, ...change })).toThrowError(expect.objectContaining({ code: 'PUBLISH_CONFIRMATION_STALE' }))
  })

  it('is idempotent for the same intent and fails closed on key reuse', () => {
    const preparation = preparePublish(input)
    const ledger = new PublishConfirmationLedger()
    const confirmation = { confirmedBy: 'operator_1', confirmedAt: '2026-09-01T01:01:00.000Z', confirmationHash: preparation.confirmationHash }
    const request = { preparation, idempotencyKey: 'same', currentTaskRevision: 4, currentContentVersionRevision: 2, currentRemoteSnapshotHash: input.remoteSnapshotHash, secondConfirmation: confirmation }
    expect(ledger.confirm(request)).toBe(ledger.confirm(request))
    const other = preparePublish({ ...input, payloadHash: 'e'.repeat(64) })
    expect(() => ledger.confirm({ ...request, preparation: other })).toThrowError(expect.objectContaining({ code: 'PUBLISH_IDEMPOTENCY_CONFLICT' }))
  })

  it('binds receipts to the exact prepared workspace/task/listing/canonical/context scope', () => {
    const preparation = preparePublish(input)
    const receipt = bindPublishReceipt(preparation, { receiptId: 'receipt_1', remoteId: 'remote_1', publishedAt: '2026-09-01T01:02:00.000Z', scope: preparation.receiptScope })
    expect(receipt.preparationConfirmationHash).toBe(preparation.confirmationHash)
    expect(() => bindPublishReceipt(preparation, { receiptId: 'receipt_1', remoteId: 'remote_1', publishedAt: '2026-09-01T01:02:00.000Z', scope: { ...preparation.receiptScope, taskId: 'task_other' } })).toThrowError(expect.objectContaining({ code: 'PUBLISH_RECEIPT_UNBOUND' }))
  })

  it('rejects malformed preparation inputs instead of creating an unverifiable confirmation', () => {
    for (const change of [{ taskRevision: 0 }, { contextHash: 'bad' }, { payloadHash: 'bad' }, { taskId: '' }]) {
      expect(() => preparePublish({ ...input, ...change })).toThrowError(PublishPrepareConfirmError)
    }
  })
})
