import { describe, expect, it } from 'vitest'
import type { AssetMetadata } from './api.js'
import { productAssetGenerationBlockers } from './product-assets.js'

const asset = (overrides: Partial<AssetMetadata> = {}) => ({
  id: 'asset-1',
  name: '商品图',
  mimeType: 'image/png',
  sizeBytes: 10,
  rightsStatus: 'approved',
  rightsScope: 'commercial_authorized',
  usageScopes: ['commercial', 'ai_generation'],
  scanStatus: 'clean',
  parseStatus: 'succeeded',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [],
  revision: 1,
  createdAt: '2026-10-10T00:00:00.000Z',
  ...overrides,
}) as AssetMetadata

const blockersFor = (value: AssetMetadata) => productAssetGenerationBlockers({
  platform: 'jd',
  boundIds: [value.id],
  matchedAssets: [value],
  missingAssetIds: [],
})

describe('product asset generation rights', () => {
  it('allows an approved asset with commercial AI generation rights', () => {
    expect(blockersFor(asset())).toEqual([])
  })

  it('allows owned assets when commercial and AI generation are both authorized', () => {
    expect(blockersFor(asset({ rightsScope: 'owned', usageScopes: ['commercial', 'ai_generation'] }))).toEqual([])
  })

  it.each([
    ['limited use', { rightsScope: 'limited_use' }],
    ['internal use', { rightsScope: 'internal_only' }],
    ['missing scope', { rightsScope: undefined }],
    ['missing AI generation permission', { usageScopes: ['commercial'] }],
    ['missing commercial permission', { usageScopes: ['ai_generation'] }],
  ])('blocks an asset with %s rights', (_label, overrides) => {
    expect(blockersFor(asset(overrides))).toContain('已绑定素材的权益范围不支持 AI 商用生成；补充明确授权或解除绑定后再继续。')
  })

  it('blocks a platform outside the asset authorization', () => {
    expect(blockersFor(asset({ applicablePlatforms: ['taobao'] }))).toContain('已绑定素材未授权用于当前商品平台；调整平台授权或解除绑定后再继续。')
  })

  it.each([
    ['future', { validFrom: '2999-01-01T00:00:00.000Z' }],
    ['expired', { validTo: '2000-01-01T00:00:00.000Z' }],
    ['invalid', { validTo: 'not-a-date' }],
  ])('blocks an asset with %s authorization dates', (_label, overrides) => {
    expect(blockersFor(asset(overrides))).toContain('已绑定素材的授权有效期不覆盖当前时间；更新授权后再继续。')
  })
})
