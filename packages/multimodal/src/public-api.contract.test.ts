import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildDeliveryBundleManifest,
  evaluateVideoStoryboardQuality,
  evaluateVisualAuthenticity,
  planAssetPreviews,
  planDeliveryVariants,
  type AssetPreviewPlannerInput,
  type DeliveryBundleManifestInput,
  type DeliveryVariantPlanInput,
  type VideoStoryboardQualityInput,
  type VisualAuthenticityGateInput,
} from './index.js'

const sha = (character: string) => character.repeat(64)

describe('multimodal public API contract', () => {
  it('exposes and minimally executes all five launch-gate capabilities from index', () => {
    const visualInput: VisualAuthenticityGateInput = {
      originalImage: { width: 100, height: 100, hash: sha('a') },
      candidateImage: { width: 100, height: 100, hash: sha('b') },
      protectedRegions: [], editableRegions: [], observedChanges: [],
      ocr: { original: [], candidate: [] },
      protectedComparisons: {
        logo: { outcome: 'not_applicable', confidence: 1 },
        certificationMark: { outcome: 'not_applicable', confidence: 1 },
        packagingText: { outcome: 'not_applicable', confidence: 1 },
      },
      productComparisons: {
        structure: { outcome: 'unchanged', confidence: 1 },
        color: { outcome: 'unchanged', confidence: 1 },
        material: { outcome: 'unchanged', confidence: 1 },
      },
      provenance: { source: 'asset:source@r1', provider: 'contract-provider', model: 'contract-model' },
      humanReview: { status: 'not_required' },
    }
    expect(evaluateVisualAuthenticity(visualInput)).toMatchObject({ status: 'pass', publishable: true })

    const previewInput: AssetPreviewPlannerInput = {
      workspaceId: 'ws_contract', assetId: 'asset_contract', revision: 1, sourceSha256: sha('c'),
      scanStatus: 'clean', rightsStatus: 'approved', previewAllowed: true,
      declaredMimeType: 'image/png', detectedMimeType: 'image/png', extension: 'png', sizeBytes: 4,
      image: { width: 1, height: 1 }, storageRef: { provider: 'opaque', key: 'ws_contract/source/image.png' },
    }
    expect(planAssetPreviews(previewInput)).toMatchObject({ status: 'ready', jobs: expect.any(Array) })

    const variantInput: DeliveryVariantPlanInput = {
      platform: 'taobao', placement: 'detail-hero', devices: ['desktop'], productCount: 1,
      sourceAssets: [{ id: 'asset_contract', width: 100, height: 100, safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }],
      specifications: [{
        id: 'contract-spec', device: 'desktop', width: 100, height: 100,
        safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, formats: ['webp'], maxFileBytes: 1_000,
        evidence: { state: 'production_canary', reference: 'canary://contract/delivery' },
      }],
      activity: { countdown: 'none' },
    }
    expect(planDeliveryVariants(variantInput)).toMatchObject({ readyForLocalPreview: true, readyForProduction: true })

    const rights = { status: 'approved' as const, evidenceRef: 'rights://contract', validUntil: '2027-01-01T00:00:00Z', platforms: ['douyin'] }
    const videoInput: VideoStoryboardQualityInput = {
      platform: 'douyin', reviewAt: '2026-08-29T12:00:00Z', durationSeconds: 1, aspectRatio: '1:1', resolution: { width: 100, height: 100 }, fps: 25,
      platformCapability: { state: 'production_canary', evidenceRef: 'canary://contract/video', specification: { durationsSeconds: [1], aspectRatios: ['1:1'], resolutions: [{ width: 100, height: 100 }], fps: [25], containers: ['mp4'], maxFileBytes: 1_000 } },
      scenes: [{ id: 'scene-1', startSeconds: 0, endSeconds: 1, visual: '真实商品', productIds: ['product-contract'], skuIds: ['sku-contract'], claims: [] }],
      cover: { assetId: 'cover-contract', productIds: ['product-contract'], skuIds: ['sku-contract'], factSourceIds: ['fact-contract'], rights },
      output: { container: 'mp4', videoCodec: 'h264', fileBytes: 100 },
      completionEvidence: {
        rendering: { state: 'real_render_passed', artifactRef: 'artifact://contract', checksum: `sha256:${sha('d')}`, rendererVersion: 'renderer-contract' },
        ocr: { state: 'passed', reportRef: 'ocr://contract' },
        humanReview: { state: 'approved', reviewRef: 'review://contract', actorId: 'reviewer-contract', reviewedAt: '2026-08-29T11:00:00Z' },
      },
      provenance: 'manual',
    }
    expect(evaluateVideoStoryboardQuality(videoInput)).toMatchObject({ storyboardValid: true, publishable: true })

    const bundleInput: DeliveryBundleManifestInput = {
      scope: { workspaceId: 'ws_contract', taskId: 'task_contract', productId: 'product-contract', brandId: 'brand-contract' },
      entities: {
        workspace: { id: 'ws_contract', version: '1' },
        task: { id: 'task_contract', version: '1', workspaceId: 'ws_contract', productId: 'product-contract', brandId: 'brand-contract' },
        product: { id: 'product-contract', version: '1', workspaceId: 'ws_contract', brandId: 'brand-contract' },
        brand: { id: 'brand-contract', version: '1', workspaceId: 'ws_contract' },
      },
      version: { contentVersionId: 'content-contract', number: 1, state: 'approved', generatedAt: '2026-08-29T00:00:00Z', vector: { input: 'snapshot-contract' } },
      factSources: [{ id: 'fact-contract', version: '1', sha256: sha('e'), workspaceId: 'ws_contract', productId: 'product-contract', verified: true }],
      ruleVersions: [{ id: 'rule-contract', version: '1', sha256: sha('f'), scope: 'global', verified: true }],
      contentFiles: [
        { path: 'README.md', mimeType: 'text/markdown', content: '# Contract' },
        { path: 'content.md', mimeType: 'text/markdown', content: '# Content' },
        { path: 'content.json', mimeType: 'application/json', content: '{}' },
      ],
      deliveryVariants: [], assetPreviews: [], reviewFindings: [], reviewWaivers: [],
      sourceMap: [{ outputPath: 'content.json', field: 'title', factSourceIds: ['fact-contract'], ruleVersionIds: ['rule-contract'] }],
    }
    expect(buildDeliveryBundleManifest(bundleInput)).toMatchObject({ ok: true, manifest: { publishable: true } })
  })

  it('keeps the five public modules free of barrel-import cycles', () => {
    const modules = [
      'visual-authenticity-gate',
      'asset-preview-planner',
      'delivery-variant-planner',
      'video-storyboard-quality',
      'delivery-bundle-manifest',
    ] as const
    const graph = new Map<string, string[]>()
    for (const moduleName of modules) {
      const source = readFileSync(new URL(`./${moduleName}.ts`, import.meta.url), 'utf8')
      expect(source, `${moduleName} must not import the public barrel`).not.toMatch(/from\s+['"]\.\/index(?:\.js)?['"]/u)
      const dependencies = [...source.matchAll(/from\s+['"]\.\/([^'"]+?)(?:\.js)?['"]/gu)]
        .map(match => match[1]!)
        .filter(dependency => (modules as readonly string[]).includes(dependency))
      graph.set(moduleName, dependencies)
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (moduleName: string) => {
      if (visiting.has(moduleName)) throw new Error(`Circular multimodal dependency: ${[...visiting, moduleName].join(' -> ')}`)
      if (visited.has(moduleName)) return
      visiting.add(moduleName)
      for (const dependency of graph.get(moduleName) ?? []) visit(dependency)
      visiting.delete(moduleName)
      visited.add(moduleName)
    }
    for (const moduleName of modules) visit(moduleName)
    expect(visited.size).toBe(modules.length)
  })
})
