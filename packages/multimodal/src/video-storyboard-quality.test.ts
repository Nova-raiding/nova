import { describe, expect, it } from 'vitest'
import { evaluateVideoStoryboardQuality, type VideoRightsEvidence, type VideoStoryboardQualityInput, type VideoStoryboardScene } from './video-storyboard-quality.js'

const approvedRights = (platform = 'douyin'): VideoRightsEvidence => ({ status: 'approved', evidenceRef: 'rights://approved', validUntil: '2027-01-01T00:00:00Z', platforms: [platform] })

const scene = (input: Partial<VideoStoryboardScene> & Pick<VideoStoryboardScene, 'id' | 'startSeconds' | 'endSeconds'>): VideoStoryboardScene => ({
  id: input.id,
  startSeconds: input.startSeconds,
  endSeconds: input.endSeconds,
  visual: input.visual ?? '真实商品全景与细节展示',
  productIds: input.productIds ?? ['product-a'],
  skuIds: input.skuIds ?? ['sku-a'],
  claims: input.claims ?? [{ id: `${input.id}-claim`, kind: 'product_selling_point', text: '已确认面料细节', factSourceIds: ['fact://material'], productIds: ['product-a'], skuIds: ['sku-a'] }],
  onScreenCopy: input.onScreenCopy,
  subtitle: input.subtitle ?? { text: '真实商品细节', safeZone: { x: 0.1, y: 0.75, width: 0.8, height: 0.12 } },
  transition: input.transition,
  audio: input.audio,
  people: input.people,
  logos: input.logos,
})

const baseInput = (overrides: Partial<VideoStoryboardQualityInput> = {}): VideoStoryboardQualityInput => ({
  platform: 'douyin',
  platformCapability: {
    state: 'production_canary', evidenceRef: 'canary://douyin/video', verifiedAt: '2026-08-29T00:00:00Z',
    specification: { durationsSeconds: [15, 30], aspectRatios: ['9:16'], resolutions: [{ width: 1080, height: 1920 }], fps: [30], containers: ['mp4'], maxFileBytes: 20_000_000, maxSubtitleChars: 30, subtitleSafeZone: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } },
  },
  reviewAt: '2026-08-29T12:00:00Z',
  durationSeconds: 15,
  aspectRatio: '9:16',
  resolution: { width: 1080, height: 1920 },
  fps: 30,
  scenes: [
    scene({ id: 's1', startSeconds: 0, endSeconds: 5, transition: { kind: 'cut' }, audio: [{ id: 'music-a', kind: 'music', rights: approvedRights() }], people: [{ id: 'person-a', rights: approvedRights() }], logos: [{ brandId: 'brand-a', assetId: 'logo-a', rights: approvedRights() }] }),
    scene({ id: 's2', startSeconds: 5, endSeconds: 10, transition: { kind: 'fade', durationSeconds: 0.2 }, onScreenCopy: '会员价 ¥99', claims: [{ id: 'promotion-a', kind: 'promotion', text: '会员价 ¥99', factSourceIds: ['promotion://snapshot-a'], productIds: ['product-a'], skuIds: ['sku-a'], promotion: { validFrom: '2026-08-20T00:00:00Z', validUntil: '2026-09-10T00:00:00Z', productIds: ['product-a'], skuIds: ['sku-a'] } }] }),
    scene({ id: 's3', startSeconds: 10, endSeconds: 15 }),
  ],
  cover: { assetId: 'cover-a', productIds: ['product-a'], skuIds: ['sku-a'], factSourceIds: ['asset://cover-a'], rights: approvedRights() },
  output: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', fileBytes: 8_000_000 },
  completionEvidence: { rendering: { state: 'real_render_passed', artifactRef: 'artifact://video-a', checksum: `sha256:${'a'.repeat(64)}`, rendererVersion: 'renderer-1' }, ocr: { state: 'passed', reportRef: 'ocr://video-a' }, humanReview: { state: 'approved', reviewRef: 'review://video-a', actorId: 'merchant-reviewer', reviewedAt: '2026-08-29T11:00:00Z' } },
  provenance: 'model_generated',
  ...overrides,
})

describe('video brief, storyboard and delivery quality gate', () => {
  it('accepts a fully evidenced, contiguous 15-second production video', () => {
    const report = evaluateVideoStoryboardQuality(baseInput())

    expect(report).toMatchObject({ platform: 'douyin', externallyUnverified: false, storyboardValid: true, publishable: true })
    expect(report.blocks).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.nextActions).toEqual([])
  })

  it('accepts a 30-second multi-SKU storyboard when every claim and cover binding is scoped', () => {
    const rights = approvedRights('tmall')
    const report = evaluateVideoStoryboardQuality(baseInput({
      platform: 'tmall',
      platformCapability: { ...baseInput().platformCapability, evidenceRef: 'canary://tmall/video' },
      durationSeconds: 30,
      scenes: [
        scene({ id: 'sku-a', startSeconds: 0, endSeconds: 15, productIds: ['product-a'], skuIds: ['sku-a'], transition: { kind: 'cut' }, claims: [{ id: 'claim-a', kind: 'product_selling_point', text: 'SKU A 面料', factSourceIds: ['fact://sku-a'], productIds: ['product-a'], skuIds: ['sku-a'] }], audio: [{ id: 'voice-a', kind: 'voiceover', rights }] }),
        scene({ id: 'sku-b', startSeconds: 15, endSeconds: 30, productIds: ['product-a'], skuIds: ['sku-b'], claims: [{ id: 'claim-b', kind: 'product_selling_point', text: 'SKU B 版型', factSourceIds: ['fact://sku-b'], productIds: ['product-a'], skuIds: ['sku-b'] }] }),
      ],
      cover: { assetId: 'cover-multi', productIds: ['product-a'], skuIds: ['sku-a', 'sku-b'], factSourceIds: ['asset://cover-multi'], rights },
    }))

    expect(report.publishable).toBe(true)
    expect(report.findings).toEqual([])
  })

  it('blocks expired promotion copy while retaining the scene-level next action', () => {
    const input = baseInput()
    const scenes = input.scenes.map(item => ({ ...item, claims: item.claims.map(claim => claim.kind === 'promotion' ? { ...claim, promotion: { ...claim.promotion, validUntil: '2026-08-28T00:00:00Z' } } : claim) }))
    const report = evaluateVideoStoryboardQuality({ ...input, scenes })

    expect(report.publishable).toBe(false)
    expect(report.blocks).toContainEqual(expect.objectContaining({ code: 'PROMOTION_EXPIRED', sceneId: 's2', path: 'scenes[1].claims[0].promotion.validUntil' }))
    expect(report.nextActions).toContain('更新活动快照或移除价格促销表达')
  })

  it('blocks unlicensed music even when all rendering evidence is present', () => {
    const input = baseInput()
    const scenes = input.scenes.map((item, index) => index === 0 ? { ...item, audio: [{ id: 'music-denied', kind: 'music' as const, rights: { status: 'denied' as const } }] } : item)
    const report = evaluateVideoStoryboardQuality({ ...input, scenes })

    expect(report.storyboardValid).toBe(false)
    expect(report.publishable).toBe(false)
    expect(report.blocks).toContainEqual(expect.objectContaining({ code: 'AUDIO_RIGHTS_INVALID', sceneId: 's1' }))
  })

  it('detects timeline overlap, gaps and total-duration mismatch', () => {
    const report = evaluateVideoStoryboardQuality(baseInput({ scenes: [
      scene({ id: 's1', startSeconds: 0, endSeconds: 6, transition: { kind: 'cut' } }),
      scene({ id: 's2', startSeconds: 5, endSeconds: 10, transition: { kind: 'cut' } }),
      scene({ id: 's3', startSeconds: 12, endSeconds: 14 }),
    ] }))

    expect(report.publishable).toBe(false)
    expect(report.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['TIMELINE_OVERLAP', 'TIMELINE_GAP', 'TIMELINE_DURATION_MISMATCH']))
  })

  it('marks non-canary model previews externally unverified and requires real render, OCR and human approval', () => {
    const report = evaluateVideoStoryboardQuality(baseInput({
      platformCapability: { state: 'official_document', evidenceRef: 'https://docs.example/video', specification: baseInput().platformCapability.specification },
      completionEvidence: { rendering: { state: 'model_preview', artifactRef: 'preview://model' }, ocr: { state: 'not_run' }, humanReview: { state: 'pending' } },
      provenance: 'model_generated',
    }))

    expect(report.externallyUnverified).toBe(true)
    expect(report.storyboardValid).toBe(true)
    expect(report.publishable).toBe(false)
    expect(report.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['PLATFORM_SPEC_EXTERNALLY_UNVERIFIED', 'REAL_RENDER_EVIDENCE_REQUIRED', 'OCR_EVIDENCE_REQUIRED', 'HUMAN_REVIEW_REQUIRED']))
    expect(report.blocks.find(item => item.code === 'REAL_RENDER_EVIDENCE_REQUIRED')?.message).toContain('模型生成的脚本/预览不等于真实成片')
  })

  it('blocks unsafe or unreadable subtitles and a mismatched cover', () => {
    const input = baseInput()
    const scenes = input.scenes.map((item, index) => index === 0 ? { ...item, subtitle: { text: '这是一段远远超过五秒镜头可读长度限制而且必须被明确阻断的字幕文案', safeZone: { x: 0, y: 0.95, width: 1, height: 0.1 } } } : item)
    const report = evaluateVideoStoryboardQuality({ ...input, scenes, cover: { ...input.cover, productIds: ['other-product'], skuIds: ['other-sku'] } })

    expect(report.publishable).toBe(false)
    expect(report.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['SUBTITLE_SAFE_ZONE_INVALID', 'SUBTITLE_TOO_LONG', 'COVER_PRODUCT_MISMATCH']))
  })

  it('rejects fake inherited completion review and non-cryptographic render checksum', () => {
    const input = baseInput()
    const humanReview = Object.create(input.completionEvidence.humanReview!)
    const report = evaluateVideoStoryboardQuality(baseInput({
      completionEvidence: {
        ...input.completionEvidence,
        rendering: { ...input.completionEvidence.rendering!, checksum: 'sha256:abc' },
        humanReview,
      },
    }))
    expect(report.publishable).toBe(false)
    expect(report.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['REAL_RENDER_EVIDENCE_REQUIRED', 'HUMAN_REVIEW_REQUIRED']))
  })

  it('fails closed on huge scene arrays, non-finite values and missing claim scope', () => {
    const oversized = Array.from({ length: 257 }, (_, index) => scene({ id: `s-${index}`, startSeconds: index, endSeconds: index + 1 }))
    const huge = evaluateVideoStoryboardQuality(baseInput({ scenes: oversized }))
    expect(huge.blocks).toContainEqual(expect.objectContaining({ code: 'VIDEO_CONFIGURATION_INVALID', path: 'input' }))

    const input = baseInput()
    const first = { ...input.scenes[0]!, claims: [{ id: 'unscoped', kind: 'product_selling_point' as const, text: '卖点', factSourceIds: ['fact-a'] }] }
    const invalid = evaluateVideoStoryboardQuality({ ...input, durationSeconds: Number.POSITIVE_INFINITY, resolution: { width: -1, height: Number.NaN }, scenes: [first, ...input.scenes.slice(1)] })
    expect(invalid.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['VIDEO_CONFIGURATION_INVALID', 'CLAIM_SCOPE_INVALID']))
  })

  it('rejects a future canary timestamp and returns a recursively frozen report', () => {
    const input = baseInput({ platformCapability: { ...baseInput().platformCapability, verifiedAt: '2026-08-30T00:00:00Z' } })
    const report = evaluateVideoStoryboardQuality(input)
    expect(report.blocks).toContainEqual(expect.objectContaining({ code: 'PLATFORM_SPEC_EXTERNALLY_UNVERIFIED' }))
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.findings)).toBe(true)
  })
})
