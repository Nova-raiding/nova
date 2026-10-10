import { describe, expect, it } from 'vitest'
import { productAssetGenerationBlockers, resolveProductAssetRelation } from './src/product-assets.js'
import type { AssetMetadata, Product } from './src/api.js'

const product = (sourceAssetIds?: string[]) => ({
  id: 'product-1', workspaceId: 'workspace-1', platform: 'taobao', storeName: '淘宝店', title: '商品', skuCount: 1, stock: 1,
  factsConfirmed: true, source: 'official_api', updatedAt: '2026-08-29T00:00:00.000Z', ...(sourceAssetIds ? { sourceAssetIds } : {}),
} satisfies Product)

const asset = (id: string) => ({
  id, name: `${id}.png`, mimeType: 'image/png', sizeBytes: 100, rightsStatus: 'approved', scanStatus: 'clean', parseStatus: 'succeeded',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true }, references: [], revision: 1, createdAt: '2026-08-29T00:00:00.000Z',
} satisfies AssetMetadata)

describe('merchant product asset relation UI', () => {
  it('only displays product API bindings and reports missing asset records', () => {
    expect(resolveProductAssetRelation(product(['asset-a', 'asset-a', 'asset-missing']), [asset('asset-a')])).toMatchObject({
      boundIds: ['asset-a', 'asset-missing'], matchedAssets: [asset('asset-a')], missingAssetIds: ['asset-missing'],
    })
  })

  it('does not infer a binding from unrelated workspace assets', () => {
    expect(resolveProductAssetRelation(product(), [asset('asset-unrelated')])).toEqual({ boundIds: [], matchedAssets: [], missingAssetIds: [] })
  })

  it('blocks task continuation when an active source binding is missing or not generation-ready', () => {
    const relation = resolveProductAssetRelation(product(['asset-pending', 'asset-missing']), [
      { ...asset('asset-pending'), rightsStatus: 'pending' },
    ])
    expect(productAssetGenerationBlockers(relation)).toEqual([
      '部分已绑定素材未返回详情；重新读取关系后再继续。',
      '已绑定素材尚未通过权益审核；完成审核或解除绑定后再继续。',
    ])
  })

  it('allows continuation when every bound source is scan-clean and rights-approved', () => {
    const relation = resolveProductAssetRelation(product(['asset-ready']), [asset('asset-ready')])
    expect(productAssetGenerationBlockers(relation)).toEqual([])
  })
})
