import { describe, expect, it } from 'vitest'
import { campaignActionParams, parseCampaignControlSnapshot } from './CampaignLifecycleControl.js'

const campaign = parseCampaignControlSnapshot({ id: 'campaign-1', state: 'running', revision: 9, items: [{ item_id: 'item-1', product_id: 'product-1', platform: 'tmall', account_id: 'store-1', state: 'failed' }] })

describe('Ops campaign lifecycle control', () => {
  it('normalizes campaign scope without inventing fields', () => expect(campaign).toMatchObject({ revision: 9, items: [{ id: 'item-1', productId: 'product-1', platform: 'tmall', accountId: 'store-1' }] }))
  it('submits expected revision, reason, item scope and stable key', () => expect(campaignActionParams({ campaign, action: 'retry_failed', reason: ' 人工确认失败项 ', itemIds: ['item-1'], idempotencyKey: 'ops:key:123' })).toEqual({ campaign_id: 'campaign-1', expected_revision: '9', idempotency_key: 'ops:key:123', reason: '人工确认失败项', item_ids_json: '["item-1"]' }))
  it('fails closed on malformed state and incomplete confirmation', () => { expect(() => parseCampaignControlSnapshot({ id: 'x', state: 'running', items: [] })).toThrow(); expect(() => campaignActionParams({ campaign, action: 'pause', reason: 'x', idempotencyKey: 'ops:key:1' })).toThrow(); expect(() => campaignActionParams({ campaign, action: 'retry_failed', reason: '人工重试', itemIds: [], idempotencyKey: 'ops:key:2' })).toThrow() })
})
