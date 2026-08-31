import { describe, expect, it } from 'vitest'
import {
  DELIVERY_PLATFORMS,
  PLATFORM_DELIVERY_CAPABILITIES,
  planDeliveryVariants,
  type DeliverySourceAsset,
  type DeliverySpecification,
  type DeliveryVariantPlanInput,
} from './delivery-variant-planner.js'

const verifiedSpecification = (input: Partial<DeliverySpecification> & Pick<DeliverySpecification, 'id' | 'device' | 'width' | 'height'>): DeliverySpecification => ({
  ...input,
  safeZone: input.safeZone ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  maxCopyLength: input.maxCopyLength ?? { headline: 20, subtitle: 40, cta: 10 },
  formats: input.formats ?? ['jpg', 'png', 'webp'],
  maxFileBytes: input.maxFileBytes ?? 2_000_000,
  evidence: input.evidence ?? { state: 'production_canary', reference: `evidence://${input.id}`, checkedAt: '2026-08-29T00:00:00.000Z' },
})

const baseInput = (overrides: Partial<DeliveryVariantPlanInput> = {}): DeliveryVariantPlanInput => ({
  platform: 'taobao',
  placement: 'campaign-hero',
  devices: ['desktop'],
  productCount: 1,
  sourceAssets: [{ id: 'asset-a', width: 1200, height: 1200, safeZone: { x: 0.2, y: 0.15, width: 0.6, height: 0.7 }, productIds: ['product-a'] }],
  specifications: [verifiedSpecification({ id: 'merchant-verified-desktop', device: 'desktop', width: 1200, height: 400 })],
  copy: { headline: '秋季上新', subtitle: '真实商品图与已确认卖点', cta: '立即查看' },
  activity: { countdown: 'none' },
  ...overrides,
})

describe('Banner and ad delivery variant planner', () => {
  it('declares all six platforms without embedding invented official dimensions', () => {
    expect(Object.keys(PLATFORM_DELIVERY_CAPABILITIES)).toEqual(DELIVERY_PLATFORMS)
    for (const platform of DELIVERY_PLATFORMS) expect(PLATFORM_DELIVERY_CAPABILITIES[platform]).toEqual({ platform, localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' })
    expect(JSON.stringify(PLATFORM_DELIVERY_CAPABILITIES)).not.toMatch(/(?:width|height|px)/u)
  })

  it('plans deterministic desktop/mobile variants, crop axes, navigation, section and multi-product bindings', () => {
    const input = baseInput({
      platform: 'tmall',
      devices: ['desktop', 'mobile'],
      productCount: 2,
      sourceAssets: [
        { id: 'asset-a', width: 1200, height: 1200, safeZone: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, productIds: ['product-a'] },
        { id: 'asset-b', width: 900, height: 1200, safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, productIds: ['product-b'] },
      ],
      specifications: [
        verifiedSpecification({ id: 'verified-pc-hero', device: 'desktop', width: 1200, height: 400 }),
        verifiedSpecification({ id: 'verified-mobile-hero', device: 'mobile', width: 750, height: 1000, formats: ['webp'], maxFileBytes: 1_000_000 }),
      ],
      navigation: { requested: true, labels: ['新品', '热卖'] },
      section: { id: 'autumn', name: '秋季专区' },
      productBindings: [
        { productId: 'product-a', assetIds: ['asset-a'], sectionId: 'autumn' },
        { productId: 'product-b', assetIds: ['asset-b'], sectionId: 'autumn' },
      ],
      activity: { startsAt: '2026-09-01T00:00:00+08:00', endsAt: '2026-09-10T23:59:00+08:00', countdown: 'live' },
    })
    const first = planDeliveryVariants(input)
    const second = planDeliveryVariants(input)

    expect(second).toEqual(first)
    expect(first.readyForProduction).toBe(true)
    expect(first.externallyUnverified).toBe(false)
    expect(first.variants.map(variant => [variant.device, variant.width, variant.height])).toEqual([['desktop', 1200, 400], ['mobile', 750, 1000]])
    expect(first.variants[0]).toMatchObject({ id: 'tmall-campaign-hero-desktop-1200x400-1', safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, filePolicy: { formats: ['jpg', 'png', 'webp'], maxFileBytes: 2_000_000 } })
    expect(first.variants[0]?.crops).toEqual([
      expect.objectContaining({ sourceAssetId: 'asset-a', mode: 'cover', cropAxis: 'vertical', anchor: 'source_safe_zone_center', requiresManualReview: true }),
      expect.objectContaining({ sourceAssetId: 'asset-b', mode: 'cover', cropAxis: 'vertical', requiresManualReview: true }),
    ])
    expect(first.variants[1]?.crops[0]).toMatchObject({ cropAxis: 'horizontal', requiresManualReview: true })
    expect(first.composition).toMatchObject({ layout: 'multi_product_grid', navigation: { requested: true, labels: ['新品', '热卖'], requiresRuntimeLinks: true }, section: { id: 'autumn', name: '秋季专区' } })
    expect(first.composition.productBindings).toHaveLength(2)
    expect(first.countdown).toMatchObject({ mode: 'live', requiresRuntimeRendering: true, startsAt: '2026-08-31T16:00:00.000Z', endsAt: '2026-09-10T15:59:00.000Z' })
    expect(first.findings).toContainEqual(expect.objectContaining({ code: 'RUNTIME_RENDERING_REQUIRED', severity: 'info' }))
  })

  it('reports overlong multilingual copy per variant and blocks production', () => {
    const plan = planDeliveryVariants(baseInput({
      platform: 'jd',
      specifications: [verifiedSpecification({ id: 'jd-input-spec', device: 'desktop', width: 1000, height: 300, maxCopyLength: { headline: 4, subtitle: 6, cta: 2 } })],
      copy: { headline: '秋季新品上架', subtitle: '真实商品信息展示', cta: '立即购买' },
    }))

    expect(plan.readyForLocalPreview).toBe(true)
    expect(plan.readyForProduction).toBe(false)
    expect(plan.findings.filter(finding => finding.code === 'COPY_TOO_LONG')).toEqual([
      expect.objectContaining({ path: 'copy.headline', actual: 6, limit: 4 }),
      expect.objectContaining({ path: 'copy.subtitle', actual: 8, limit: 6 }),
      expect.objectContaining({ path: 'copy.cta', actual: 4, limit: 2 }),
    ])
  })

  it('fails safe when a requested device has no supplied specification', () => {
    const plan = planDeliveryVariants(baseInput({ platform: 'pinduoduo', devices: ['desktop', 'mobile'], specifications: [] }))

    expect(plan.variants).toEqual([])
    expect(plan.readyForLocalPreview).toBe(false)
    expect(plan.readyForProduction).toBe(false)
    expect(plan.externallyUnverified).toBe(true)
    expect(plan.findings.filter(finding => finding.code === 'DELIVERY_SPEC_MISSING').map(finding => finding.path)).toEqual(['specifications.desktop', 'specifications.mobile'])
  })

  it('returns input dimensions but marks documentary or unverified specifications externally unverified', () => {
    for (const platform of ['xiaohongshu', 'douyin'] as const) {
      const plan = planDeliveryVariants(baseInput({
        platform,
        specifications: [verifiedSpecification({ id: `${platform}-documented`, device: 'desktop', width: 901, height: 317, evidence: { state: 'official_document', reference: `https://docs.example/${platform}` } })],
      }))
      expect(plan.variants[0]).toMatchObject({ width: 901, height: 317, externallyUnverified: true, specificationEvidence: { state: 'official_document' } })
      expect(plan.externallyUnverified).toBe(true)
      expect(plan.readyForProduction).toBe(false)
      expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'DELIVERY_SPEC_EXTERNALLY_UNVERIFIED', severity: 'error' }))
    }
  })

  it('blocks incomplete multi-product bindings and missing live activity time', () => {
    const plan = planDeliveryVariants(baseInput({
      productCount: 2,
      productBindings: [{ productId: 'product-a', assetIds: ['missing-asset'] }],
      navigation: { requested: true },
      activity: { startsAt: '2026-09-01T00:00:00Z', countdown: 'live' },
    }))

    expect(plan.readyForProduction).toBe(false)
    expect(plan.composition.layout).toBe('multi_product_grid')
    expect(plan.countdown.requiresRuntimeRendering).toBe(true)
    expect(plan.findings.map(finding => finding.code)).toEqual(expect.arrayContaining(['NAVIGATION_LABELS_MISSING', 'SECTION_REQUIRED', 'PRODUCT_BINDING_MISSING', 'PRODUCT_BINDING_INVALID', 'ACTIVITY_WINDOW_INCOMPLETE', 'RUNTIME_RENDERING_REQUIRED']))
  })

  it('never assigns known-platform capability or inferred dimensions to an unknown platform', () => {
    const plan = planDeliveryVariants(baseInput({ platform: 'mystery-market', specifications: [] }))

    expect(plan.capability).toEqual({ platform: 'mystery-market', localPlanning: 'unsupported', officialDimensions: 'unknown', productionDelivery: 'blocked' })
    expect(plan.variants).toEqual([])
    expect(plan.externallyUnverified).toBe(true)
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_PLATFORM', severity: 'error' }))
  })

  it('blocks copy without a target safe zone and cross-product asset bindings', () => {
    const plan = planDeliveryVariants(baseInput({
      productCount: 2,
      section: { id: 'two-products' },
      sourceAssets: [
        { id: 'asset-a', width: 1000, height: 1000, productIds: ['product-a'] },
        { id: 'asset-b', width: 1000, height: 1000, productIds: ['product-b'] },
      ],
      productBindings: [
        { productId: 'product-a', assetIds: ['asset-b'] },
        { productId: 'product-b', assetIds: ['asset-a'] },
      ],
      specifications: [{ ...verifiedSpecification({ id: 'no-safe-zone', device: 'desktop', width: 1000, height: 400 }), safeZone: undefined }],
    }))

    expect(plan.readyForProduction).toBe(false)
    expect(plan.findings.filter(finding => finding.code === 'PRODUCT_BINDING_INVALID')).toHaveLength(2)
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'SAFE_ZONE_MISSING', severity: 'error' }))
  })

  it('bounds non-finite dimensions and oversized collections', () => {
    const oversized = Array.from({ length: 257 }, (_, index) => ({ id: `asset-${index}`, width: 1, height: 1 }))
    const plan = planDeliveryVariants(baseInput({
      productCount: Number.POSITIVE_INFINITY,
      sourceAssets: oversized,
      specifications: [verifiedSpecification({ id: 'bad-size', device: 'desktop', width: Number.NaN, height: -1 })],
    }))
    expect(plan.readyForProduction).toBe(false)
    expect(plan.findings.map(item => item.code)).toEqual(expect.arrayContaining(['PRODUCT_COUNT_INVALID', 'SOURCE_ASSET_MISSING', 'DELIVERY_SPEC_INVALID']))
  })

  it('rejects duplicate assets, invalid formats and ambiguous claim scope', () => {
    const plan = planDeliveryVariants(baseInput({
      productCount: 2,
      section: { id: 'section-a' },
      sourceAssets: [
        { id: 'same', width: 100, height: 100, productIds: ['product-a'] },
        { id: 'same', width: 100, height: 100, productIds: ['product-b'] },
      ],
      productBindings: [
        { productId: 'product-a', assetIds: ['same'] },
        { productId: 'product-b', assetIds: ['same'] },
      ],
      specifications: [verifiedSpecification({ id: 'bad-format', device: 'desktop', width: 100, height: 100, formats: ['jpg', 'exe' as never] })],
    }))
    expect(plan.readyForProduction).toBe(false)
    expect(plan.findings.map(item => item.code)).toEqual(expect.arrayContaining(['SOURCE_ASSET_INVALID', 'PRODUCT_BINDING_INVALID', 'FILE_POLICY_MISSING']))
  })

  it('freezes output and does not retain mutable input arrays', () => {
    const input = baseInput()
    const plan = planDeliveryVariants(input)
    ;(input.sourceAssets as DeliverySourceAsset[]).push({ id: 'late', width: 1, height: 1 })
    expect(plan.variants[0]?.crops).toHaveLength(1)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.variants)).toBe(true)
    expect(() => { plan.findings.push({ code: 'UNKNOWN_PLATFORM', severity: 'error', path: '', message: '' }) }).toThrow()
  })
})
