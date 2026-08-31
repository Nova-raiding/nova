import { afterAll, describe, expect, it } from 'vitest'
import {
  buildDeliveryBundleManifest,
  evaluateVideoStoryboardQuality,
  evaluateVisualAuthenticity,
  planAssetPreviews,
  planDeliveryVariants,
  verifyDeliveryBundle,
  type DeliveryBundleBuildResult,
} from '../packages/multimodal/src/index.js'
import {
  MULTIMODAL_DELIVERY_GOLDEN_SCENARIOS,
  bundleFixture,
  deliveryVariantFixture,
  findingsForManifest,
  previewFixture,
  videoFixture,
  visualFixture,
} from './fixtures/multimodal-delivery-golden.fixture.js'

type GoldenObservation = { id: string; expectedP0: number; detectedP0: number; missedP0: number; signal: string }
const observations: GoldenObservation[] = []

const observe = (id: string, detected: boolean, signal: string) => {
  const scenario = MULTIMODAL_DELIVERY_GOLDEN_SCENARIOS.find(item => item.id === id)
  if (!scenario) throw new Error(`Unknown golden scenario: ${id}`)
  expect(scenario.p0Expectation).toMatch(/^P0 期望：/u)
  const expectedP0 = scenario.expectedRisk ? 1 : 0
  const detectedP0 = scenario.expectedRisk && detected ? 1 : 0
  const result = { id, expectedP0, detectedP0, missedP0: expectedP0 - detectedP0, signal }
  observations.push(result)
  expect(result.missedP0, `${scenario.name} P0 漏检: ${signal}`).toBe(0)
}

const materializedPreview = (plan: ReturnType<typeof planAssetPreviews>) => {
  expect(plan.status).toBe('ready')
  const job = plan.jobs.find(item => item.outputFormat === 'webp')
  if (!job) throw new Error('Expected a WebP derivative job')
  // Fixture boundary: the worker completed the deterministic plan, rescanned
  // the derivative, and supplied immutable bytes to the manifest builder.
  return { path: job.targetKey, content: new Uint8Array([21, 22, 23, 24]), blocked: false, externallyUnverified: false }
}

const assertBuilt = (result: DeliveryBundleBuildResult) => {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result
}

describe.sequential('multimodal delivery chain P0 golden gate', () => {
  it('安全图片包：variant → visual → preview → manifest → verify', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const visual = evaluateVisualAuthenticity(visualFixture(false))
    const preview = materializedPreview(planAssetPreviews(previewFixture('clean')))
    expect(variant.readyForProduction).toBe(true)
    expect(visual.publishable).toBe(true)

    const input = bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(visual.findings), preview })
    const first = assertBuilt(buildDeliveryBundleManifest(input))
    const second = assertBuilt(buildDeliveryBundleManifest(input))
    expect(first.manifest.publishable).toBe(true)
    expect(second.manifestHash).toBe(first.manifestHash)
    expect(verifyDeliveryBundle(first.manifest, first.files, first.manifestHash)).toEqual({ valid: true, errors: [] })
    observe('safe-image', false, first.manifestHash)
  })

  it('安全视频分镜包：variant → storyboard quality → preview → manifest → verify', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const video = evaluateVideoStoryboardQuality(videoFixture(true))
    const preview = materializedPreview(planAssetPreviews(previewFixture('clean')))
    expect(video.publishable).toBe(true)

    const input = bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(video.findings), preview })
    const first = assertBuilt(buildDeliveryBundleManifest(input))
    const second = assertBuilt(buildDeliveryBundleManifest(input))
    expect(first.manifest.publishable).toBe(true)
    expect(second.manifestHash).toBe(first.manifestHash)
    expect(verifyDeliveryBundle(first.manifest, first.files, first.manifestHash).valid).toBe(true)
    observe('safe-video', false, first.manifestHash)
  })

  it('未验证平台规格：upstream unverified 传导为 manifest non-publishable', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(false))
    expect(variant.externallyUnverified).toBe(true)
    expect(variant.readyForProduction).toBe(false)
    const visual = evaluateVisualAuthenticity(visualFixture(false))
    const preview = materializedPreview(planAssetPreviews(previewFixture('clean')))
    const bundle = assertBuilt(buildDeliveryBundleManifest(bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(visual.findings), preview })))
    expect(bundle.manifest.publishable).toBe(false)
    expect(bundle.manifest.externallyUnverified.some(item => item.startsWith('variant:'))).toBe(true)
    observe('unverified-platform-spec', !bundle.manifest.publishable, 'DELIVERY_SPEC_EXTERNALLY_UNVERIFIED')
  })

  it('视觉漂移：upstream block 不得在 manifest 中变成 publishable', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const visual = evaluateVisualAuthenticity(visualFixture(true))
    const preview = materializedPreview(planAssetPreviews(previewFixture('clean')))
    expect(visual.status).toBe('block')
    const bundle = assertBuilt(buildDeliveryBundleManifest(bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(visual.findings), preview })))
    expect(bundle.manifest.publishable).toBe(false)
    expect(bundle.manifest.review.findings).toContainEqual(expect.objectContaining({ code: 'LOGO_DRIFT', status: 'blocked' }))
    observe('visual-drift', !bundle.manifest.publishable, 'LOGO_DRIFT')
  })

  it('素材隔离：quarantined preview 无 job 且阻断交付', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const previewPlan = planAssetPreviews(previewFixture('quarantined'))
    expect(previewPlan).toMatchObject({ status: 'blocked', jobs: [] })
    const bundle = assertBuilt(buildDeliveryBundleManifest(bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(previewPlan.findings) })))
    expect(bundle.manifest.publishable).toBe(false)
    expect(bundle.manifest.review.findings).toContainEqual(expect.objectContaining({ code: 'SCAN_NOT_CLEAN', status: 'blocked' }))
    observe('asset-quarantine', !bundle.manifest.publishable, 'SCAN_NOT_CLEAN')
  })

  it('视频权益缺失：quality block 传导到 manifest', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const video = evaluateVideoStoryboardQuality(videoFixture(false))
    const preview = materializedPreview(planAssetPreviews(previewFixture('clean')))
    expect(video.publishable).toBe(false)
    expect(video.blocks).toContainEqual(expect.objectContaining({ code: 'AUDIO_RIGHTS_INVALID' }))
    const bundle = assertBuilt(buildDeliveryBundleManifest(bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(video.findings), preview })))
    expect(bundle.manifest.publishable).toBe(false)
    observe('video-rights-missing', !bundle.manifest.publishable, 'AUDIO_RIGHTS_INVALID')
  })

  it('跨租户 scope：manifest 构建硬阻断', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const result = buildDeliveryBundleManifest(bundleFixture({ variantPlan: variant, scopeOverride: { workspaceId: 'ws_other_tenant' } }))
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SCOPE_MISMATCH' })]) })
    observe('cross-tenant-scope', !result.ok, 'SCOPE_MISMATCH')
  })

  it('manifest 篡改：verifyDeliveryBundle 检出内容 hash 变化', () => {
    const variant = planDeliveryVariants(deliveryVariantFixture(true))
    const visual = evaluateVisualAuthenticity(visualFixture(false))
    const preview = materializedPreview(planAssetPreviews(previewFixture('clean')))
    const bundle = assertBuilt(buildDeliveryBundleManifest(bundleFixture({ variantPlan: variant, reviewFindings: findingsForManifest(visual.findings), preview })))
    const tampered = bundle.files.map(file => file.path === 'content.json' ? { ...file, content: '{"golden":false}' } : file)
    const verification = verifyDeliveryBundle(bundle.manifest, tampered, bundle.manifestHash)
    expect(verification.valid).toBe(false)
    expect(verification.errors).toContainEqual(expect.objectContaining({ code: 'FILE_HASH_MISMATCH', path: 'content.json' }))
    observe('manifest-tampering', !verification.valid, 'FILE_HASH_MISMATCH')
  })

  afterAll(() => {
    expect(observations).toHaveLength(MULTIMODAL_DELIVERY_GOLDEN_SCENARIOS.length)
    expect(new Set(observations.map(item => item.id)).size).toBe(MULTIMODAL_DELIVERY_GOLDEN_SCENARIOS.length)
    const totals = observations.reduce((sum, item) => ({ expectedP0: sum.expectedP0 + item.expectedP0, detectedP0: sum.detectedP0 + item.detectedP0, missedP0: sum.missedP0 + item.missedP0 }), { expectedP0: 0, detectedP0: 0, missedP0: 0 })
    expect(totals).toEqual({ expectedP0: 6, detectedP0: 6, missedP0: 0 })
  })
})
