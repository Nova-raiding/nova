import { describe, expect, it } from 'vitest'
import { buildCanonicalExecutionBinding, sameCanonicalExecutionBinding } from './canonical-execution-binding.js'

const base = { workspaceId: 'ws_binding', taskId: 'task_1', productId: 'product_1', platform: 'taobao', accountId: 'account_1' }

describe('canonical execution binding', () => {
  it('keeps an explicit legacy-only task distinguishable', () => {
    const binding = buildCanonicalExecutionBinding(base)
    expect(binding).toMatchObject({ mode: 'legacy_only', snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(binding.canonicalProductId).toBeUndefined()
  })

  it('requires each canonical and campaign scope pair together', () => {
    expect(() => buildCanonicalExecutionBinding({ ...base, canonicalProductId: 'canonical_1' })).toThrow('CANONICAL_EXECUTION_BINDING_INCOMPLETE')
    expect(() => buildCanonicalExecutionBinding({ ...base, listingId: 'listing_1', campaignId: 'campaign_1', campaignItemId: 'item_1' })).toThrow('CANONICAL_EXECUTION_BINDING_INCOMPLETE')
    expect(buildCanonicalExecutionBinding({ ...base, canonicalProductId: 'canonical_1', listingId: 'listing_1' })).toMatchObject({ mode: 'standard', canonicalProductId: 'canonical_1', listingId: 'listing_1' })
  })

  it('hashes the complete standard scope and detects drift', () => {
    const binding = buildCanonicalExecutionBinding({ ...base, canonicalProductId: 'canonical_1', listingId: 'listing_1', campaignId: 'campaign_1', campaignItemId: 'item_1' })
    const same = buildCanonicalExecutionBinding({ ...base, canonicalProductId: 'canonical_1', listingId: 'listing_1', campaignId: 'campaign_1', campaignItemId: 'item_1' })
    const changed = buildCanonicalExecutionBinding({ ...base, accountId: 'account_2', canonicalProductId: 'canonical_1', listingId: 'listing_1', campaignId: 'campaign_1', campaignItemId: 'item_1' })
    expect(binding.mode).toBe('standard')
    expect(sameCanonicalExecutionBinding(binding, same)).toBe(true)
    expect(sameCanonicalExecutionBinding(binding, changed)).toBe(false)
  })
})
