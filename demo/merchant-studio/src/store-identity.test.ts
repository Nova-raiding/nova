import { describe, expect, it } from 'vitest'
import type { Product, Task } from './api'
import { validateTaskRestoreIdentity, validateTaskStoreIdentity } from './store-identity'

const product: Product = { id: 'product', workspaceId: 'workspace', platform: 'jd', title: '商品', storeName: '', factsConfirmed: true, source: 'manual', skuCount: 0, stock: 0, updatedAt: '' }
const task: Task = { id: 'task', workspaceId: 'workspace', productId: 'product', platform: 'jd', candidateOnly: true, state: 'ready_for_direction', version: 4, createdAt: '' }

describe('existing task restoration identity', () => {
  it('restores a server-declared candidate without a store while keeping publish guards strict', () => {
    expect(validateTaskRestoreIdentity({}, product, task)).toBeNull()
    expect(validateTaskStoreIdentity({}, task)).not.toBeNull()
  })
  it('never infers candidate scope from missing store fields', () => {
    expect(validateTaskRestoreIdentity({}, product, { ...task, candidateOnly: undefined })).not.toBeNull()
    expect(validateTaskRestoreIdentity({}, product, { ...task, candidateOnly: false })).not.toBeNull()
  })
  it('preserves complete matching store requirements for bound tasks', () => {
    const identity = { accountId: 'account', storeName: '店铺' }
    expect(validateTaskRestoreIdentity(identity, { ...product, ...identity }, { ...task, candidateOnly: false, accountId: 'account' })).toBeNull()
    expect(validateTaskRestoreIdentity(identity, { ...product, ...identity }, { ...task, candidateOnly: false, accountId: 'other' })).not.toBeNull()
  })
  it('rejects candidate tasks with mismatched workspace/product/platform or bound scope', () => {
    for (const patch of [{ workspaceId: 'other' }, { productId: 'other' }, { platform: 'taobao' as const }, { accountId: 'account' }, { brandId: 'brand' }, { canonicalProductId: 'canonical' }, { listingId: 'listing' }, { campaignId: 'campaign' }, { campaignItemId: 'item' }]) {
      expect(validateTaskRestoreIdentity({}, product, { ...task, ...patch })).not.toBeNull()
    }
    for (const patch of [{ factsConfirmed: false }, { accountId: 'account' }, { brandId: 'brand' }, { remoteId: 'synced' }]) {
      expect(validateTaskRestoreIdentity({}, { ...product, ...patch }, task)).not.toBeNull()
    }
    expect(validateTaskRestoreIdentity({}, { ...product, remoteId: 'csv-row', source: 'csv' }, task)).toBeNull()
  })
})
