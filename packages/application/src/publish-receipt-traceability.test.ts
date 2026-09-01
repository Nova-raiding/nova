import { describe, expect, it } from 'vitest'
import { publishReceiptScopeHash, PublishReceiptTraceError, validatePublishReceiptUsageTrace, type PublishReceiptTraceScope } from './publish-receipt-traceability.js'

const scope: PublishReceiptTraceScope = {
  workspaceId: 'ws_receipt', taskId: 'task_1', listingId: 'listing_1', canonicalProductId: 'canonical_1', contextHash: 'a'.repeat(64),
}

const input = {
  receipt: { receiptId: 'receipt_1', remoteId: 'remote_1', publishedAt: '2026-08-31T10:00:00.000Z', scope },
  usage: { usageId: 'usage_1', providerRequestId: 'provider_1', scope },
}

describe('publish receipt and usage traceability', () => {
  it('returns an immutable, deterministic trace for the exact task/listing/context scope', () => {
    const first = validatePublishReceiptUsageTrace(input)
    const second = validatePublishReceiptUsageTrace(structuredClone(input))
    expect(first).toEqual(second)
    expect(first.traceHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(publishReceiptScopeHash(scope)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it.each([
    ['taskId', { taskId: 'task_other' }],
    ['listingId', { listingId: 'listing_other' }],
    ['contextHash', { contextHash: 'b'.repeat(64) }],
  ])('rejects receipt/usage %s drift instead of inferring the relationship', (_field, change) => {
    const usageScope = { ...scope, ...change }
    expect(() => validatePublishReceiptUsageTrace({ ...input, usage: { ...input.usage, scope: usageScope } })).toThrowError(expect.objectContaining({ code: 'PUBLISH_RECEIPT_TRACE_USAGE_MISMATCH' }))
  })

  it('rejects missing or malformed task, listing, canonical and context identity', () => {
    for (const change of [{ taskId: '' }, { listingId: '' }, { canonicalProductId: '' }, { contextHash: 'not-a-hash' }]) {
      expect(() => publishReceiptScopeHash({ ...scope, ...change })).toThrowError(PublishReceiptTraceError)
    }
  })

  it('rejects usage with a different workspace even when all other IDs match', () => {
    expect(() => validatePublishReceiptUsageTrace({ ...input, usage: { ...input.usage, scope: { ...scope, workspaceId: 'ws_other' } } })).toThrowError(expect.objectContaining({ code: 'PUBLISH_RECEIPT_TRACE_USAGE_MISMATCH' }))
  })

  it('allows a platform receipt without model usage while keeping receipt scope mandatory', () => {
    const trace = validatePublishReceiptUsageTrace({ receipt: input.receipt })
    expect(trace.usage).toBeUndefined()
    expect(trace.receipt.scope).toEqual(scope)
  })
})
