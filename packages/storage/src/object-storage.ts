import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, lstat, readdir, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path'

export type ObjectZone = 'quarantine' | 'clean'

export interface ObjectMetadata {
  key: string
  workspaceId: string
  zone: ObjectZone
  contentType: string
  sizeBytes: number
  sha256: string
  createdAt: string
  /** Set only when an external scanner has explicitly attested the object. */
  scanEvidenceRef?: string
}

export interface StoredObject {
  metadata: ObjectMetadata
  body: Uint8Array
}

export interface PutQuarantineObjectInput {
  workspaceId: string
  assetId: string
  fileName: string
  contentType: string
  body: Uint8Array
  expectedSha256?: string
  expectedSizeBytes?: number
}

export interface PromoteCleanObjectInput {
  workspaceId: string
  quarantineKey: string
  scanEvidenceRef: string
}

export interface CopyQuarantineToCleanInput extends PromoteCleanObjectInput {
  /** Immutable digest bound to the committed scan receipt. */
  expectedSha256: string
  /** Immutable byte length bound to the committed scan receipt. */
  expectedSizeBytes: number
}

export type DeleteQuarantineAfterCommitInput = CopyQuarantineToCleanInput

/**
 * Storage boundary used by asset/application code.
 *
 * The port deliberately has no S3/OSS SDK types. A cloud adapter can implement
 * this contract later without making the domain depend on a provider. The local
 * adapter below is intended for development, CI and a single-node deployment
 * only; it is not evidence that a managed object store is configured.
 */
export interface ObjectStoragePort {
  putQuarantine(input: PutQuarantineObjectInput): Promise<ObjectMetadata>
  /** List metadata only for one already-authorized workspace. */
  list(workspaceId: string): Promise<readonly ObjectMetadata[]>
  head(workspaceId: string, key: string, options?: { includeQuarantine?: boolean }): Promise<ObjectMetadata | null>
  get(workspaceId: string, key: string, options?: { includeQuarantine?: boolean }): Promise<StoredObject>
  /** Phase 1: create and verify clean bytes while retaining the quarantine source. */
  copyQuarantineToClean(input: CopyQuarantineToCleanInput): Promise<ObjectMetadata>
  /** Phase 2: after the business transaction commits, idempotently remove the verified source. */
  deleteQuarantineAfterCommit(input: DeleteQuarantineAfterCommitInput): Promise<void>
  /** @deprecated Compatibility operation; new callers must use the two-phase primitives. */
  promoteClean(input: PromoteCleanObjectInput): Promise<ObjectMetadata>
  delete(workspaceId: string, key: string, options?: { includeQuarantine?: boolean }): Promise<void>
}

/** Provider-neutral transport for S3/OSS/COS. The application owns the
 * quarantine/clean policy; the deployment supplies a signed transport so no
 * cloud SDK or credentials leak into the domain package. */
export interface CloudObjectTransport {
  head(key: string): Promise<{ contentType?: string; sizeBytes?: number; metadata?: Record<string, string> } | null>
  /** Provider-native listing. Implementations must return provider keys only. */
  list?(prefix: string): Promise<readonly string[]>
  get(key: string): Promise<{ body: Uint8Array; contentType?: string; metadata?: Record<string, string> }>
  put(key: string, input: { body: Uint8Array; contentType: string; metadata: Record<string, string>; ifAbsent?: boolean }): Promise<void>
  delete(key: string): Promise<void>
}

/** A transport may use this error to distinguish a missing object from an
 * unavailable provider. The adapter must never turn a provider outage into a
 * successful-looking 404. */
export class CloudObjectNotFoundError extends Error {
  readonly code = 'OBJECT_NOT_FOUND'
  constructor(message = 'cloud object not found') {
    super(message)
    this.name = 'CloudObjectNotFoundError'
  }
}

export class ObjectStoragePartialWriteError extends Error {
  readonly code = 'OBJECT_STORAGE_PARTIAL_WRITE'
  constructor(readonly orphanKey: string, readonly cause: unknown, readonly cleanupErrors: unknown[]) {
    super('object body was written but compensation could not fully remove it')
    this.name = 'ObjectStoragePartialWriteError'
  }
}

export interface S3CompatibleObjectStorageConfig {
  endpoint: string
  bucket: string
  region: string
  kmsKeyId: string
  keyPrefix?: string
  maxObjectBytes?: number
  versioningRequired?: boolean
  publicAccessBlocked?: boolean
  scanEvidenceRequired?: boolean
}

const PLACEHOLDER = /(?:\$\{|SET_|REPLACE_ME|BLOCKED_UNTIL_|CHANGE_ME)/u
const BUCKET = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u
const REGION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first = -1, second = -1, third = -1] = parts
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 198 && second >= 18 && second <= 19) ||
    first >= 224
}

function isBlockedEndpointHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local') || normalized.endsWith('.internal')) return true
  if (isIP(normalized) === 4) return isBlockedIpv4(normalized)
  if (isIP(normalized) !== 6) return false
  if (normalized.startsWith('::ffff:')) {
    const mappedIpv4 = normalized.slice('::ffff:'.length)
    if (isIP(mappedIpv4) === 4) return isBlockedIpv4(mappedIpv4)
  }
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/u.test(normalized)
}

function validateKeyPrefix(value: string | undefined): string {
  const prefix = (value ?? '').trim().replace(/^\/+|\/+$/gu, '')
  if (!prefix) return ''
  const parts = prefix.split('/')
  if (prefix.length > 128 || parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/u.test(part))) {
    throw new ObjectStorageError('OBJECT_PREFIX_INVALID', '对象存储 key 前缀无效', 500)
  }
  return prefix
}

/**
 * Validates the deployment contract without accepting credentials. The
 * signer/SDK remains outside this package and is supplied through the
 * transport. Production requires TLS and explicit encryption/isolation
 * controls; tests may use an HTTPS fixture endpoint but never cloud secrets.
 */
export function parseS3CompatibleObjectStorageConfig(input: unknown, options: { environment?: string } = {}): S3CompatibleObjectStorageConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', '对象存储配置必须是对象', 500)
  const value = input as Record<string, unknown>
  const environment = (options.environment ?? 'production').trim().toLowerCase()
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim() : ''
  const bucket = typeof value.bucket === 'string' ? value.bucket.trim() : ''
  const region = typeof value.region === 'string' ? value.region.trim() : ''
  const kmsKeyId = typeof value.kmsKeyId === 'string' ? value.kmsKeyId.trim() : ''
  if (!endpoint || PLACEHOLDER.test(endpoint)) throw new ObjectStorageError('OBJECT_STORAGE_ENDPOINT_REQUIRED', '对象存储 endpoint 未配置', 500)
  let parsedEndpoint: URL
  try { parsedEndpoint = new URL(endpoint) } catch { throw new ObjectStorageError('OBJECT_STORAGE_ENDPOINT_INVALID', '对象存储 endpoint 必须是有效 URL', 500) }
  if (parsedEndpoint.protocol !== 'https:' && environment === 'production') throw new ObjectStorageError('OBJECT_STORAGE_TLS_REQUIRED', '生产对象存储 endpoint 必须使用 HTTPS', 500)
  if (parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash || !parsedEndpoint.hostname || (environment === 'production' && isBlockedEndpointHost(parsedEndpoint.hostname))) {
    throw new ObjectStorageError('OBJECT_STORAGE_ENDPOINT_INVALID', '对象存储 endpoint 不得包含凭证、查询参数或本地地址', 500)
  }
  if (!BUCKET.test(bucket) || bucket.includes('..')) throw new ObjectStorageError('OBJECT_STORAGE_BUCKET_INVALID', '对象存储 bucket 无效', 500)
  if (!REGION.test(region)) throw new ObjectStorageError('OBJECT_STORAGE_REGION_INVALID', '对象存储 region 无效', 500)
  if (!kmsKeyId || kmsKeyId.length > 512 || PLACEHOLDER.test(kmsKeyId) || /[\u0000-\u001f\u007f\r\n]/u.test(kmsKeyId)) throw new ObjectStorageError('OBJECT_STORAGE_KMS_REQUIRED', '生产对象存储必须配置 KMS key', 500)
  const maxObjectBytes = value.maxObjectBytes === undefined ? 50 * 1024 * 1024 : value.maxObjectBytes
  if (typeof maxObjectBytes !== 'number' || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 50 * 1024 * 1024) throw new ObjectStorageError('OBJECT_LIMIT_INVALID', '对象大小限制必须为 1 至 50 MiB 的整数', 500)
  for (const [field, defaultValue] of [['versioningRequired', true], ['publicAccessBlocked', true], ['scanEvidenceRequired', true] ] as const) {
    if ((value[field] ?? defaultValue) !== true) throw new ObjectStorageError(`OBJECT_STORAGE_${field.toUpperCase()}_REQUIRED`, `${field} 必须显式为 true`, 500)
  }
  return { endpoint, bucket, region, kmsKeyId, keyPrefix: validateKeyPrefix(typeof value.keyPrefix === 'string' ? value.keyPrefix : undefined), maxObjectBytes, versioningRequired: true, publicAccessBlocked: true, scanEvidenceRequired: true }
}

function isCloudNotFound(error: unknown): boolean {
  if (error instanceof CloudObjectNotFoundError) return true
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown }
  return value.code === 'NoSuchKey' || value.code === 'NotFound' || value.code === 'OBJECT_NOT_FOUND' || value.status === 404 || value.statusCode === 404
}

export class ObjectStorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message)
    this.name = 'ObjectStorageError'
  }
}

export function isRetryableObjectStorageReadError(error: unknown) {
  if (error instanceof ObjectStorageError) return error.code === 'OBJECT_STORAGE_UNAVAILABLE' || error.status === 429
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } }
  const status = [value.status, value.statusCode, value.$metadata?.httpStatusCode].find(item => typeof item === 'number') as number | undefined
  if (status === 404) return false
  if (status === 429 || (status !== undefined && status >= 500)) return true
  return ['SlowDown', 'RequestTimeout', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'NETWORK_ERROR'].includes(String(value.code ?? value.name ?? ''))
}

export async function withObjectStorageReadRetry<T>(operation: () => Promise<T>, options: { attempts?: number; baseDelayMs?: number } = {}) {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 25
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 60_000) throw new ObjectStorageError('OBJECT_RETRY_CONFIG_INVALID', '对象存储重试参数无效', 500)
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation() } catch (error) {
      lastError = error
      if (!isRetryableObjectStorageReadError(error) || attempt === attempts - 1) throw error
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * (attempt + 1)))
    }
  }
  throw lastError
}

const SHA256 = /^[a-f0-9]{64}$/i
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_FILE_NAME_LENGTH = 160

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function requireId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) throw new ObjectStorageError('OBJECT_SCOPE_INVALID', `${field} 格式无效`, 400)
  return value
}

function requireSha(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!SHA256.test(value)) throw new ObjectStorageError('OBJECT_DIGEST_INVALID', `${field} 必须是 SHA-256`, 400)
  return value.toLowerCase()
}

function requireExpectedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ObjectStorageError('OBJECT_SIZE_INVALID', 'expectedSizeBytes 必须是非负安全整数', 400)
  return value
}

function requireScanEvidence(value: string): string {
  const evidence = value.trim()
  if (!evidence || evidence.length > 512 || /[\u0000\r\n]/u.test(evidence)) throw new ObjectStorageError('SCAN_EVIDENCE_REQUIRED', '转入 clean 区域必须提供外部扫描证据引用', 400)
  return evidence
}

function cleanKeyForQuarantine(workspaceId: string, quarantineKey: string): { sourceKey: string; targetKey: string } {
  const source = requireKeyForWorkspace(workspaceId, quarantineKey, 'quarantine')
  const parts = source.relative.split('/')
  return { sourceKey: source.relative, targetKey: `clean/${workspaceId}/${parts[2]}/${parts.slice(3).join('/')}` }
}

function assertPromotionEvidence(metadata: ObjectMetadata, expectedSha256: string, expectedSizeBytes: number, scanEvidenceRef?: string): void {
  if (metadata.sha256 !== expectedSha256 || metadata.sizeBytes !== expectedSizeBytes) {
    throw new ObjectStorageError('OBJECT_PROMOTION_EVIDENCE_MISMATCH', '对象 SHA-256 或大小与扫描证据不一致', 409)
  }
  if (scanEvidenceRef !== undefined && metadata.scanEvidenceRef !== scanEvidenceRef) {
    throw new ObjectStorageError('OBJECT_PROMOTION_EVIDENCE_MISMATCH', 'clean 对象与扫描证据引用不一致', 409)
  }
}

function safeFileName(fileName: string): string {
  const trimmed = fileName.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\') || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new ObjectStorageError('OBJECT_NAME_INVALID', '素材文件名无效', 400)
  }
  // Object keys must be portable across case-sensitive cloud stores and the
  // case-insensitive filesystems used by local acceptance. Preserve the
  // display name in asset metadata, but canonicalize the storage filename.
  const normalized = trimmed.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/u, '_').slice(0, MAX_FILE_NAME_LENGTH)
  if (!normalized || normalized === '.' || normalized === '..') throw new ObjectStorageError('OBJECT_NAME_INVALID', '素材文件名无效', 400)
  return normalized
}

function requireContentType(contentType: string): string {
  const value = contentType.trim()
  if (!value || value.length > 255 || !/^[\w.+-]+\/[\w.+-]+(?:\s*;.*)?$/u.test(value)) throw new ObjectStorageError('OBJECT_CONTENT_TYPE_INVALID', '素材 MIME 类型无效', 400)
  return value.toLowerCase()
}

function requireKeyForWorkspace(workspaceId: string, key: string, expectedZone?: ObjectZone): { zone: ObjectZone; relative: string } {
  requireId(workspaceId, 'workspaceId')
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\u0000')) throw new ObjectStorageError('OBJECT_KEY_INVALID', '对象 key 无效', 400)
  const parts = key.split('/')
  const zone = parts[0]
  if (zone !== 'quarantine' && zone !== 'clean') throw new ObjectStorageError('OBJECT_ZONE_INVALID', '对象必须位于 quarantine 或 clean 区域', 400)
  if (expectedZone && zone !== expectedZone) throw new ObjectStorageError('OBJECT_ZONE_INVALID', `对象必须位于 ${expectedZone} 区域`, 400)
  if (parts[1] !== workspaceId || parts.length < 4 || parts.some(part => !part || part === '.' || part === '..')) throw new ObjectStorageError('OBJECT_SCOPE_DENIED', '对象不属于当前工作区', 403)
  const relative = posix.normalize(key)
  if (relative !== key || relative.startsWith('../') || relative.includes('/../')) throw new ObjectStorageError('OBJECT_KEY_INVALID', '对象 key 不能包含路径穿越', 400)
  return { zone, relative }
}

/**
 * Secure local filesystem implementation.
 *
 * Objects are written below `<root>/<zone>/<workspace>/<asset>/<file>`. Every
 * read/write validates the workspace segment, rejects traversal/backslashes,
 * rejects symlinked path components, verifies size and SHA-256, and writes via
 * same-directory temporary files before rename. Quarantine objects are never
 * returned by default and can move to clean only with explicit scanner evidence.
 */
export class LocalObjectStorage implements ObjectStoragePort {
  readonly maxObjectBytes: number

  constructor(readonly rootDir: string, options: { maxObjectBytes?: number } = {}) {
    if (!isAbsolute(rootDir)) throw new ObjectStorageError('OBJECT_ROOT_INVALID', '本地对象存储 root 必须是绝对路径', 500)
    this.maxObjectBytes = options.maxObjectBytes ?? 50 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxObjectBytes) || this.maxObjectBytes < 1) throw new ObjectStorageError('OBJECT_LIMIT_INVALID', '对象大小限制无效', 500)
  }

  async putQuarantine(input: PutQuarantineObjectInput): Promise<ObjectMetadata> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const assetId = requireId(input.assetId, 'assetId')
    const fileName = safeFileName(input.fileName)
    const contentType = requireContentType(input.contentType)
    const expectedSha256 = requireSha(input.expectedSha256, 'expectedSha256')
    if (!(input.body instanceof Uint8Array)) throw new ObjectStorageError('OBJECT_BODY_INVALID', '对象内容必须是二进制 Uint8Array', 400)
    if (input.body.byteLength > this.maxObjectBytes) throw new ObjectStorageError('OBJECT_TOO_LARGE', `对象不能超过 ${this.maxObjectBytes} bytes`, 413)
    if (input.expectedSizeBytes !== undefined && (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes !== input.body.byteLength)) throw new ObjectStorageError('OBJECT_SIZE_MISMATCH', '对象大小与声明不一致', 400)
    const digest = sha256(input.body)
    if (expectedSha256 && expectedSha256 !== digest) throw new ObjectStorageError('OBJECT_DIGEST_MISMATCH', '对象 SHA-256 与声明不一致', 400)
    const key = `quarantine/${workspaceId}/${assetId}/${fileName}`
    return this.writeObject({ key, workspaceId, zone: 'quarantine', contentType, body: input.body, sha256: digest })
  }

  async list(workspaceId: string): Promise<readonly ObjectMetadata[]> {
    const scope = requireId(workspaceId, 'workspaceId')
    const result: ObjectMetadata[] = []
    for (const zone of ['quarantine', 'clean'] as const) {
      const workspaceRoot = resolve(this.rootDir, zone, scope)
      const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
        let entries
        try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '对象存储暂时不可用', 503)
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) throw new ObjectStorageError('OBJECT_PATH_INVALID', '对象存储目录不能包含符号链接', 500)
          const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
          const fullPath = resolve(directory, entry.name)
          if (entry.isDirectory()) await visit(fullPath, relative)
          else if (entry.isFile() && entry.name.endsWith('.meta.json')) {
            const key = `${zone}/${scope}/${relative.slice(0, -'.meta.json'.length)}`
            result.push(await this.readMetadata(scope, key))
          }
        }
      }
      await visit(workspaceRoot, '')
    }
    return result.sort((left, right) => left.key.localeCompare(right.key))
  }

  async head(workspaceId: string, key: string, options: { includeQuarantine?: boolean } = {}): Promise<ObjectMetadata | null> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    this.assertReadableZone(parsed.zone, options.includeQuarantine === true)
    try {
      return await this.readMetadata(workspaceId, parsed.relative)
    } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') return null
      throw error
    }
  }

  async get(workspaceId: string, key: string, options: { includeQuarantine?: boolean } = {}): Promise<StoredObject> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    this.assertReadableZone(parsed.zone, options.includeQuarantine === true)
    const metadata = await this.readMetadata(workspaceId, parsed.relative)
    let body: Uint8Array
    try {
      body = new Uint8Array(await readFile(this.objectPath(parsed.relative)))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new ObjectStorageError('OBJECT_NOT_FOUND', '对象不存在', 404)
      throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '对象存储暂时不可用', 503)
    }
    this.verifyBody(metadata, body)
    return { metadata, body }
  }

  async copyQuarantineToClean(input: CopyQuarantineToCleanInput): Promise<ObjectMetadata> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const evidence = requireScanEvidence(input.scanEvidenceRef)
    const expectedSha256 = requireSha(input.expectedSha256, 'expectedSha256')!
    const expectedSizeBytes = requireExpectedSize(input.expectedSizeBytes)
    const { sourceKey, targetKey } = cleanKeyForQuarantine(workspaceId, input.quarantineKey)
    const existingTarget = await this.head(workspaceId, targetKey, { includeQuarantine: true })
    if (existingTarget) {
      const verifiedTarget = await this.get(workspaceId, targetKey, { includeQuarantine: true })
      assertPromotionEvidence(verifiedTarget.metadata, expectedSha256, expectedSizeBytes, evidence)
      try {
        const sourceObject = await this.get(workspaceId, sourceKey, { includeQuarantine: true })
        assertPromotionEvidence(sourceObject.metadata, expectedSha256, expectedSizeBytes)
        const sameContent = sourceObject.metadata.contentType === verifiedTarget.metadata.contentType
        if (!sameContent) throw new ObjectStorageError('OBJECT_PROMOTION_CONFLICT', '已有 clean 对象与 quarantine 源内容不一致，已保留源对象并阻止晋级', 409)
      } catch (error) {
        if (!(error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND')) throw error
      }
      return verifiedTarget.metadata
    }
    const sourceObject = await this.get(workspaceId, sourceKey, { includeQuarantine: true })
    assertPromotionEvidence(sourceObject.metadata, expectedSha256, expectedSizeBytes)
    const target = await this.writeObject({ key: targetKey, workspaceId, zone: 'clean', contentType: sourceObject.metadata.contentType, body: sourceObject.body, sha256: sourceObject.metadata.sha256, scanEvidenceRef: evidence })
    const verifiedTarget = await this.get(workspaceId, target.key, { includeQuarantine: true })
    assertPromotionEvidence(verifiedTarget.metadata, expectedSha256, expectedSizeBytes, evidence)
    // Phase 1 never removes quarantine, including idempotent retries.
    await this.get(workspaceId, sourceKey, { includeQuarantine: true })
    return target
  }

  async deleteQuarantineAfterCommit(input: DeleteQuarantineAfterCommitInput): Promise<void> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const evidence = requireScanEvidence(input.scanEvidenceRef)
    const expectedSha256 = requireSha(input.expectedSha256, 'expectedSha256')!
    const expectedSizeBytes = requireExpectedSize(input.expectedSizeBytes)
    const { sourceKey, targetKey } = cleanKeyForQuarantine(workspaceId, input.quarantineKey)
    const target = await this.get(workspaceId, targetKey, { includeQuarantine: true })
    assertPromotionEvidence(target.metadata, expectedSha256, expectedSizeBytes, evidence)
    const objectPath = await this.safePath(sourceKey)
    let sourceFound = false
    try {
      const sourceMetadata = await this.readMetadata(workspaceId, sourceKey)
      assertPromotionEvidence(sourceMetadata, expectedSha256, expectedSizeBytes)
      sourceFound = true
    } catch (error) {
      if (!(error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND')) throw error
    }
    try {
      const body = new Uint8Array(await readFile(objectPath))
      if (body.byteLength !== expectedSizeBytes || sha256(body) !== expectedSha256) throw new ObjectStorageError('OBJECT_PROMOTION_EVIDENCE_MISMATCH', '隔离源内容与提交证据不一致', 409)
      sourceFound = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!sourceFound) return
    await this.removeObject(sourceKey)
  }

  async promoteClean(input: PromoteCleanObjectInput): Promise<ObjectMetadata> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const evidence = requireScanEvidence(input.scanEvidenceRef)
    const { sourceKey, targetKey } = cleanKeyForQuarantine(workspaceId, input.quarantineKey)
    let source: StoredObject
    try {
      source = await this.get(workspaceId, sourceKey, { includeQuarantine: true })
    } catch (error) {
      if (!(error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND')) throw error
      const target = await this.get(workspaceId, targetKey, { includeQuarantine: true })
      if (target.metadata.scanEvidenceRef !== evidence) throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', 'clean 对象已由不同扫描证据提升', 409)
      await this.deleteQuarantineAfterCommit({ ...input, expectedSha256: target.metadata.sha256, expectedSizeBytes: target.metadata.sizeBytes })
      return target.metadata
    }
    const existingTarget = await this.head(workspaceId, targetKey, { includeQuarantine: true })
    if (existingTarget?.scanEvidenceRef !== undefined && existingTarget.scanEvidenceRef !== evidence) throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', 'clean 对象已由不同扫描证据提升', 409)
    const phaseInput = { ...input, expectedSha256: source.metadata.sha256, expectedSizeBytes: source.metadata.sizeBytes }
    let target: ObjectMetadata
    try { target = await this.copyQuarantineToClean(phaseInput) } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_PROMOTION_EVIDENCE_MISMATCH' && existingTarget) throw new ObjectStorageError('OBJECT_PROMOTION_CONFLICT', '已有 clean 对象与 quarantine 源内容不一致，已保留源对象并阻止晋级', 409)
      throw error
    }
    await this.deleteQuarantineAfterCommit(phaseInput)
    return target
  }

  async delete(workspaceId: string, key: string, options: { includeQuarantine?: boolean } = {}): Promise<void> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    this.assertReadableZone(parsed.zone, options.includeQuarantine === true)
    await this.removeObject(parsed.relative)
  }

  private assertReadableZone(zone: ObjectZone, includeQuarantine: boolean) {
    if (zone === 'quarantine' && !includeQuarantine) throw new ObjectStorageError('QUARANTINE_ACCESS_DENIED', '隔离区素材未经扫描，不允许读取', 403)
  }

  private async writeObject(input: { key: string; workspaceId: string; zone: ObjectZone; contentType: string; body: Uint8Array; sha256: string; scanEvidenceRef?: string }): Promise<ObjectMetadata> {
    const parsed = requireKeyForWorkspace(input.workspaceId, input.key, input.zone)
    const objectPath = await this.safePath(parsed.relative)
    const metadataPath = `${objectPath}.meta.json`
    const createdAt = new Date().toISOString()
    const metadata: ObjectMetadata = { key: parsed.relative, workspaceId: input.workspaceId, zone: input.zone, contentType: input.contentType, sizeBytes: input.body.byteLength, sha256: input.sha256, createdAt, ...(input.scanEvidenceRef ? { scanEvidenceRef: input.scanEvidenceRef } : {}) }
    await this.ensureDirectory(dirname(objectPath))
    try {
      const existing = await this.readMetadata(input.workspaceId, parsed.relative)
      const sameImmutableMetadata = existing.sha256 === metadata.sha256
        && existing.sizeBytes === metadata.sizeBytes
        && existing.contentType === metadata.contentType
        && existing.zone === metadata.zone
        && existing.workspaceId === metadata.workspaceId
        && existing.scanEvidenceRef === metadata.scanEvidenceRef
      if (sameImmutableMetadata) {
        try {
          // Metadata is not a durable upload by itself. Verify the body before
          // acknowledging an idempotent retry after a partial delete/crash.
          const existingBody = new Uint8Array(await readFile(objectPath))
          this.verifyBody(existing, existingBody)
        } catch (error) {
          if (error instanceof ObjectStorageError && error.code === 'OBJECT_INTEGRITY_FAILED') throw error
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectStorageError('OBJECT_INTEGRITY_FAILED', '对象元数据存在但内容缺失，需要存储修复', 500)
          throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '对象存储暂时不可用', 503)
        }
        return existing
      }
      throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', '对象 key 已存在且内容或安全元数据不同', 409)
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.code !== 'OBJECT_NOT_FOUND') throw error
    }
    const suffix = `.tmp-${process.pid}-${randomUUID()}`
    const objectTemp = `${objectPath}${suffix}`
    const metadataTemp = `${metadataPath}${suffix}`
    try {
      await this.writeBinaryAtomic(objectTemp, input.body)
      await writeFile(metadataTemp, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(objectTemp, objectPath)
      await rename(metadataTemp, metadataPath)
      await chmod(objectPath, 0o600)
      await chmod(metadataPath, 0o600)
      return metadata
    } catch (error) {
      await rm(objectTemp, { force: true })
      await rm(metadataTemp, { force: true })
      throw error
    }
  }

  private async writeBinaryAtomic(path: string, body: Uint8Array): Promise<void> {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async readMetadata(workspaceId: string, key: string): Promise<ObjectMetadata> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    const metadataPath = `${await this.safePath(parsed.relative)}.meta.json`
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<ObjectMetadata>
      if (metadata.key !== parsed.relative || metadata.workspaceId !== workspaceId || metadata.zone !== parsed.zone || typeof metadata.sha256 !== 'string' || !SHA256.test(metadata.sha256) || typeof metadata.sizeBytes !== 'number' || !Number.isSafeInteger(metadata.sizeBytes) || typeof metadata.contentType !== 'string' || typeof metadata.createdAt !== 'string') throw new ObjectStorageError('OBJECT_METADATA_INVALID', '对象元数据损坏', 500)
      return metadata as ObjectMetadata
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new ObjectStorageError('OBJECT_NOT_FOUND', '对象不存在', 404)
      throw new ObjectStorageError('OBJECT_METADATA_INVALID', '无法读取对象元数据', 500)
    }
  }

  private verifyBody(metadata: ObjectMetadata, body: Uint8Array) {
    if (body.byteLength !== metadata.sizeBytes || sha256(body) !== metadata.sha256) throw new ObjectStorageError('OBJECT_INTEGRITY_FAILED', '对象内容完整性校验失败', 500)
  }

  private objectPath(relative: string): string {
    const path = resolve(this.rootDir, ...relative.split('/'))
    const root = resolve(this.rootDir)
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new ObjectStorageError('OBJECT_KEY_INVALID', '对象 key 超出存储根目录', 400)
    return path
  }

  private async safePath(relative: string): Promise<string> {
    const objectPath = this.objectPath(relative)
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await this.assertNotSymlink(this.rootDir)
    await chmod(this.rootDir, 0o700)
    const root = resolve(this.rootDir)
    const relativeParts = relative.split('/')
    let current = root
    for (const part of relativeParts.slice(0, -1)) {
      current = resolve(current, part)
      await mkdir(current, { recursive: true, mode: 0o700 })
      await this.assertNotSymlink(current)
      await chmod(current, 0o700)
    }
    await this.assertNotSymlink(objectPath)
    return objectPath
  }

  private async ensureDirectory(path: string): Promise<void> {
    const root = resolve(this.rootDir)
    const target = resolve(path)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new ObjectStorageError('OBJECT_KEY_INVALID', '对象目录超出存储根目录', 400)
    await this.safePath(posix.relative(root, target).split(posix.sep).filter(Boolean).concat('_placeholder').join('/'))
    await rm(resolve(target, '_placeholder'), { force: true })
  }

  private async assertNotSymlink(path: string): Promise<void> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new ObjectStorageError('OBJECT_SYMLINK_REJECTED', '对象存储路径不能包含符号链接', 400)
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async removeObject(relative: string): Promise<void> {
    const objectPath = await this.safePath(relative)
    await rm(objectPath, { force: true })
    await rm(`${objectPath}.meta.json`, { force: true })
  }
}

/**
 * S3-compatible implementation. It is intentionally transport-injected: AWS
 * S3, Alibaba OSS, Tencent COS and MinIO can all be used without coupling this
 * package to one provider. Object metadata is stored beside the body under a
 * reserved `.merchant-meta.json` key and is verified on every read.
 */
export class S3CompatibleObjectStorage implements ObjectStoragePort {
  readonly maxObjectBytes: number
  constructor(private readonly transport: CloudObjectTransport, options: { keyPrefix?: string; maxObjectBytes?: number } = {}) {
    this.keyPrefix = validateKeyPrefix(options.keyPrefix)
    this.maxObjectBytes = options.maxObjectBytes ?? 50 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxObjectBytes) || this.maxObjectBytes < 1) throw new ObjectStorageError('OBJECT_LIMIT_INVALID', '对象大小限制无效', 500)
  }
  private readonly keyPrefix: string
  private objectKey(key: string) { return this.keyPrefix ? `${this.keyPrefix}/${key}` : key }
  private metadataKey(key: string) { return `${this.objectKey(key)}.merchant-meta.json` }

  async putQuarantine(input: PutQuarantineObjectInput): Promise<ObjectMetadata> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const assetId = requireId(input.assetId, 'assetId')
    const fileName = safeFileName(input.fileName)
    const contentType = requireContentType(input.contentType)
    const expectedSha256 = requireSha(input.expectedSha256, 'expectedSha256')
    if (!(input.body instanceof Uint8Array)) throw new ObjectStorageError('OBJECT_BODY_INVALID', '对象内容必须是二进制 Uint8Array', 400)
    if (input.body.byteLength > this.maxObjectBytes) throw new ObjectStorageError('OBJECT_TOO_LARGE', `对象不能超过 ${this.maxObjectBytes} bytes`, 413)
    if (input.expectedSizeBytes !== undefined && (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes !== input.body.byteLength)) throw new ObjectStorageError('OBJECT_SIZE_MISMATCH', '对象大小与声明不一致', 400)
    const digest = sha256(input.body)
    if (expectedSha256 && expectedSha256 !== digest) throw new ObjectStorageError('OBJECT_DIGEST_MISMATCH', '对象 SHA-256 与声明不一致', 400)
    const key = `quarantine/${workspaceId}/${assetId}/${fileName}`
    return this.writeObject({ key, workspaceId, zone: 'quarantine', contentType, body: input.body, sha256: digest })
  }

  async list(workspaceId: string): Promise<readonly ObjectMetadata[]> {
    const scope = requireId(workspaceId, 'workspaceId')
    if (!this.transport.list) throw new ObjectStorageError('OBJECT_LIST_UNSUPPORTED', '对象存储未提供清单能力', 503)
    const result: ObjectMetadata[] = []
    for (const zone of ['quarantine', 'clean'] as const) {
      const providerPrefix = this.objectKey(`${zone}/${scope}/`)
      const keys = await this.transport.list(providerPrefix)
      for (const providerKey of keys) {
        if (!providerKey.endsWith('.merchant-meta.json')) continue
        const logicalKey = this.keyPrefix && providerKey.startsWith(`${this.keyPrefix}/`)
          ? providerKey.slice(this.keyPrefix.length + 1, -'.merchant-meta.json'.length)
          : providerKey.slice(0, -'.merchant-meta.json'.length)
        result.push(await this.readMetadata(scope, logicalKey))
      }
    }
    return result.sort((left, right) => left.key.localeCompare(right.key))
  }

  async head(workspaceId: string, key: string, options: { includeQuarantine?: boolean } = {}): Promise<ObjectMetadata | null> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    this.assertReadableZone(parsed.zone, options.includeQuarantine === true)
    try { return await this.readMetadata(workspaceId, parsed.relative) } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') return null
      throw error
    }
  }

  async get(workspaceId: string, key: string, options: { includeQuarantine?: boolean } = {}): Promise<StoredObject> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    this.assertReadableZone(parsed.zone, options.includeQuarantine === true)
    const metadata = await this.readMetadata(workspaceId, parsed.relative)
    let result: { body: Uint8Array }
    try { result = await this.transport.get(this.objectKey(parsed.relative)) } catch (error) { throw cloudStorageError(error) }
    this.verifyBody(metadata, result.body)
    return { metadata, body: result.body }
  }

  async copyQuarantineToClean(input: CopyQuarantineToCleanInput): Promise<ObjectMetadata> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const evidence = requireScanEvidence(input.scanEvidenceRef)
    const expectedSha256 = requireSha(input.expectedSha256, 'expectedSha256')!
    const expectedSizeBytes = requireExpectedSize(input.expectedSizeBytes)
    const { sourceKey, targetKey } = cleanKeyForQuarantine(workspaceId, input.quarantineKey)
    const existingTarget = await this.head(workspaceId, targetKey, { includeQuarantine: true })
    if (existingTarget) {
      let verifiedTarget: StoredObject
      try {
        verifiedTarget = await this.get(workspaceId, targetKey, { includeQuarantine: true })
      } catch (error) {
        if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') throw new ObjectStorageError('OBJECT_INTEGRITY_FAILED', 'clean 对象元数据存在但内容缺失，需要存储修复', 500)
        throw error
      }
      assertPromotionEvidence(verifiedTarget.metadata, expectedSha256, expectedSizeBytes, evidence)
      try {
        const sourceObject = await this.get(workspaceId, sourceKey, { includeQuarantine: true })
        assertPromotionEvidence(sourceObject.metadata, expectedSha256, expectedSizeBytes)
        if (sourceObject.metadata.contentType !== verifiedTarget.metadata.contentType) throw new ObjectStorageError('OBJECT_PROMOTION_CONFLICT', '已有 clean 对象与 quarantine 源内容不一致，已保留源对象并阻止晋级', 409)
      } catch (error) {
        if (!(error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND')) throw error
      }
      return verifiedTarget.metadata
    }
    const sourceObject = await this.get(workspaceId, sourceKey, { includeQuarantine: true })
    assertPromotionEvidence(sourceObject.metadata, expectedSha256, expectedSizeBytes)
    const target = await this.writeObject({ key: targetKey, workspaceId, zone: 'clean', contentType: sourceObject.metadata.contentType, body: sourceObject.body, sha256: sourceObject.metadata.sha256, scanEvidenceRef: evidence })
    const verifiedTarget = await this.get(workspaceId, target.key, { includeQuarantine: true })
    assertPromotionEvidence(verifiedTarget.metadata, expectedSha256, expectedSizeBytes, evidence)
    return target
  }

  async deleteQuarantineAfterCommit(input: DeleteQuarantineAfterCommitInput): Promise<void> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const evidence = requireScanEvidence(input.scanEvidenceRef)
    const expectedSha256 = requireSha(input.expectedSha256, 'expectedSha256')!
    const expectedSizeBytes = requireExpectedSize(input.expectedSizeBytes)
    const { sourceKey, targetKey } = cleanKeyForQuarantine(workspaceId, input.quarantineKey)
    const target = await this.get(workspaceId, targetKey, { includeQuarantine: true })
    assertPromotionEvidence(target.metadata, expectedSha256, expectedSizeBytes, evidence)
    let sourceMetadata: ObjectMetadata | null = null
    try { sourceMetadata = await this.readMetadata(workspaceId, sourceKey) } catch (error) {
      if (!(error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND')) throw error
    }
    if (sourceMetadata) assertPromotionEvidence(sourceMetadata, expectedSha256, expectedSizeBytes)
    let sourceBody: Uint8Array | null = null
    try { sourceBody = (await this.transport.get(this.objectKey(sourceKey))).body } catch (error) {
      if (!isCloudNotFound(error)) throw cloudStorageError(error)
    }
    if (sourceBody && (sourceBody.byteLength !== expectedSizeBytes || sha256(sourceBody) !== expectedSha256)) {
      throw new ObjectStorageError('OBJECT_PROMOTION_EVIDENCE_MISMATCH', '隔离源内容与提交证据不一致', 409)
    }
    if (!sourceMetadata && !sourceBody) return
    await this.delete(workspaceId, sourceKey, { includeQuarantine: true })
  }

  async promoteClean(input: PromoteCleanObjectInput): Promise<ObjectMetadata> {
    const workspaceId = requireId(input.workspaceId, 'workspaceId')
    const evidence = requireScanEvidence(input.scanEvidenceRef)
    const { sourceKey, targetKey } = cleanKeyForQuarantine(workspaceId, input.quarantineKey)
    let source: StoredObject
    try {
      source = await this.get(workspaceId, sourceKey, { includeQuarantine: true })
    } catch (error) {
      if (!(error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND')) throw error
      const target = await this.get(workspaceId, targetKey, { includeQuarantine: true })
      if (target.metadata.scanEvidenceRef !== evidence) throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', 'clean 对象已由不同扫描证据提升', 409)
      await this.deleteQuarantineAfterCommit({ ...input, expectedSha256: target.metadata.sha256, expectedSizeBytes: target.metadata.sizeBytes })
      return target.metadata
    }
    const existingTarget = await this.head(workspaceId, targetKey, { includeQuarantine: true })
    if (existingTarget?.scanEvidenceRef !== undefined && existingTarget.scanEvidenceRef !== evidence) throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', 'clean 对象已由不同扫描证据提升', 409)
    const phaseInput = { ...input, expectedSha256: source.metadata.sha256, expectedSizeBytes: source.metadata.sizeBytes }
    let target: ObjectMetadata
    try { target = await this.copyQuarantineToClean(phaseInput) } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_PROMOTION_EVIDENCE_MISMATCH' && existingTarget) throw new ObjectStorageError('OBJECT_PROMOTION_CONFLICT', '已有 clean 对象与 quarantine 源内容不一致，已保留源对象并阻止晋级', 409)
      throw error
    }
    await this.deleteQuarantineAfterCommit(phaseInput)
    return target
  }

  async delete(workspaceId: string, key: string, options: { includeQuarantine?: boolean } = {}): Promise<void> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    this.assertReadableZone(parsed.zone, options.includeQuarantine === true)
    // Deletion is intentionally idempotent so orphan cleanup converges after
    // a previous attempt deleted either the body or its metadata successfully.
    try { await this.transport.delete(this.objectKey(parsed.relative)) } catch (error) {
      if (!isCloudNotFound(error)) throw cloudStorageError(error)
    }
    try { await this.transport.delete(this.metadataKey(parsed.relative)) } catch (error) {
      if (!isCloudNotFound(error)) throw cloudStorageError(error)
    }
  }

  private assertReadableZone(zone: ObjectZone, includeQuarantine: boolean) { if (zone === 'quarantine' && !includeQuarantine) throw new ObjectStorageError('QUARANTINE_ACCESS_DENIED', '隔离区素材未经扫描，不允许读取', 403) }
  private async readMetadata(workspaceId: string, key: string): Promise<ObjectMetadata> {
    const parsed = requireKeyForWorkspace(workspaceId, key)
    let item: { body: Uint8Array }
    try { item = await this.transport.get(this.metadataKey(parsed.relative)) } catch (error) { throw cloudStorageError(error) }
    try {
      const metadata = JSON.parse(new TextDecoder().decode(item.body)) as Partial<ObjectMetadata>
      if (metadata.key !== parsed.relative || metadata.workspaceId !== workspaceId || metadata.zone !== parsed.zone || typeof metadata.sha256 !== 'string' || !SHA256.test(metadata.sha256) || typeof metadata.sizeBytes !== 'number' || !Number.isSafeInteger(metadata.sizeBytes) || typeof metadata.contentType !== 'string' || typeof metadata.createdAt !== 'string') throw new ObjectStorageError('OBJECT_METADATA_INVALID', '对象元数据损坏', 500)
      return metadata as ObjectMetadata
    } catch (error) { if (error instanceof ObjectStorageError) throw error; throw new ObjectStorageError('OBJECT_METADATA_INVALID', '无法读取对象元数据', 500) }
  }
  private async writeObject(input: { key: string; workspaceId: string; zone: ObjectZone; contentType: string; body: Uint8Array; sha256: string; scanEvidenceRef?: string }): Promise<ObjectMetadata> {
    const parsed = requireKeyForWorkspace(input.workspaceId, input.key, input.zone)
    const metadata: ObjectMetadata = { key: parsed.relative, workspaceId: input.workspaceId, zone: input.zone, contentType: input.contentType, sizeBytes: input.body.byteLength, sha256: input.sha256, createdAt: new Date().toISOString(), ...(input.scanEvidenceRef ? { scanEvidenceRef: input.scanEvidenceRef } : {}) }
    const existing = await this.head(input.workspaceId, parsed.relative, { includeQuarantine: true })
    if (existing) {
      const sameImmutableMetadata = existing.sha256 === metadata.sha256
        && existing.sizeBytes === metadata.sizeBytes
        && existing.contentType === metadata.contentType
        && existing.zone === metadata.zone
        && existing.workspaceId === metadata.workspaceId
        && existing.scanEvidenceRef === metadata.scanEvidenceRef
      if (sameImmutableMetadata) {
        try {
          // Metadata alone is not a committed object. Verify the body before
          // acknowledging an idempotent retry so a partial delete cannot turn
          // into a false upload success.
          await this.get(input.workspaceId, parsed.relative, { includeQuarantine: true })
        } catch (error) {
          if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') throw new ObjectStorageError('OBJECT_INTEGRITY_FAILED', '对象元数据存在但内容缺失，需要存储修复', 500)
          throw error
        }
        return existing
      }
      throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', '对象 key 已存在且内容或安全元数据不同', 409)
    }
    const objectKey = this.objectKey(parsed.relative)
    const metadataKey = this.metadataKey(parsed.relative)
    await this.transport.put(objectKey, { body: input.body, contentType: input.contentType, metadata: { sha256: input.sha256, workspaceId: input.workspaceId, zone: input.zone }, ifAbsent: true })
    try {
      await this.transport.put(metadataKey, { body: new TextEncoder().encode(JSON.stringify(metadata)), contentType: 'application/json', metadata: { workspaceId: input.workspaceId, zone: input.zone }, ifAbsent: true })
    } catch (error) {
      // The body has no usable identity until its metadata is durable. Best-effort
      // compensation prevents a provider failure from leaving an unaddressable
      // object that blocks the same asset on retry.
      const cleanup = await Promise.allSettled([this.transport.delete(objectKey), this.transport.delete(metadataKey)])
      const cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
      if (cleanupErrors.length) throw new ObjectStoragePartialWriteError(parsed.relative, error, cleanupErrors)
      throw error
    }
    return metadata
  }
  private verifyBody(metadata: ObjectMetadata, body: Uint8Array) { if (body.byteLength !== metadata.sizeBytes || sha256(body) !== metadata.sha256) throw new ObjectStorageError('OBJECT_INTEGRITY_FAILED', '对象内容完整性校验失败', 500) }
}

function cloudStorageError(error: unknown): ObjectStorageError {
  if (isCloudNotFound(error)) return new ObjectStorageError('OBJECT_NOT_FOUND', '对象不存在', 404)
  return new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '对象存储暂时不可用', 503)
}
