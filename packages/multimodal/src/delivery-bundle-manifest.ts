import { createHash } from 'node:crypto'

export interface DeliveryBundleScope {
  readonly workspaceId: string
  readonly taskId: string
  readonly productId: string
  readonly brandId: string
}

export interface DeliveryBundleEntities {
  readonly workspace: { readonly id: string; readonly version: string }
  readonly task: { readonly id: string; readonly version: string; readonly workspaceId: string; readonly productId: string; readonly brandId: string }
  readonly product: { readonly id: string; readonly version: string; readonly workspaceId: string; readonly brandId: string }
  readonly brand: { readonly id: string; readonly version: string; readonly workspaceId: string }
}

export interface DeliveryBundleVersion {
  readonly contentVersionId: string
  readonly number: number
  readonly state: string
  readonly generatedAt: string
  readonly vector: Readonly<Record<string, unknown>>
}

export interface DeliveryFactSource {
  readonly id: string
  readonly version: string
  readonly sha256: string
  readonly workspaceId: string
  readonly productId: string
  readonly verified: boolean
}

export interface DeliveryRuleVersion {
  readonly id: string
  readonly version: string
  readonly sha256: string
  readonly scope: 'global' | 'workspace'
  readonly workspaceId?: string
  readonly verified: boolean
}

export interface DeliveryBundleFileInput {
  readonly path: string
  readonly mimeType: string
  readonly content: string | Uint8Array
  readonly externallyUnverified?: boolean
}

export interface DeliveryVariantManifestInput {
  readonly id: string
  readonly workspaceId: string
  readonly taskId: string
  readonly productId: string
  readonly brandId: string
  readonly platform: string
  readonly placement: string
  readonly filePath: string
  readonly externallyUnverified: boolean
}

export interface AssetPreviewManifestInput {
  readonly assetId: string
  readonly workspaceId: string
  readonly sourceSha256: string
  readonly sourceRevision: number
  readonly file: DeliveryBundleFileInput
  readonly blocked: boolean
  readonly externallyUnverified: boolean
}

export interface DeliveryReviewFindingInput {
  readonly code: string
  readonly field: string
  readonly status: 'passed' | 'warning' | 'blocked'
  readonly message: string
  readonly evidenceSourceIds: readonly string[]
}

export interface DeliveryReviewWaiverInput {
  readonly findingCode: string
  readonly findingField: string
  readonly reason: string
  readonly actorId: string
  readonly waivedAt: string
}

export interface DeliverySourceMapEntryInput {
  readonly outputPath: string
  readonly field: string
  readonly factSourceIds: readonly string[]
  readonly ruleVersionIds: readonly string[]
}

export interface DeliveryPublishReceiptInput {
  readonly workspaceId: string
  readonly taskId: string
  readonly productId: string
  readonly contentVersionId: string
  readonly status: 'published'
  readonly platform: string
  readonly requestId: string
  readonly remoteProductId: string
  readonly observedAt: string
  readonly verified: true
}

export interface DeliveryBundleManifestInput {
  readonly scope: DeliveryBundleScope
  readonly entities: DeliveryBundleEntities
  readonly version: DeliveryBundleVersion
  readonly factSources: readonly DeliveryFactSource[]
  readonly ruleVersions: readonly DeliveryRuleVersion[]
  readonly contentFiles: readonly DeliveryBundleFileInput[]
  readonly deliveryVariants: readonly DeliveryVariantManifestInput[]
  readonly assetPreviews: readonly AssetPreviewManifestInput[]
  readonly reviewFindings: readonly DeliveryReviewFindingInput[]
  readonly reviewWaivers: readonly DeliveryReviewWaiverInput[]
  readonly sourceMap: readonly DeliverySourceMapEntryInput[]
  /** Omit when no verified published receipt exists. */
  readonly publishReceipt?: DeliveryPublishReceiptInput
}

export interface DeliveryManifestFile {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly mimeType: string
}

export interface DeliveryBundleManifest {
  readonly schemaVersion: '1.0'
  readonly generatedAt: string
  readonly scope: DeliveryBundleScope
  readonly entities: DeliveryBundleEntities
  readonly version: DeliveryBundleVersion
  readonly factSources: readonly Omit<DeliveryFactSource, 'workspaceId' | 'productId'>[]
  readonly ruleVersions: readonly DeliveryRuleVersion[]
  readonly files: readonly DeliveryManifestFile[]
  readonly deliveryVariants: readonly Omit<DeliveryVariantManifestInput, 'workspaceId' | 'taskId' | 'productId' | 'brandId'>[]
  readonly assetPreviews: readonly (Omit<AssetPreviewManifestInput, 'workspaceId' | 'file'> & { readonly filePath: string })[]
  readonly review: {
    readonly findingsFile: 'review-findings.json'
    readonly findings: readonly DeliveryReviewFindingInput[]
    readonly waivers: readonly DeliveryReviewWaiverInput[]
  }
  readonly sourceMap: { readonly file: 'source-map.json'; readonly entries: readonly DeliverySourceMapEntryInput[] }
  readonly publishReceipt?: { readonly file: 'publish-receipt.json'; readonly status: 'published'; readonly platform: string; readonly requestId: string; readonly remoteProductId: string; readonly observedAt: string }
  readonly publishable: boolean
  readonly externallyUnverified: readonly string[]
}

export interface DeliveryBundleFile {
  readonly path: string
  readonly mimeType: string
  readonly content: string | Uint8Array
}

export type DeliveryBundleBuildErrorCode =
  | 'SCOPE_MISMATCH'
  | 'VERSION_INVALID'
  | 'SOURCE_INVALID'
  | 'PATH_INVALID'
  | 'PATH_CONFLICT'
  | 'FILE_INVALID'
  | 'FILE_REFERENCE_MISSING'
  | 'SENSITIVE_DATA_FORBIDDEN'
  | 'WAIVER_INVALID'
  | 'PUBLISH_RECEIPT_INVALID'

export interface DeliveryBundleBuildError {
  readonly code: DeliveryBundleBuildErrorCode
  readonly path: string
  readonly message: string
}

export type DeliveryBundleBuildResult =
  | { readonly ok: false; readonly errors: readonly DeliveryBundleBuildError[] }
  | {
      readonly ok: true
      readonly manifest: DeliveryBundleManifest
      readonly canonicalJson: string
      readonly manifestHash: string
      readonly files: readonly DeliveryBundleFile[]
    }

export interface DeliveryBundleVerificationResult {
  readonly valid: boolean
  readonly errors: readonly { code: 'MANIFEST_HASH_MISMATCH' | 'MANIFEST_CONTENT_MISMATCH' | 'FILE_MISSING' | 'FILE_HASH_MISMATCH' | 'FILE_SIZE_MISMATCH' | 'FILE_MIME_MISMATCH' | 'UNEXPECTED_FILE'; path: string; message: string }[]
}

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/iu
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9_-]+)?$/iu
const RESERVED_PATHS = new Set(['manifest.json', 'review-findings.json', 'source-map.json', 'publish-receipt.json'])
const RESERVED_PATH_KEYS = new Set([...RESERVED_PATHS].map(value => value.normalize('NFKC').toLocaleLowerCase('und')))
const SENSITIVE_KEY = /(?:^|_)(?:access_?token|refresh_?token|password|secret|credential|authorization|cookie|storage_?(?:ref|key|credential)|api_?key)(?:$|_)/iu
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bvault:\/\/|\bAKIA[0-9A-Z]{16}\b|[?&](?:x-amz-signature|signature|token|secret|credential)=)/iu
const MAX_COLLECTION_ITEMS = 1_000
const MAX_STRING_LENGTH = 1_000_000
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 500 * 1024 * 1024
const MAX_CANONICAL_DEPTH = 100
const MAX_CANONICAL_NODES = 100_000
const MAX_CANONICAL_CHARS = 10_000_000
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const bytes = (value: string | Uint8Array) => typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
const normalizeSha = (value: string) => value.replace(/^sha256:/iu, '').toLowerCase()

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalValue(value: unknown, seen: WeakSet<object>, state: { nodes: number; chars: number }, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH || ++state.nodes > MAX_CANONICAL_NODES) throw new TypeError('Canonical JSON input exceeds complexity limits')
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers')
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) throw new TypeError('Canonical JSON string exceeds size limit')
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('Canonical JSON does not support undefined')
    state.chars += encoded.length
    if (state.chars > MAX_CANONICAL_CHARS) throw new TypeError('Canonical JSON exceeds size limit')
    return encoded
  }
  if (seen.has(value)) throw new TypeError('Canonical JSON does not support cyclic objects')
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) throw new TypeError('Canonical JSON array exceeds size limit')
    const result = `[${value.map(item => canonicalValue(item, seen, state, depth + 1)).join(',')}]`
    seen.delete(value)
    return result
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON requires plain objects')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => 'get' in descriptor || 'set' in descriptor)) throw new TypeError('Canonical JSON does not support accessors')
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  if (entries.length > MAX_COLLECTION_ITEMS || entries.some(([key]) => key.length > MAX_STRING_LENGTH || FORBIDDEN_KEYS.has(key))) throw new TypeError('Canonical JSON object is unsafe or too large')
  state.chars += entries.reduce((sum, [key]) => sum + key.length + 4, 0)
  if (state.chars > MAX_CANONICAL_CHARS) throw new TypeError('Canonical JSON exceeds size limit')
  const result = `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item, seen, state, depth + 1)}`).join(',')}}`
  seen.delete(value)
  return result
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new WeakSet<object>(), { nodes: 0, chars: 0 }, 0)
}

const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T
const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  // Node rejects Object.freeze on non-empty typed-array views. Bundle bytes
  // are already defensively copied; the manifest and version vector remain
  // recursively frozen.
  if (ArrayBuffer.isView(value)) return value
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  }
  return value
}

const error = (code: DeliveryBundleBuildErrorCode, path: string, message: string): DeliveryBundleBuildError => ({ code, path, message })

const validId = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200

const safePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 1_024 || value !== value.normalize('NFC') || value.startsWith('/') || value.includes('\\') || /[%\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069]/u.test(value)) return false
  let decoded = value
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch { return false }
  return !decoded.startsWith('/') && decoded.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

const secretCandidateChunk = (value: string) => {
  const normalized = value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069]/gu, '')
  const compact = normalized.replace(/[\s._:-]+/gu, '')
  return SENSITIVE_VALUE.test(normalized) || /(?:authorization|bearer|accesstoken|refreshtoken|apikey|password|vault:\/\/|xamzsignature)/iu.test(compact)
}

const secretCandidates = (value: string) => {
  const chunkSize = 65_536
  const overlap = 512
  if (value.length <= chunkSize) return secretCandidateChunk(value)
  for (let offset = 0; offset < value.length; offset += chunkSize - overlap) {
    if (secretCandidateChunk(value.slice(offset, offset + chunkSize))) return true
  }
  return false
}

const sensitiveKey = (value: string) => {
  const compact = value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\s._:-]+/gu, '').toLowerCase()
  return SENSITIVE_KEY.test(value) || /^(?:accesstoken|refreshtoken|password|secret|credential|authorization|cookie|storageref|storagekey|storagecredential|apikey)$/u.test(compact)
}

const sensitivePaths = (value: unknown, path = '', seen = new WeakSet<object>()): string[] => {
  if (typeof value === 'string') return secretCandidates(value) ? [path] : []
  if (value instanceof Uint8Array) {
    const decoder = new TextDecoder()
    for (let offset = 0; offset < value.byteLength; offset += 65_024) {
      if (secretCandidates(decoder.decode(value.slice(offset, Math.min(value.byteLength, offset + 65_536))))) return [path]
    }
    return []
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return [path]
    seen.add(value)
    return value.slice(0, MAX_COLLECTION_ITEMS + 1).flatMap((item, index) => sensitivePaths(item, `${path}[${index}]`, seen))
  }
  if (!value || typeof value !== 'object') return []
  if (seen.has(value)) return [path]
  seen.add(value)
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(sensitiveKey(key) ? [`${path}.${key}`] : []),
    ...sensitivePaths(item, path ? `${path}.${key}` : key, seen),
  ])
}

const canonicalPathKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase('und').replace(/ß/gu, 'ss')

const contentMatchesMime = (file: DeliveryBundleFileInput, structuredMediaReference: boolean) => {
  const mime = file.mimeType.toLowerCase().split(';', 1)[0]
  const body = bytes(file.content)
  const path = typeof file.path === 'string' ? file.path.toLowerCase() : ''
  // Delivery variants and previews cross this boundary only after their
  // renderer/preview worker has validated the artifact. Preserve those opaque
  // bytes and verify their declared type by extension; unreferenced media must
  // still prove its type from magic bytes before it can enter the bundle.
  if (structuredMediaReference) {
    if (mime === 'image/png') return path.endsWith('.png')
    if (mime === 'image/jpeg') return path.endsWith('.jpg') || path.endsWith('.jpeg')
    if (mime === 'image/webp') return path.endsWith('.webp')
    if (mime === 'application/pdf') return path.endsWith('.pdf')
  }
  if (mime === 'image/png') return body.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => body[index] === value)
  if (mime === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
  if (mime === 'image/webp') {
    if (body.length < 16 || new TextDecoder('ascii').decode(body.slice(0, 4)) !== 'RIFF' || new TextDecoder('ascii').decode(body.slice(8, 12)) !== 'WEBP') return false
    return ['VP8 ', 'VP8L', 'VP8X'].includes(new TextDecoder('ascii').decode(body.slice(12, 16)))
  }
  if (mime === 'application/pdf') return body.length >= 5 && new TextDecoder('ascii').decode(body.slice(0, 5)) === '%PDF-'
  if (path.endsWith('.json')) {
    if (mime !== 'application/json') return false
    try { JSON.parse(new TextDecoder().decode(body)); return true } catch { return false }
  }
  if (path.endsWith('.md')) return mime === 'text/markdown'
  return true
}

const metadata = (file: DeliveryBundleFile): DeliveryManifestFile => {
  const body = bytes(file.content)
  return { path: file.path, sha256: sha256(body), sizeBytes: body.byteLength, mimeType: file.mimeType }
}

const sortBy = <T>(values: readonly T[], key: (value: T) => string) => [...values].sort((left, right) => {
  const leftKey = key(left); const rightKey = key(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
})

const reviewFile = (findings: readonly DeliveryReviewFindingInput[], waivers: readonly DeliveryReviewWaiverInput[], generatedAt: string) =>
  canonicalJson({ schemaVersion: '1.0', generatedAt, findings, waivers })

const sourceMapFile = (entries: readonly DeliverySourceMapEntryInput[], generatedAt: string) =>
  canonicalJson({ schemaVersion: '1.0', generatedAt, entries })

/** Build an immutable, deterministic delivery manifest and its generated JSON evidence files. */
export function buildDeliveryBundleManifest(input: DeliveryBundleManifestInput): DeliveryBundleBuildResult {
  const errors: DeliveryBundleBuildError[] = []
  const collections = [input.factSources, input.ruleVersions, input.contentFiles, input.deliveryVariants, input.assetPreviews, input.reviewFindings, input.reviewWaivers, input.sourceMap]
  if (collections.some(items => !Array.isArray(items) || items.length > MAX_COLLECTION_ITEMS)) {
    return { ok: false, errors: [error('FILE_INVALID', 'input', `交付包集合数量不得超过 ${MAX_COLLECTION_ITEMS}。`)] }
  }
  if (input.reviewFindings.some(item => !Array.isArray(item.evidenceSourceIds) || item.evidenceSourceIds.length > MAX_COLLECTION_ITEMS) || input.sourceMap.some(item => !Array.isArray(item.factSourceIds) || !Array.isArray(item.ruleVersionIds) || item.factSourceIds.length > MAX_COLLECTION_ITEMS || item.ruleVersionIds.length > MAX_COLLECTION_ITEMS)) {
    return { ok: false, errors: [error('SOURCE_INVALID', 'input', `嵌套证据引用数量不得超过 ${MAX_COLLECTION_ITEMS}。`)] }
  }
  const scope = input.scope
  const entities = input.entities
  const scopeObjectsValid = isPlainRecord(scope) && isPlainRecord(entities) && isPlainRecord(entities.workspace) && isPlainRecord(entities.task) && isPlainRecord(entities.product) && isPlainRecord(entities.brand)
  if (!scopeObjectsValid || ![scope.workspaceId, scope.taskId, scope.productId, scope.brandId].every(validId)) {
    errors.push(error('SCOPE_MISMATCH', 'scope', '交付包必须绑定完整的工作区、任务、商品和品牌作用域。'))
  } else if (
    entities.workspace.id !== scope.workspaceId ||
    entities.task.id !== scope.taskId || entities.task.workspaceId !== scope.workspaceId || entities.task.productId !== scope.productId || entities.task.brandId !== scope.brandId ||
    entities.product.id !== scope.productId || entities.product.workspaceId !== scope.workspaceId || entities.product.brandId !== scope.brandId ||
    entities.brand.id !== scope.brandId || entities.brand.workspaceId !== scope.workspaceId
  ) errors.push(error('SCOPE_MISMATCH', 'entities', '工作区、任务、商品或品牌实体作用域不一致。'))

  const generatedAtMs = Date.parse(input.version?.generatedAt ?? '')
  let vectorValid = false
  try { canonicalJson(input.version?.vector); vectorValid = true } catch { vectorValid = false }
  if (!input.version || !validId(input.version.contentVersionId) || !Number.isSafeInteger(input.version.number) || input.version.number < 1 || !validId(input.version.state) || !Number.isFinite(generatedAtMs) || !vectorValid) {
    errors.push(error('VERSION_INVALID', 'version', '内容版本、冻结生成时间与版本向量必须完整。'))
  }

  const factIdentity = new Set<string>()
  input.factSources.forEach((fact, index) => {
    const identity = `${fact.id}\u0000${fact.version}`
    if (!isPlainRecord(fact) || !validId(fact.id) || !validId(fact.version) || factIdentity.has(identity) || !SHA256.test(fact.sha256) || /^0{64}$/u.test(normalizeSha(fact.sha256)) || fact.workspaceId !== scope.workspaceId || fact.productId !== scope.productId) errors.push(error('SOURCE_INVALID', `factSources[${index}]`, '事实来源必须有唯一合法版本/哈希并且属于当前工作区与商品。'))
    factIdentity.add(identity)
  })
  const ruleIdentity = new Set<string>()
  input.ruleVersions.forEach((rule, index) => {
    const identity = `${rule.id}\u0000${rule.version}`
    if (!isPlainRecord(rule) || !validId(rule.id) || !validId(rule.version) || ruleIdentity.has(identity) || !SHA256.test(rule.sha256) || /^0{64}$/u.test(normalizeSha(rule.sha256)) || (rule.scope === 'workspace' && rule.workspaceId !== scope.workspaceId) || (rule.scope === 'global' && rule.workspaceId !== undefined) || (rule.scope !== 'workspace' && rule.scope !== 'global')) errors.push(error('SOURCE_INVALID', `ruleVersions[${index}]`, '规则版本必须有唯一合法哈希并符合互斥的全局/工作区作用域。'))
    ruleIdentity.add(identity)
  })

  input.deliveryVariants.forEach((variant, index) => {
    if (![variant.id, variant.platform, variant.placement].every(validId) || variant.workspaceId !== scope.workspaceId || variant.taskId !== scope.taskId || variant.productId !== scope.productId || variant.brandId !== scope.brandId) errors.push(error('SCOPE_MISMATCH', `deliveryVariants[${index}]`, '交付 variant 标识或作用域与交付包不一致。'))
  })
  input.assetPreviews.forEach((preview, index) => {
    if (preview.workspaceId !== scope.workspaceId) errors.push(error('SCOPE_MISMATCH', `assetPreviews[${index}]`, '素材预览不属于当前工作区。'))
    if (!validId(preview.assetId) || !SHA256.test(preview.sourceSha256) || /^0{64}$/u.test(normalizeSha(preview.sourceSha256)) || !Number.isSafeInteger(preview.sourceRevision) || preview.sourceRevision < 1) errors.push(error('SOURCE_INVALID', `assetPreviews[${index}]`, '素材预览必须包含合法来源 SHA/revision。'))
  })

  const generatedAt = Number.isFinite(generatedAtMs) ? new Date(generatedAtMs).toISOString() : input.version?.generatedAt ?? ''
  const findings = sortBy(input.reviewFindings.map(item => ({ ...item, evidenceSourceIds: [...new Set(item.evidenceSourceIds)].sort() })), item => `${item.code}:${item.field}`)
  const waivers = sortBy(input.reviewWaivers.map(item => ({ ...item, waivedAt: Number.isFinite(Date.parse(item.waivedAt)) ? new Date(item.waivedAt).toISOString() : item.waivedAt })), item => `${item.findingCode}:${item.findingField}`)
  for (const [index, waiver] of waivers.entries()) {
    const target = findings.find(item => item.code === waiver.findingCode && item.field === waiver.findingField)
    if (!target || target.status === 'blocked' || !waiver.reason.trim() || !waiver.actorId.trim() || !Number.isFinite(Date.parse(waiver.waivedAt))) errors.push(error('WAIVER_INVALID', `reviewWaivers[${index}]`, '豁免必须对应非 blocked finding，并包含原因、操作人和时间。'))
  }

  const sourceMap = sortBy(input.sourceMap.map(item => ({ ...item, factSourceIds: [...new Set(item.factSourceIds)].sort(), ruleVersionIds: [...new Set(item.ruleVersionIds)].sort() })), item => `${item.outputPath}:${item.field}`)
  const factIds = new Set(input.factSources.map(item => item.id))
  const ruleReferences = input.ruleVersions.flatMap(item => [item.id, item.version])
  const ruleIds = new Set(ruleReferences)
  if (ruleIds.size !== ruleReferences.length) errors.push(error('SOURCE_INVALID', 'ruleVersions', '规则 id/version 引用必须全局唯一，避免 source-map 作用域歧义。'))
  findings.forEach((item, index) => {
    if (!validId(item.code) || !validId(item.field) || !validId(item.message) || item.evidenceSourceIds.some(id => !factIds.has(id))) errors.push(error('SOURCE_INVALID', `reviewFindings[${index}]`, '审核 finding 必须引用当前作用域内事实来源。'))
  })
  sourceMap.forEach((entry, index) => {
    if (!safePath(entry.outputPath) || entry.factSourceIds.some(id => !factIds.has(id)) || entry.ruleVersionIds.some(id => !ruleIds.has(id))) errors.push(error('SOURCE_INVALID', `sourceMap[${index}]`, 'source-map 必须引用当前交付包中的合法输出路径、事实和规则。'))
  })

  if (input.publishReceipt) {
    const receipt = input.publishReceipt
    if (receipt.workspaceId !== scope.workspaceId || receipt.taskId !== scope.taskId || receipt.productId !== scope.productId || receipt.contentVersionId !== input.version.contentVersionId || receipt.status !== 'published' || receipt.verified !== true || ![receipt.platform, receipt.requestId, receipt.remoteProductId].every(validId) || !Number.isFinite(Date.parse(receipt.observedAt))) {
      errors.push(error('PUBLISH_RECEIPT_INVALID', 'publishReceipt', '只能包含作用域一致、已验证且状态为 published 的真实回执。'))
    }
  }

  const userFiles = [...input.contentFiles, ...input.assetPreviews.map(item => item.file)]
  const structuredMediaPaths = new Set([
    ...input.deliveryVariants.map(item => item.filePath),
    ...input.assetPreviews.map(item => item.file.path),
  ])
  let totalBytes = 0
  const pathOwners = new Map<string, string>()
  userFiles.forEach((file, index) => {
    const owner = index < input.contentFiles.length ? `contentFiles[${index}]` : `assetPreviews[${index - input.contentFiles.length}].file`
    if (!safePath(file.path)) errors.push(error('PATH_INVALID', `${owner}.path`, '文件路径必须是 NFC 相对路径，不得包含穿越、绝对路径或反斜杠。'))
    const pathKey = typeof file.path === 'string' ? canonicalPathKey(file.path) : ''
    if (RESERVED_PATH_KEYS.has(pathKey)) errors.push(error('PATH_CONFLICT', `${owner}.path`, `${String(file.path)} 由 manifest 构建器保留生成。`))
    const contentValid = typeof file.content === 'string' || file.content instanceof Uint8Array
    const size = contentValid ? (typeof file.content === 'string' && file.content.length > MAX_FILE_BYTES ? MAX_FILE_BYTES + 1 : bytes(file.content).byteLength) : 0
    totalBytes += size
    const mimeValid = typeof file.mimeType === 'string' && file.mimeType.length <= 200 && MIME.test(file.mimeType)
    if (!mimeValid || !contentValid || size === 0 || size > MAX_FILE_BYTES || mimeValid && contentValid && !contentMatchesMime(file, structuredMediaPaths.has(file.path))) errors.push(error('FILE_INVALID', owner, '文件必须包含匹配扩展名/签名的合法 MIME 和安全大小的非空内容。'))
    const key = pathKey
    const previous = pathOwners.get(key)
    if (previous) errors.push(error('PATH_CONFLICT', `${owner}.path`, `文件路径与 ${previous} 冲突。`))
    else pathOwners.set(key, owner)
  })
  if (totalBytes > MAX_TOTAL_BYTES) errors.push(error('FILE_INVALID', 'contentFiles', '交付包总文件大小超过安全上限。'))
  input.assetPreviews.forEach((preview, index) => {
    if (!preview.file.path.startsWith('previews/')) errors.push(error('PATH_INVALID', `assetPreviews[${index}].file.path`, '素材预览必须位于 previews/ 目录。'))
  })
  const availablePaths = new Set(userFiles.map(file => file.path))
  for (const requiredPath of ['README.md', 'content.md', 'content.json']) {
    if (!availablePaths.has(requiredPath)) errors.push(error('FILE_REFERENCE_MISSING', 'contentFiles', `PRD 交付包缺少必需文件 ${requiredPath}。`))
  }
  input.deliveryVariants.forEach((variant, index) => {
    if (!availablePaths.has(variant.filePath)) errors.push(error('FILE_REFERENCE_MISSING', `deliveryVariants[${index}].filePath`, 'delivery variant 引用的文件不存在。'))
  })
  sourceMap.forEach((entry, index) => {
    if (!availablePaths.has(entry.outputPath)) errors.push(error('FILE_REFERENCE_MISSING', `sourceMap[${index}].outputPath`, 'source-map 引用的交付文件不存在。'))
  })

  const secretHits = sensitivePaths(input)
  if (secretHits.length) errors.push(error('SENSITIVE_DATA_FORBIDDEN', secretHits[0]!, '交付包输入含有 token、storage credential 或其他敏感凭据。'))
  if (errors.length) return { ok: false, errors }

  const generatedEvidenceFiles: DeliveryBundleFile[] = [
    { path: 'review-findings.json', mimeType: 'application/json; charset=utf-8', content: reviewFile(findings, waivers, generatedAt) },
    { path: 'source-map.json', mimeType: 'application/json; charset=utf-8', content: sourceMapFile(sourceMap, generatedAt) },
  ]
  if (input.publishReceipt) generatedEvidenceFiles.push({
    path: 'publish-receipt.json', mimeType: 'application/json; charset=utf-8',
    content: canonicalJson({ schemaVersion: '1.0', ...input.publishReceipt, observedAt: new Date(input.publishReceipt.observedAt).toISOString() }),
  })
  const payloadFiles: DeliveryBundleFile[] = [...userFiles.map(file => ({ path: file.path, mimeType: file.mimeType, content: typeof file.content === 'string' ? file.content : new Uint8Array(file.content) })), ...generatedEvidenceFiles]
  const fileMetadata = sortBy(payloadFiles.map(metadata), item => item.path)

  const factSources = sortBy(input.factSources.map(item => ({ id: item.id, version: item.version, sha256: normalizeSha(item.sha256), verified: item.verified })), item => `${item.id}:${item.version}`)
  const ruleVersions = sortBy(input.ruleVersions.map(item => ({ ...item, sha256: normalizeSha(item.sha256) })), item => `${item.id}:${item.version}`)
  const deliveryVariants = sortBy(input.deliveryVariants.map(({ workspaceId: _workspaceId, taskId: _taskId, productId: _productId, brandId: _brandId, ...item }) => item), item => item.id)
  const assetPreviews = sortBy(input.assetPreviews.map(({ workspaceId: _workspaceId, file, ...item }) => ({ ...item, sourceSha256: normalizeSha(item.sourceSha256), filePath: file.path })), item => `${item.assetId}:${item.sourceRevision}:${item.filePath}`)
  const externallyUnverified = [
    ...factSources.filter(item => !item.verified).map(item => `fact:${item.id}@${item.version}`),
    ...ruleVersions.filter(item => !item.verified).map(item => `rule:${item.id}@${item.version}`),
    ...input.contentFiles.filter(item => item.externallyUnverified).map(item => `file:${item.path}`),
    ...input.deliveryVariants.filter(item => item.externallyUnverified).map(item => `variant:${item.id}`),
    ...input.assetPreviews.filter(item => item.externallyUnverified).map(item => `preview:${item.assetId}@r${item.sourceRevision}`),
  ].sort()
  const blocked = findings.some(item => item.status === 'blocked') || input.assetPreviews.some(item => item.blocked)
  const manifest: DeliveryBundleManifest = {
    schemaVersion: '1.0', generatedAt, scope: clone(scope), entities: clone(entities),
    version: { ...clone(input.version), generatedAt }, factSources, ruleVersions, files: fileMetadata,
    deliveryVariants, assetPreviews: assetPreviews as DeliveryBundleManifest['assetPreviews'],
    review: { findingsFile: 'review-findings.json', findings, waivers },
    sourceMap: { file: 'source-map.json', entries: sourceMap },
    ...(input.publishReceipt ? { publishReceipt: { file: 'publish-receipt.json' as const, status: 'published' as const, platform: input.publishReceipt.platform, requestId: input.publishReceipt.requestId, remoteProductId: input.publishReceipt.remoteProductId, observedAt: new Date(input.publishReceipt.observedAt).toISOString() } } : {}),
    publishable: !blocked && externallyUnverified.length === 0,
    externallyUnverified,
  }
  const frozenManifest = deepFreeze(manifest)
  const serialized = canonicalJson(frozenManifest)
  const manifestHash = sha256(serialized)
  const files: DeliveryBundleFile[] = sortBy([
    { path: 'manifest.json', mimeType: 'application/json; charset=utf-8', content: serialized },
    ...payloadFiles,
  ], item => item.path)
  return { ok: true, manifest: frozenManifest, canonicalJson: serialized, manifestHash, files: deepFreeze(files) }
}

/** Verify a built bundle against a trusted manifest hash and all file metadata. */
export function verifyDeliveryBundle(
  manifest: DeliveryBundleManifest,
  files: readonly DeliveryBundleFile[],
  expectedManifestHash: string,
): DeliveryBundleVerificationResult {
  const errors: DeliveryBundleVerificationResult['errors'][number][] = []
  const serialized = canonicalJson(manifest)
  if (sha256(serialized) !== normalizeSha(expectedManifestHash)) errors.push({ code: 'MANIFEST_HASH_MISMATCH', path: 'manifest.json', message: '交付 manifest canonical hash 不匹配。' })
  const byPath = new Map(files.map(file => [file.path, file]))
  const manifestFile = byPath.get('manifest.json')
  if (!manifestFile || typeof manifestFile.content !== 'string' || manifestFile.content !== serialized) errors.push({ code: 'MANIFEST_CONTENT_MISMATCH', path: 'manifest.json', message: 'manifest.json 内容与待验证 manifest 不一致。' })
  for (const expected of manifest.files) {
    const actual = byPath.get(expected.path)
    if (!actual) { errors.push({ code: 'FILE_MISSING', path: expected.path, message: '交付文件缺失。' }); continue }
    const actualMetadata = metadata(actual)
    if (actualMetadata.sha256 !== expected.sha256) errors.push({ code: 'FILE_HASH_MISMATCH', path: expected.path, message: '文件 SHA-256 不匹配，可能已被篡改。' })
    if (actualMetadata.sizeBytes !== expected.sizeBytes) errors.push({ code: 'FILE_SIZE_MISMATCH', path: expected.path, message: '文件字节数不匹配。' })
    if (actualMetadata.mimeType !== expected.mimeType) errors.push({ code: 'FILE_MIME_MISMATCH', path: expected.path, message: '文件 MIME 不匹配。' })
  }
  const expectedPaths = new Set(['manifest.json', ...manifest.files.map(file => file.path)])
  for (const file of files) if (!expectedPaths.has(file.path)) errors.push({ code: 'UNEXPECTED_FILE', path: file.path, message: '交付包包含 manifest 未列出的文件。' })
  return { valid: errors.length === 0, errors }
}
