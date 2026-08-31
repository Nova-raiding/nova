import type {
  AssetPreviewPlannerInput,
  DeliveryBundleManifestInput,
  DeliveryBundleScope,
  DeliveryReviewFindingInput,
  DeliveryVariantManifestInput,
  DeliveryVariantPlan,
  DeliveryVariantPlanInput,
  VideoStoryboardQualityInput,
  VisualAuthenticityGateInput,
} from '../../packages/multimodal/src/index.js'

export type MultimodalGoldenScenario = {
  id: string
  name: string
  p0Expectation: string
  expectedRisk: boolean
}

export const MULTIMODAL_DELIVERY_GOLDEN_SCENARIOS = [
  { id: 'safe-image', name: '安全图片包', p0Expectation: 'P0 期望：全部本地与外部证据验证通过，交付包可发布且 hash 稳定。', expectedRisk: false },
  { id: 'safe-video', name: '安全视频分镜包', p0Expectation: 'P0 期望：分镜、权益、成片、OCR 和人审证据完整时可发布且 hash 稳定。', expectedRisk: false },
  { id: 'unverified-platform-spec', name: '未验证平台规格', p0Expectation: 'P0 期望：缺少 production canary 的平台规格不得进入 publishable 交付包。', expectedRisk: true },
  { id: 'visual-drift', name: '视觉漂移', p0Expectation: 'P0 期望：Logo/受保护区域漂移必须阻断交付。', expectedRisk: true },
  { id: 'asset-quarantine', name: '素材隔离', p0Expectation: 'P0 期望：quarantined 素材不生成预览任务且交付包不可发布。', expectedRisk: true },
  { id: 'video-rights-missing', name: '视频权益缺失', p0Expectation: 'P0 期望：未授权音频必须在分镜质量门禁阻断并传导到 manifest。', expectedRisk: true },
  { id: 'cross-tenant-scope', name: '跨租户 scope', p0Expectation: 'P0 期望：任意 workspace/task/product/brand 作用域不一致都不得构建 manifest。', expectedRisk: true },
  { id: 'manifest-tampering', name: 'manifest 篡改', p0Expectation: 'P0 期望：任何文件内容篡改必须被 verifyDeliveryBundle 检出。', expectedRisk: true },
] as const satisfies readonly MultimodalGoldenScenario[]

export const GOLDEN_SCOPE: DeliveryBundleScope = {
  workspaceId: 'ws_multimodal_golden', taskId: 'task_multimodal_golden', productId: 'product_multimodal_golden', brandId: 'brand_multimodal_golden',
}

export const goldenSha = (character: string) => character.repeat(64)

export const deliveryVariantFixture = (verified = true): DeliveryVariantPlanInput => ({
  platform: 'taobao', placement: 'detail-hero', devices: ['desktop'], productCount: 1,
  sourceAssets: [{ id: 'asset-golden', width: 1200, height: 1200, safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, productIds: [GOLDEN_SCOPE.productId] }],
  specifications: [{
    id: 'golden-desktop', device: 'desktop', width: 1200, height: 400,
    safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, formats: ['webp'], maxFileBytes: 2_000_000,
    evidence: verified
      ? { state: 'production_canary', reference: 'canary://golden/delivery', checkedAt: '2026-08-29T00:00:00Z' }
      : { state: 'official_document', reference: 'https://docs.example/taobao', checkedAt: '2026-08-29T00:00:00Z' },
  }],
  activity: { countdown: 'none' },
})

export const visualFixture = (drift = false): VisualAuthenticityGateInput => ({
  originalImage: { width: 1200, height: 1200, hash: goldenSha('a') },
  candidateImage: { width: 1200, height: 1200, hash: goldenSha('b') },
  protectedRegions: [{ id: 'logo', label: '品牌 Logo', kind: 'logo', rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }],
  editableRegions: [{ id: 'background', label: '背景', kind: 'background', rect: { x: 0.2, y: 0, width: 0.8, height: 1 } }],
  observedChanges: drift
    ? [{ id: 'logo-change', kind: 'logo', rect: { x: 0.05, y: 0.05, width: 0.1, height: 0.1 } }]
    : [{ id: 'background-change', kind: 'background', rect: { x: 0.2, y: 0, width: 0.8, height: 1 } }],
  ocr: { original: [{ text: 'BRAND', confidence: 0.99 }], candidate: [{ text: drift ? 'BRANO' : 'BRAND', confidence: 0.99 }] },
  protectedComparisons: { logo: { outcome: drift ? 'changed' : 'unchanged', confidence: 0.99 }, certificationMark: { outcome: 'not_applicable', confidence: 1 }, packagingText: { outcome: 'not_applicable', confidence: 1 } },
  productComparisons: { structure: { outcome: 'unchanged', confidence: 0.99 }, color: { outcome: 'unchanged', confidence: 0.99 }, material: { outcome: 'unchanged', confidence: 0.99 } },
  provenance: { source: 'asset:golden@r2', provider: 'golden-provider', model: 'golden-model' }, humanReview: { status: 'not_required' },
})

export const previewFixture = (scanStatus: AssetPreviewPlannerInput['scanStatus'] = 'clean'): AssetPreviewPlannerInput => ({
  workspaceId: GOLDEN_SCOPE.workspaceId, assetId: 'asset-golden', revision: 2, sourceSha256: goldenSha('c'),
  scanStatus, rightsStatus: 'approved', previewAllowed: true,
  declaredMimeType: 'image/png', detectedMimeType: 'image/png', extension: 'png', sizeBytes: 2048,
  image: { width: 1200, height: 1200 }, storageRef: { provider: 'opaque', key: `${GOLDEN_SCOPE.workspaceId}/source/asset-golden.png` },
})

const approvedRights = { status: 'approved' as const, evidenceRef: 'rights://golden', validUntil: '2027-01-01T00:00:00Z', platforms: ['douyin'] }

export const videoFixture = (rightsApproved = true): VideoStoryboardQualityInput => ({
  platform: 'douyin', reviewAt: '2026-08-29T12:00:00Z', durationSeconds: 15, aspectRatio: '9:16', resolution: { width: 1080, height: 1920 }, fps: 30,
  platformCapability: { state: 'production_canary', evidenceRef: 'canary://golden/video', specification: { durationsSeconds: [15], aspectRatios: ['9:16'], resolutions: [{ width: 1080, height: 1920 }], fps: [30], containers: ['mp4'], maxFileBytes: 20_000_000 } },
  scenes: [{
    id: 'scene-golden', startSeconds: 0, endSeconds: 15, visual: '真实商品展示', productIds: [GOLDEN_SCOPE.productId], skuIds: ['sku-golden'],
    claims: [{ id: 'claim-golden', kind: 'product_selling_point', text: '已确认材质', factSourceIds: ['fact-golden'], productIds: [GOLDEN_SCOPE.productId], skuIds: ['sku-golden'] }],
    audio: [{ id: 'music-golden', kind: 'music', rights: rightsApproved ? approvedRights : { status: 'denied' } }],
  }],
  cover: { assetId: 'cover-golden', productIds: [GOLDEN_SCOPE.productId], skuIds: ['sku-golden'], factSourceIds: ['fact-golden'], rights: approvedRights },
  output: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', fileBytes: 8_000_000 },
  completionEvidence: {
    rendering: { state: 'real_render_passed', artifactRef: 'artifact://golden/video', checksum: `sha256:${goldenSha('d')}`, rendererVersion: 'renderer-golden' },
    ocr: { state: 'passed', reportRef: 'ocr://golden/video' },
    humanReview: { state: 'approved', reviewRef: 'review://golden/video', actorId: 'reviewer-golden', reviewedAt: '2026-08-29T11:00:00Z' },
  }, provenance: 'model_generated',
})

export const findingsForManifest = (findings: readonly { code: string; path?: string; field?: string; severity?: string; status?: string; message: string }[]): DeliveryReviewFindingInput[] =>
  findings.map(item => ({
    code: item.code,
    field: item.path ?? item.field ?? 'upstream',
    status: item.severity === 'block' || item.severity === 'error' || item.status === 'block' ? 'blocked' : item.severity === 'warn' || item.status === 'warn' ? 'warning' : 'passed',
    message: item.message,
    evidenceSourceIds: ['fact-golden'],
  }))

export const bundleFixture = (input: {
  variantPlan: DeliveryVariantPlan
  reviewFindings?: readonly DeliveryReviewFindingInput[]
  preview?: { path: string; content: Uint8Array; blocked: boolean; externallyUnverified: boolean }
  scopeOverride?: Partial<DeliveryBundleScope>
}): DeliveryBundleManifestInput => {
  const scope = { ...GOLDEN_SCOPE, ...input.scopeOverride }
  const variant = input.variantPlan.variants[0]
  const variantFilePath = variant ? `variants/${variant.id}.webp` : 'variants/unavailable.webp'
  const deliveryVariants: DeliveryVariantManifestInput[] = variant ? [{
    id: variant.id, workspaceId: GOLDEN_SCOPE.workspaceId, taskId: GOLDEN_SCOPE.taskId, productId: GOLDEN_SCOPE.productId, brandId: GOLDEN_SCOPE.brandId,
    platform: variant.platform, placement: variant.placement, filePath: variantFilePath, externallyUnverified: input.variantPlan.externallyUnverified || !input.variantPlan.readyForProduction,
  }] : []
  return {
    scope,
    entities: {
      workspace: { id: GOLDEN_SCOPE.workspaceId, version: '1' },
      task: { id: GOLDEN_SCOPE.taskId, version: '1', workspaceId: GOLDEN_SCOPE.workspaceId, productId: GOLDEN_SCOPE.productId, brandId: GOLDEN_SCOPE.brandId },
      product: { id: GOLDEN_SCOPE.productId, version: '1', workspaceId: GOLDEN_SCOPE.workspaceId, brandId: GOLDEN_SCOPE.brandId },
      brand: { id: GOLDEN_SCOPE.brandId, version: '1', workspaceId: GOLDEN_SCOPE.workspaceId },
    },
    version: { contentVersionId: 'content-multimodal-golden', number: 1, state: 'approved', generatedAt: '2026-08-29T00:00:00Z', vector: { task: GOLDEN_SCOPE.taskId, input: 'snapshot-golden' } },
    factSources: [{ id: 'fact-golden', version: '1', sha256: goldenSha('e'), workspaceId: GOLDEN_SCOPE.workspaceId, productId: GOLDEN_SCOPE.productId, verified: true }],
    ruleVersions: [{ id: 'rule-golden', version: 'rule-golden-v1', sha256: goldenSha('f'), scope: 'global', verified: true }],
    contentFiles: [
      { path: 'README.md', mimeType: 'text/markdown', content: '# Multimodal golden delivery' },
      { path: 'content.md', mimeType: 'text/markdown', content: '# Golden content' },
      { path: 'content.json', mimeType: 'application/json', content: '{"golden":true}' },
      ...(variant ? [{ path: variantFilePath, mimeType: 'image/webp', content: new Uint8Array([11, 12, 13]) }] : []),
    ],
    deliveryVariants,
    assetPreviews: input.preview ? [{
      assetId: 'asset-golden', workspaceId: GOLDEN_SCOPE.workspaceId, sourceSha256: goldenSha('c'), sourceRevision: 2,
      file: { path: input.preview.path, mimeType: 'image/webp', content: input.preview.content }, blocked: input.preview.blocked, externallyUnverified: input.preview.externallyUnverified,
    }] : [],
    reviewFindings: input.reviewFindings ?? [], reviewWaivers: [],
    sourceMap: [{ outputPath: 'content.json', field: 'golden', factSourceIds: ['fact-golden'], ruleVersionIds: ['rule-golden-v1'] }],
  }
}
