import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildCampaignLifecycleParams, campaignActionAvailability, campaignDialogDescriptionIds, campaignDialogFocusEdge, campaignOptionScopeLabel, campaignReasonDescriptionIds, parseCampaignSnapshot } from './CampaignLifecyclePanel.js'

const campaign = parseCampaignSnapshot({ id: 'campaign-1', state: 'running', revision: 7, items: [{ id: 'item-1', productId: 'product-1', platform: 'jd', accountId: 'store-1', state: 'failed' }] })

describe('merchant campaign lifecycle controls', () => {
  it('preserves scope and current revision from the server', () => expect(campaign).toMatchObject({ revision: 7, items: [{ id: 'item-1', productId: 'product-1', platform: 'jd', accountId: 'store-1' }] }))
  it('preserves delivery-manifest blockers instead of treating a saved draft as runnable', () => {
    const blocked = parseCampaignSnapshot({ id: 'campaign-blocked', state: 'draft', revision: 3, delivery_manifest: { state: 'blocked', validation: { valid: false, code: 'CAMPAIGN_MANIFEST_INVALID', path: 'items[0].listingId' } }, items: [{ id: 'item-1', state: 'pending' }] })
    expect(blocked.delivery).toEqual({ state: 'blocked', valid: false, code: 'CAMPAIGN_MANIFEST_INVALID', path: 'items[0].listingId' })
  })
  it('keeps the batch list relation visible from brand through listing', () => {
    expect(campaignOptionScopeLabel({ brandId: 'brand-1', targets: [{ productId: 'product-1', platform: 'taobao', accountId: 'store-1', canonicalProductId: 'canonical-1', listingId: 'listing-1' }] })).toBe('品牌 brand-1 · product-1 · listing listing-1')
  })
  it('builds fail-closed retry parameters', () => expect(buildCampaignLifecycleParams({ campaign, action: 'retry_failed', reason: ' 人工核对后重试 ', selectedItemIds: ['item-1'], idempotencyKey: 'merchant:key:1' })).toEqual({ campaign_id: 'campaign-1', expected_revision: '7', idempotency_key: 'merchant:key:1', reason: '人工核对后重试', item_ids_json: '["item-1"]' }))
  it('rejects missing reason, revision and retry selection', () => {
    expect(() => buildCampaignLifecycleParams({ campaign, action: 'pause', reason: 'no', idempotencyKey: 'merchant:key:2' })).toThrow()
    expect(() => buildCampaignLifecycleParams({ campaign, action: 'retry_failed', reason: '人工重试', selectedItemIds: [], idempotencyKey: 'merchant:key:3' })).toThrow()
    expect(() => parseCampaignSnapshot({ id: 'campaign-1', state: 'running', revision: 0, items: [] })).toThrow()
  })
  it('pulls keyboard focus back into either edge of the modal', () => {
    expect(campaignDialogFocusEdge(false, false)).toBe('first')
    expect(campaignDialogFocusEdge(false, true)).toBe('last')
    expect(campaignDialogFocusEdge(true, true)).toBeUndefined()
  })
  it('connects the modal to its instructions and assertive action error', () => {
    expect(campaignDialogDescriptionIds(false)).toBe('campaign-action-description')
    expect(campaignDialogDescriptionIds(true)).toBe('campaign-action-description campaign-action-error')
  })
  it('links the reason field to its hint and recoverable submit error', () => {
    expect(campaignReasonDescriptionIds(false)).toBe('campaign-action-reason-hint')
    expect(campaignReasonDescriptionIds(true)).toBe('campaign-action-reason-hint campaign-action-error')
    const source = readFileSync(new URL('./CampaignLifecyclePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('aria-invalid={Boolean(error)}')
    expect(source).toContain('aria-live="assertive" aria-atomic="true"')
    expect(source).toContain('type="button"')
  })
  it('fail-closes every mutating control while the result is unknown or reconciling', () => {
    expect(campaignActionAvailability('unknown')).toEqual({ canPause: false, canResume: false, canRetryFailed: false })
    expect(campaignActionAvailability('reconciling')).toEqual({ canPause: false, canResume: false, canRetryFailed: false })
    expect(campaignActionAvailability('paused')).toMatchObject({ canPause: false, canResume: true })
  })
})
