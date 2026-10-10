import { describe, expect, it } from 'vitest'
import type { AssetMetadata } from './api.js'
import { productAssetGenerationBlockers, productAssetGenerationSourceStatus } from './product-assets.js'

const asset = (overrides: Partial<AssetMetadata> = {}) => ({
  id: 'asset-1',
  name: '商品图',
  mimeType: 'image/png',
  sizeBytes: 10,
  rightsStatus: 'approved',
  rightsScope: 'commercial_authorized',
  usageScopes: ['commercial', 'ai_generation'],
  aiModificationAllowed: true,
  scanStatus: 'clean',
  workspaceId: 'workspace-1',
  storageKey: 'clean/workspace-1/product-assets-test.png',
  scanReceiptId: 'receipt-product-assets-test',
  scanReceiptDigest: 'a'.repeat(64),
  scanVerdict: 'clean',
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

  it.each(['video/mp4', 'application/pdf'])('blocks non-image source type %s for image generation', (mimeType) => {
    const nonImage = asset({ mimeType })
    expect(blockersFor(nonImage)).toContain('此素材不是图片；图片生成仅支持 image/* 素材。')
    expect(productAssetGenerationSourceStatus(nonImage, 'jd')).toEqual({
      tone: 'amber',
      label: '暂不能作为生成来源',
    })
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

  it.each([
    ['missing', undefined],
    ['denied', false],
  ])('blocks an asset when AI modification permission is %s', (_label, aiModificationAllowed) => {
    expect(blockersFor(asset({ aiModificationAllowed }))).toContain('尚未明确允许 AI 修改此素材；请在素材权益中确认许可后再继续。')
  })

  it('blocks a platform outside the asset authorization', () => {
    expect(blockersFor(asset({ applicablePlatforms: ['taobao'] }))).toContain('已绑定素材未授权用于当前商品平台；调整平台授权或解除绑定后再继续。')
  })

  it('blocks a legacy clean label when the server projection says scanner proof is missing', () => {
    const legacyClean = asset({
      display: {
        primaryStatus: 'awaiting_scan',
        label: '正在安全检查',
        sourceState: 'blocked',
        reasons: ['安全扫描凭据缺失或无效'],
        nextAction: { method: 'asset.list', label: '刷新状态', allowed: true },
      },
    })
    expect(blockersFor(legacyClean)).toContain('素材尚未通过可信安全扫描；完成扫描后再继续。')
    expect(productAssetGenerationSourceStatus(legacyClean, 'jd')).toMatchObject({ tone: 'amber' })
  })

  it.each([
    ['missing receipt', { scanReceiptId: undefined, scanReceiptDigest: undefined, scanVerdict: undefined }],
    ['invalid digest', { scanReceiptDigest: 'not-a-digest' }],
    ['untrusted storage path', { storageKey: 'quarantine/workspace-1/source.png' }],
    ['readiness warning', { readiness: { status: 'blocked', reasons: ['安全扫描凭据缺失或无效'] } }],
  ])('blocks scanStatus=clean assets with %s', (_label, overrides) => {
    expect(blockersFor(asset(overrides))).toContain('素材尚未通过可信安全扫描；完成扫描后再继续。')
    expect(productAssetGenerationSourceStatus(asset(overrides), 'jd').tone).toBe('amber')
  })

  it('allows a clean asset only when its receipt and clean storage binding are valid', () => {
    expect(blockersFor(asset())).not.toContain('素材尚未通过可信安全扫描；完成扫描后再继续。')
  })

  it.each([
    ['future', { validFrom: '2999-01-01T00:00:00.000Z' }],
    ['expired', { validTo: '2000-01-01T00:00:00.000Z' }],
    ['invalid', { validTo: 'not-a-date' }],
  ])('blocks an asset with %s authorization dates', (_label, overrides) => {
    expect(blockersFor(asset(overrides))).toContain('已绑定素材的授权有效期不覆盖当前时间；更新授权后再继续。')
  })

  it.each([
    ['limited use', { rightsScope: 'limited_use' }],
    ['missing AI scope', { usageScopes: ['commercial'] }],
    ['wrong platform', { applicablePlatforms: ['taobao'] }],
    ['expired authorization', { validTo: '2000-01-01T00:00:00.000Z' }],
  ])('does not show %s assets as a generation source', (_label, overrides) => {
    expect(productAssetGenerationSourceStatus(asset(overrides), 'jd')).toEqual({
      tone: 'amber',
      label: '暂不能作为生成来源',
    })
  })

  it('uses the same allowed state for a valid asset and the continue action', () => {
    const valid = asset()
    expect(productAssetGenerationSourceStatus(valid, 'jd')).toEqual({
      tone: 'green',
      label: '可作为生成来源',
    })
    expect(blockersFor(valid)).toEqual([])
  })
})
