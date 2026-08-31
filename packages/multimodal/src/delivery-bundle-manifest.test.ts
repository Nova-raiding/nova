import { describe, expect, it } from 'vitest'
import {
  buildDeliveryBundleManifest,
  canonicalJson,
  verifyDeliveryBundle,
  type DeliveryBundleManifestInput,
} from './delivery-bundle-manifest.js'

const hash = (character: string) => character.repeat(64)
const webp = (...payload: number[]) => new Uint8Array([82, 73, 70, 70, 8 + payload.length, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, ...payload])

const baseInput = (overrides: Partial<DeliveryBundleManifestInput> = {}): DeliveryBundleManifestInput => ({
  scope: { workspaceId: 'ws_delivery', taskId: 'task_17', productId: 'product_17', brandId: 'brand_17' },
  entities: {
    workspace: { id: 'ws_delivery', version: '7' },
    task: { id: 'task_17', version: '4', workspaceId: 'ws_delivery', productId: 'product_17', brandId: 'brand_17' },
    product: { id: 'product_17', version: '3', workspaceId: 'ws_delivery', brandId: 'brand_17' },
    brand: { id: 'brand_17', version: '2', workspaceId: 'ws_delivery' },
  },
  version: { contentVersionId: 'content_17', number: 5, state: 'approved', generatedAt: '2026-08-29T08:00:00+08:00', vector: { model: 'model-v2', inputSnapshot: 'snapshot-v4', rules: ['rule-cn-v1'] } },
  factSources: [{ id: 'fact-product-17', version: 'v3', sha256: hash('a'), workspaceId: 'ws_delivery', productId: 'product_17', verified: true }],
  ruleVersions: [{ id: 'rule-cn', version: 'rule-cn-v1', sha256: hash('b'), scope: 'global', verified: true }],
  contentFiles: [
    { path: 'README.md', mimeType: 'text/markdown; charset=utf-8', content: '# 交付说明' },
    { path: 'content.md', mimeType: 'text/markdown; charset=utf-8', content: '# 已审核商品详情' },
    { path: 'content.json', mimeType: 'application/json; charset=utf-8', content: '{"title":"已审核商品详情"}' },
    { path: 'variants/taobao-desktop.webp', mimeType: 'image/webp', content: webp(1, 2, 3, 4) },
  ],
  deliveryVariants: [{ id: 'variant-desktop', workspaceId: 'ws_delivery', taskId: 'task_17', productId: 'product_17', brandId: 'brand_17', platform: 'taobao', placement: 'detail-hero', filePath: 'variants/taobao-desktop.webp', externallyUnverified: false }],
  assetPreviews: [{ assetId: 'asset-17', workspaceId: 'ws_delivery', sourceSha256: hash('c'), sourceRevision: 2, file: { path: 'previews/asset-17-320.webp', mimeType: 'image/webp', content: webp(5, 6, 7) }, blocked: false, externallyUnverified: false }],
  reviewFindings: [{ code: 'AUTHENTICITY_EVIDENCE_COMPLETE', field: 'visual', status: 'passed', message: '视觉证据完整', evidenceSourceIds: ['fact-product-17'] }],
  reviewWaivers: [],
  sourceMap: [{ outputPath: 'content.json', field: 'title', factSourceIds: ['fact-product-17'], ruleVersionIds: ['rule-cn-v1'] }],
  ...overrides,
})

const built = (input = baseInput()) => {
  const result = buildDeliveryBundleManifest(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result
}

describe('deterministic delivery bundle manifest builder', () => {
  it('builds the PRD manifest, review findings, source map and previews structure', () => {
    const result = built()
    expect(result.manifest).toMatchObject({
      schemaVersion: '1.0', generatedAt: '2026-08-29T00:00:00.000Z', publishable: true,
      scope: { workspaceId: 'ws_delivery', taskId: 'task_17', productId: 'product_17', brandId: 'brand_17' },
      review: { findingsFile: 'review-findings.json' }, sourceMap: { file: 'source-map.json' },
      assetPreviews: [expect.objectContaining({ assetId: 'asset-17', filePath: 'previews/asset-17-320.webp' })],
    })
    expect(result.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'manifest.json', 'review-findings.json', 'source-map.json', 'README.md', 'content.md', 'content.json', 'previews/asset-17-320.webp',
    ]))
    expect(result.manifest.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256) && file.sizeBytes > 0 && file.mimeType.includes('/'))).toBe(true)
    expect(result.manifest.files.some(file => file.path === 'manifest.json')).toBe(false)
  })

  it('omits publish receipt when unpublished and includes only a verified published receipt', () => {
    const unpublished = built()
    expect(unpublished.manifest).not.toHaveProperty('publishReceipt')
    expect(unpublished.files.map(file => file.path)).not.toContain('publish-receipt.json')

    const published = built(baseInput({ publishReceipt: {
      workspaceId: 'ws_delivery', taskId: 'task_17', productId: 'product_17', contentVersionId: 'content_17',
      status: 'published', platform: 'taobao', requestId: 'request-17', remoteProductId: 'TB-17', observedAt: '2026-08-29T09:00:00+08:00', verified: true,
    } }))
    expect(published.manifest.publishReceipt).toMatchObject({ file: 'publish-receipt.json', status: 'published', requestId: 'request-17' })
    expect(published.files.map(file => file.path)).toContain('publish-receipt.json')
  })

  it('produces stable canonical JSON and hash for the same input and freezes the version vector', () => {
    const first = built()
    const second = built()
    expect(second.canonicalJson).toBe(first.canonicalJson)
    expect(second.manifestHash).toBe(first.manifestHash)
    expect(canonicalJson(first.manifest)).toBe(first.canonicalJson)
    expect(Object.isFrozen(first.manifest)).toBe(true)
    expect(Object.isFrozen(first.manifest.version.vector)).toBe(true)
    expect(() => { (first.manifest.version.vector as { model?: string }).model = 'tampered' }).toThrow()
  })

  it('marks blocked findings, blocked previews and externally unverified evidence non-publishable', () => {
    const blocked = built(baseInput({ reviewFindings: [{ code: 'LOGO_DRIFT', field: 'visual.logo', status: 'blocked', message: 'Logo 漂移', evidenceSourceIds: ['fact-product-17'] }] }))
    expect(blocked.manifest.publishable).toBe(false)

    const unverified = built(baseInput({ ruleVersions: [{ id: 'rule-cn', version: 'rule-cn-v1', sha256: hash('b'), scope: 'global', verified: false }] }))
    expect(unverified.manifest.publishable).toBe(false)
    expect(unverified.manifest.externallyUnverified).toContain('rule:rule-cn@rule-cn-v1')

    const preview = baseInput().assetPreviews[0]!
    const blockedPreview = built(baseInput({ assetPreviews: [{ ...preview, blocked: true }] }))
    expect(blockedPreview.manifest.publishable).toBe(false)
  })

  it.each([
    ['workspace', { entities: { ...baseInput().entities, workspace: { id: 'ws_other', version: '1' } } }],
    ['task', { entities: { ...baseInput().entities, task: { ...baseInput().entities.task, productId: 'product_other' } } }],
    ['product', { entities: { ...baseInput().entities, product: { ...baseInput().entities.product, brandId: 'brand_other' } } }],
    ['brand', { entities: { ...baseInput().entities, brand: { ...baseInput().entities.brand, workspaceId: 'ws_other' } } }],
  ] as const)('hard-blocks %s scope mismatch', (_name, override) => {
    const result = buildDeliveryBundleManifest(baseInput(override))
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SCOPE_MISMATCH' })]) })
  })

  it('rejects relative-path traversal, reserved names and case-insensitive conflicts', () => {
    const traversal = buildDeliveryBundleManifest(baseInput({ contentFiles: [{ path: 'previews/%2e%2e/secret.txt', mimeType: 'text/plain', content: 'x' }] }))
    expect(traversal).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PATH_INVALID' })]) })

    const reserved = buildDeliveryBundleManifest(baseInput({ contentFiles: [{ path: 'manifest.json', mimeType: 'application/json', content: '{}' }] }))
    expect(reserved).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PATH_CONFLICT' })]) })

    const conflict = buildDeliveryBundleManifest(baseInput({ contentFiles: [
      { path: 'Content.json', mimeType: 'application/json', content: '{}' },
      { path: 'content.json', mimeType: 'application/json', content: '{}' },
    ] }))
    expect(conflict).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PATH_CONFLICT' })]) })
  })

  it('rejects tokens, signed storage credentials and sensitive object keys', () => {
    const bearer = buildDeliveryBundleManifest(baseInput({ contentFiles: [{ path: 'content.md', mimeType: 'text/markdown', content: 'Authorization: Bearer abc.def.ghi' }] }))
    expect(bearer).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SENSITIVE_DATA_FORBIDDEN' })]) })

    const credentialInput = { ...baseInput(), storageCredential: 'vault://storage/private' } as DeliveryBundleManifestInput
    const credential = buildDeliveryBundleManifest(credentialInput)
    expect(credential).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SENSITIVE_DATA_FORBIDDEN' })]) })
  })

  it('rejects unverified, unpublished or cross-scope receipt claims', () => {
    const receipt = {
      workspaceId: 'ws_other', taskId: 'task_17', productId: 'product_17', contentVersionId: 'content_17',
      status: 'submitted', platform: 'taobao', requestId: 'request-17', remoteProductId: 'TB-17', observedAt: 'bad-date', verified: false,
    }
    const result = buildDeliveryBundleManifest(baseInput({ publishReceipt: receipt as never }))
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PUBLISH_RECEIPT_INVALID' })]) })
  })

  it('detects manifest and content tampering', () => {
    const result = built()
    expect(verifyDeliveryBundle(result.manifest, result.files, result.manifestHash)).toEqual({ valid: true, errors: [] })

    const tamperedFiles = result.files.map(file => file.path === 'content.json' ? { ...file, content: '{"title":"tampered"}' } : file)
    const contentCheck = verifyDeliveryBundle(result.manifest, tamperedFiles, result.manifestHash)
    expect(contentCheck.valid).toBe(false)
    expect(contentCheck.errors).toContainEqual(expect.objectContaining({ code: 'FILE_HASH_MISMATCH', path: 'content.json' }))

    const manifestCheck = verifyDeliveryBundle(result.manifest, result.files, hash('f'))
    expect(manifestCheck.errors).toContainEqual(expect.objectContaining({ code: 'MANIFEST_HASH_MISMATCH', path: 'manifest.json' }))
  })

  it('rejects a blocked finding waiver and missing variant file reference', () => {
    const waiver = buildDeliveryBundleManifest(baseInput({
      reviewFindings: [{ code: 'LOGO_DRIFT', field: 'visual.logo', status: 'blocked', message: 'blocked', evidenceSourceIds: ['fact-product-17'] }],
      reviewWaivers: [{ findingCode: 'LOGO_DRIFT', findingField: 'visual.logo', reason: '强行放行', actorId: 'operator', waivedAt: '2026-08-29T00:00:00Z' }],
    }))
    expect(waiver).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'WAIVER_INVALID' })]) })

    const missing = buildDeliveryBundleManifest(baseInput({ deliveryVariants: [{ ...baseInput().deliveryVariants[0]!, filePath: 'variants/missing.webp' }] }))
    expect(missing).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'FILE_REFERENCE_MISSING' })]) })
  })

  it('rejects double-encoded traversal, Unicode case-fold conflicts and reserved aliases', () => {
    const traversal = buildDeliveryBundleManifest(baseInput({ contentFiles: [{ path: 'x/%252e%252e/secret.md', mimeType: 'text/markdown', content: 'x' }] }))
    expect(traversal).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PATH_INVALID' })]) })

    const unicode = buildDeliveryBundleManifest(baseInput({ contentFiles: [
      { path: 'Ｋey.md', mimeType: 'text/markdown', content: 'a' },
      { path: 'key.md', mimeType: 'text/markdown', content: 'b' },
    ] }))
    expect(unicode).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PATH_CONFLICT' })]) })

    const reserved = buildDeliveryBundleManifest(baseInput({ contentFiles: [{ path: 'Ｍanifest.json', mimeType: 'application/json', content: '{}' }] }))
    expect(reserved).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'PATH_CONFLICT' })]) })
  })

  it('rejects MIME magic spoofing and obfuscated secret keys/values', () => {
    const spoofed = buildDeliveryBundleManifest(baseInput({ contentFiles: [
      ...baseInput().contentFiles.slice(0, 3),
      { path: 'variants/fake.webp', mimeType: 'image/webp', content: new Uint8Array([1, 2, 3]) },
    ] }))
    expect(spoofed).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'FILE_INVALID' })]) })

    const obfuscated = { ...baseInput(), audit: { ['api\u200b_key']: 'not-for-delivery' }, note: 'B e a r e r abc.def.ghi' } as unknown as DeliveryBundleManifestInput
    expect(buildDeliveryBundleManifest(obfuscated)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SENSITIVE_DATA_FORBIDDEN' })]) })
  })

  it('fails closed for cyclic/prototype-polluted metadata, scope ambiguity and collection bombs', () => {
    const cyclic: Record<string, unknown> = { version: 1 }
    cyclic.self = cyclic
    const cycleResult = buildDeliveryBundleManifest(baseInput({ version: { ...baseInput().version, vector: cyclic } }))
    expect(cycleResult).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'VERSION_INVALID' })]) })
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/u)

    const globalScope = buildDeliveryBundleManifest(baseInput({ ruleVersions: [{ ...baseInput().ruleVersions[0]!, workspaceId: 'ws_delivery' }] }))
    expect(globalScope).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_INVALID' })]) })

    const pollutedScope = Object.create(baseInput().scope) as DeliveryBundleManifestInput['scope']
    const polluted = buildDeliveryBundleManifest(baseInput({ scope: pollutedScope }))
    expect(polluted).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'SCOPE_MISMATCH' })]) })

    const bomb = buildDeliveryBundleManifest(baseInput({ reviewFindings: Array.from({ length: 1_001 }, () => baseInput().reviewFindings[0]!) }))
    expect(bomb).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'FILE_INVALID' })]) })
  })

  it('defensively copies input bytes and fails closed if returned TypedArray bytes mutate', () => {
    const input = baseInput()
    const sourceBytes = input.contentFiles[3]!.content as Uint8Array
    const result = built(input)
    sourceBytes[12] = 99
    expect(verifyDeliveryBundle(result.manifest, result.files, result.manifestHash).valid).toBe(true)
    expect(Object.isFrozen(result.files)).toBe(true)

    const returned = result.files.find(file => file.path === 'variants/taobao-desktop.webp')!.content as Uint8Array
    returned[12] = 88
    expect(verifyDeliveryBundle(result.manifest, result.files, result.manifestHash).errors).toContainEqual(expect.objectContaining({ code: 'FILE_HASH_MISMATCH' }))
  })
})
