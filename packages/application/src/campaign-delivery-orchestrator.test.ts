import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CampaignBatchRow } from '../../persistence/src/brand-unit-repository.js'
import type { CampaignDeliveryItemInput } from './campaign-delivery-manifest.js'
import {
  CampaignDeliveryOrchestratorAdapter,
  type CampaignDeliveryLifecycleOperation,
  type CampaignDeliveryLifecyclePort,
  type DurableCampaignDeliveryProjection,
} from './campaign-delivery-orchestrator.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function deliveryItem(): CampaignDeliveryItemInput {
  const campaignId = 'campaign-durable-1'
  const brandId = 'brand-durable-1'
  const productId = 'product-durable-1'
  const listingId = 'listing-durable-1'
  const accountId = 'account-durable-1'
  const visualVersion = { id: 'visual-durable-1', hash: digest('visual-durable-1') }
  const specification = { id: 'spec-durable-1', hash: digest('spec-durable-1'), evidenceState: 'production_canary' as const, evidenceRef: 'canary://spec-durable-1' }
  const ruleSnapshot = { id: 'rules-durable-1', hash: digest('rules-durable-1'), checkedAt: '2026-08-29T08:00:00.000Z', evidenceRef: 'rules://durable-1' }
  return {
    id: 'campaign-item-durable-1', productId, listingId, skuIds: ['sku-durable-1'], platform: 'taobao', accountId,
    contentVersion: { id: 'content-durable-1', hash: digest('content-durable-1') }, visualVersions: [visualVersion], specification, ruleSnapshot,
    versionVector: { campaignId, brandId, productId, listingId, skuIds: ['sku-durable-1'], platform: 'taobao', accountId, contentVersionId: 'content-durable-1', visualVersionIds: [visualVersion.id], specificationId: specification.id, ruleSnapshotId: ruleSnapshot.id },
    review: {
      status: 'approved',
      approval: { id: 'approval-durable-1', platform: 'taobao', accountId, productId, listingId, contentVersionId: 'content-durable-1', visualVersionIds: [visualVersion.id], ruleSnapshotId: ruleSnapshot.id, approvedBy: 'reviewer-durable-1', approvedAt: '2026-08-29T08:10:00.000Z' },
    },
    publish: { status: 'failed', attempts: 1, remoteSnapshotHash: digest('remote-durable-1'), error: { code: 'REMOTE_TIMEOUT', message: 'remote timeout' } },
  }
}

function durableRow(): CampaignBatchRow {
  return {
    id: 'campaign-durable-1', workspaceId: 'ws-durable-1', brandId: 'brand-durable-1', platform: 'taobao', accountId: 'account-durable-1',
    productIds: ['product-durable-1'], state: 'failed', revision: 4, createdAt: '2026-08-29T08:00:00.000Z', updatedAt: '2026-08-29T08:20:00.000Z',
    items: [{ id: 'campaign-item-durable-1', workspaceId: 'ws-durable-1', campaignId: 'campaign-durable-1', brandId: 'brand-durable-1', productId: 'product-durable-1', platform: 'taobao', accountId: 'account-durable-1', listingId: 'listing-durable-1', state: 'failed', error: { code: 'REMOTE_TIMEOUT', message: 'remote timeout' }, ordinal: 1 }],
  }
}

describe('CampaignDeliveryOrchestratorAdapter durable row boundary', () => {
  it('projects real CampaignBatchRow shapes through get, pause, resume and retry_failed', async () => {
    const row = durableRow()
    const item = deliveryItem()
    const operations: CampaignDeliveryLifecycleOperation[] = []
    const port: CampaignDeliveryLifecyclePort = {
      execute: async (operation, request): Promise<DurableCampaignDeliveryProjection> => {
        operations.push(operation)
        if (operation === 'pause') {
          row.state = 'paused'; row.revision = 5; row.items![0]!.state = 'paused'
        } else if (operation === 'resume') {
          row.state = 'failed'; row.revision = 6; row.items![0]!.state = 'failed'
        } else if (operation === 'retry_failed') {
          expect(request.itemIds).toEqual(['campaign-item-durable-1'])
          row.state = 'generating'; row.revision = 7; row.items![0]!.state = 'pending'; delete row.items![0]!.error
          item.publish = { status: 'awaiting_confirmation', attempts: 1, remoteSnapshotHash: digest('remote-durable-1') }
        }
        return { row: structuredClone(row), deliveryItems: [structuredClone(item)], ...(operation === 'pause' ? { pauseReason: '运营暂停' } : {}) }
      },
    }
    const adapter = new CampaignDeliveryOrchestratorAdapter(port)
    const scope = { workspaceId: row.workspaceId, campaignId: row.id }

    expect((await adapter.get(scope)).manifest).toMatchObject({ revision: 4, state: 'partial', items: [{ nextAction: 'retry_failed' }] })
    expect((await adapter.pause({ ...scope, reason: '运营暂停' })).manifest).toMatchObject({ revision: 5, state: 'paused', paused: true, pauseReason: '运营暂停' })
    expect((await adapter.resume(scope)).manifest).toMatchObject({ revision: 6, paused: false, items: [{ nextAction: 'retry_failed' }] })
    expect((await adapter.retryFailed({ ...scope, itemIds: ['campaign-item-durable-1'] })).manifest).toMatchObject({ revision: 7, paused: false, items: [{ publish: { status: 'awaiting_confirmation' }, nextAction: 'confirm_publish' }] })
    expect(operations).toEqual(['get', 'pause', 'resume', 'retry_failed'])
  })

  it('rejects durable scope drift and a retry result that remains failed', async () => {
    const row = durableRow()
    const item = deliveryItem()
    const scopeLeak = new CampaignDeliveryOrchestratorAdapter({ execute: async () => ({ row: { ...structuredClone(row), items: [{ ...row.items![0]!, workspaceId: 'ws-foreign' }] }, deliveryItems: [item] }) })
    await expect(scopeLeak.get({ workspaceId: row.workspaceId, campaignId: row.id })).rejects.toMatchObject({ code: 'CAMPAIGN_VERSION_SCOPE_LEAK' })

    const staleRetry = new CampaignDeliveryOrchestratorAdapter({ execute: async () => ({ row, deliveryItems: [item] }) })
    await expect(staleRetry.retryFailed({ workspaceId: row.workspaceId, campaignId: row.id, itemIds: [row.items![0]!.id] })).rejects.toMatchObject({ code: 'CAMPAIGN_INVALID_TRANSITION' })
  })
})
