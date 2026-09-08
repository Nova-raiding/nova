import { describe, expect, it, vi } from 'vitest'
import { executeCharged } from './commercial-execution.js'

function harness() {
  const ledger = { reserve: vi.fn(async () => ({ reservation_id: 'r1', points: 3, rate_card_version: 'rate:v1' })), settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const audit = { record: vi.fn(async () => undefined) }
  return { ledger, audit }
}

describe('executeCharged', () => {
  it('reserves, requires receipt evidence, settles, and audits', async () => {
    const h = harness()
    const result = await executeCharged({ workspace_id: 'ws1', action_key: 'image.generate', idempotency_key: 'k1', quoted_points: 3, rate_card_version: 'rate:v1', ...h, provider: async () => ({ value: { id: 'asset1' }, receipt: { outcome: 'succeeded' as const, provider_request_id: 'p1', receipt_hash: 'a'.repeat(64), usage: { modality: 'image' }, cost: { currency: 'CNY', actual: 0.1 } } }) })
    expect(result.value).toEqual({ id: 'asset1' })
    expect(h.ledger.reserve).toHaveBeenCalledOnce()
    expect(h.ledger.settle).toHaveBeenCalledOnce()
    expect(h.ledger.release).not.toHaveBeenCalled()
    expect(h.audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' }))
  })

  it('releases known provider failures', async () => {
    const h = harness()
    await expect(executeCharged({ workspace_id: 'ws1', action_key: 'text.generate', idempotency_key: 'k2', quoted_points: 1, rate_card_version: 'rate:v1', ...h, provider: async () => ({ value: null, receipt: { outcome: 'failed' as const, provider_request_id: 'p2', receipt_hash: 'b'.repeat(64) } }) })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' })
    expect(h.ledger.release).toHaveBeenCalled()
    expect(h.ledger.settle).not.toHaveBeenCalled()
  })

  it('retains unknown outcomes for reconciliation', async () => {
    const h = harness()
    await expect(executeCharged({ workspace_id: 'ws1', action_key: 'video.generate', idempotency_key: 'k3', quoted_points: 90, rate_card_version: 'rate:v1', ...h, provider: async () => ({ value: null, receipt: { outcome: 'unknown' as const, provider_request_id: 'p3', receipt_hash: 'c'.repeat(64) } }) })).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' })
    expect(h.ledger.release).not.toHaveBeenCalled()
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ state: 'reconciliation_required' }))
  })
})
