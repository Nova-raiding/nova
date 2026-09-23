import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createAliyunEcsRoleCredentials } from '../apps/api/src/aliyun-ecs-role-credentials.js'

type S3Sender = { send(command: unknown): Promise<any> }

export class ObjectStorageCanaryCleanupError extends Error {
  readonly code = 'OBJECT_STORAGE_CANARY_CLEANUP_FAILED'
  readonly phase = 'cleanup'
  readonly dataPathState: 'passed' | 'failed'
  readonly cleanupState = 'failed'
  readonly completedChecks: ObjectStorageCanaryEvidence['checks']
  readonly cleanupTarget: { bucket: string; key: string; version_id: string | null }

  constructor(input: {
    cause: unknown
    primaryError?: unknown
    checks: ObjectStorageCanaryEvidence['checks']
    bucket: string
    key: string
    versionId?: string
  }) {
    super('OBJECT_STORAGE_CANARY_CLEANUP_FAILED', { cause: input.cause })
    this.name = 'ObjectStorageCanaryCleanupError'
    this.dataPathState = input.primaryError ? 'failed' : 'passed'
    this.completedChecks = [...input.checks]
    this.cleanupTarget = { bucket: input.bucket, key: input.key, version_id: input.versionId ?? null }
  }
}

export type ObjectStorageCanaryEvidence = {
  schema_version: '1'
  state: 'ready'
  release_id: string
  environment: 'production'
  simulated: false
  provider: 'aliyun-oss'
  bucket: string
  endpoint: string
  region: string
  canary_prefix: string
  object_key_sha256: string
  payload_sha256: string
  encryption: 'AES256' | 'aws:kms'
  checks: Array<{ id: 'put' | 'head' | 'get_hash' | 'encryption' | 'delete' | 'delete_verified'; state: 'passed' }>
  observed_at: string
  artifact_ref?: string
}

function required(source: NodeJS.ProcessEnv, key: string) {
  const value = source[key]?.trim()
  if (!value) throw new Error(`${key}_REQUIRED`)
  return value
}

function canaryKeyPrefix(value: string) {
  const prefix = value.trim().replace(/^\/+|\/+$/gu, '')
  const parts = prefix.split('/')
  if (!prefix || prefix.length > 128 || parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/u.test(part))) throw new Error('ASSET_STORAGE_PREFIX_INVALID')
  return prefix
}

export function objectStorageCanaryConfig(source: NodeJS.ProcessEnv) {
  if (source.NODE_ENV?.trim() !== 'production') throw new Error('NODE_ENV_PRODUCTION_REQUIRED')
  if (source.OBJECT_STORAGE_CANARY_CONFIRM?.trim() !== 'true') throw new Error('OBJECT_STORAGE_CANARY_CONFIRM_REQUIRED')
  if (source.OBJECT_STORAGE_VERSIONING?.trim() !== 'true') throw new Error('OBJECT_STORAGE_VERSIONING_REQUIRED')
  const releaseId = required(source, 'RELEASE_ID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) throw new Error('RELEASE_ID_INVALID')
  const endpoint = required(source, 'ASSET_STORAGE_ENDPOINT')
  const parsedEndpoint = new URL(endpoint)
  if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) throw new Error('ASSET_STORAGE_ENDPOINT_INVALID')
  const mode = (source.ASSET_STORAGE_SSE_MODE?.trim() || 'AES256').toLowerCase()
  if (!['aes256', 'aws:kms'].includes(mode)) throw new Error('ASSET_STORAGE_SSE_MODE_INVALID')
  const kmsKeyId = source.ASSET_STORAGE_KMS_KEY_ID?.trim()
  if (mode === 'aws:kms' && !kmsKeyId) throw new Error('ASSET_STORAGE_KMS_KEY_ID_REQUIRED')
  return {
    releaseId,
    bucket: required(source, 'ASSET_STORAGE_BUCKET'),
    region: required(source, 'ASSET_STORAGE_REGION'),
    endpoint: parsedEndpoint.toString().replace(/\/$/u, ''),
    roleName: required(source, 'ASSET_STORAGE_ECS_RAM_ROLE'),
    keyPrefix: canaryKeyPrefix(required(source, 'ASSET_STORAGE_PREFIX')),
    encryption: mode === 'aws:kms' ? 'aws:kms' as const : 'AES256' as const,
    kmsKeyId,
    forcePathStyle: source.ASSET_STORAGE_FORCE_PATH_STYLE === 'true',
    artifactRoot: required(source, 'OBJECT_STORAGE_CANARY_ARTIFACT_ROOT'),
    evidencePath: required(source, 'OBJECT_STORAGE_CANARY_EVIDENCE_PATH'),
  }
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray()
  if (body instanceof Uint8Array) return body
  throw new Error('GET_BODY_INVALID')
}

export async function runObjectStorageCanary(input: {
  client: S3Sender
  bucket: string
  endpoint: string
  region: string
  releaseId: string
  encryption: 'AES256' | 'aws:kms'
  kmsKeyId?: string
  artifactRoot: string
  evidencePath: string
  now?: () => Date
  uuid?: () => string
  payload?: Uint8Array
  keyPrefix?: string
}): Promise<ObjectStorageCanaryEvidence> {
  const runId = (input.uuid ?? randomUUID)()
  if (!/^[a-f0-9-]{36}$/iu.test(runId)) throw new Error('CANARY_RUN_ID_INVALID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.releaseId)) throw new Error('RELEASE_ID_INVALID')
  const keyPrefix = canaryKeyPrefix(input.keyPrefix ?? 'merchant-assets')
  const prefix = `${keyPrefix}/canary/${input.releaseId}/${runId}/`
  const key = `${prefix}probe.bin`
  const payload = input.payload ?? randomBytes(64)
  const payloadHash = createHash('sha256').update(payload).digest('hex')
  const checks: ObjectStorageCanaryEvidence['checks'] = []
  let putAttempted = false
  let versionId: string | undefined
  let primaryError: unknown
  try {
    putAttempted = true
    const put = await input.client.send(new PutObjectCommand({ Bucket: input.bucket, Key: key, Body: payload, ContentType: 'application/octet-stream', Metadata: { canary: 'true', release: input.releaseId }, ServerSideEncryption: input.encryption, ...(input.encryption === 'aws:kms' ? { SSEKMSKeyId: input.kmsKeyId } : {}) }))
    versionId = typeof put.VersionId === 'string' && put.VersionId ? put.VersionId : undefined
    if (!versionId) throw new Error('OBJECT_VERSION_ID_MISSING')
    checks.push({ id: 'put', state: 'passed' })
    const head = await input.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key, VersionId: versionId }))
    if (head.VersionId !== versionId) throw new Error('HEAD_VERSION_ID_MISMATCH')
    if (Number(head.ContentLength) !== payload.byteLength) throw new Error('HEAD_CONTENT_LENGTH_MISMATCH')
    checks.push({ id: 'head', state: 'passed' })
    const get = await input.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: key, VersionId: versionId }))
    if (get.VersionId !== versionId) throw new Error('GET_VERSION_ID_MISMATCH')
    const downloadedHash = createHash('sha256').update(await bodyBytes(get.Body)).digest('hex')
    if (downloadedHash !== payloadHash) throw new Error('GET_HASH_MISMATCH')
    checks.push({ id: 'get_hash', state: 'passed' })
    if (head.ServerSideEncryption !== input.encryption) throw new Error('SERVER_SIDE_ENCRYPTION_MISMATCH')
    if (input.encryption === 'aws:kms' && input.kmsKeyId && head.SSEKMSKeyId !== input.kmsKeyId) throw new Error('KMS_KEY_MISMATCH')
    checks.push({ id: 'encryption', state: 'passed' })
  } catch (error) {
    primaryError = error
  } finally {
    // A versioned bucket must only be cleaned by exact VersionId. Deleting
    // without it creates a delete marker and can leave the uploaded version
    // behind, so a missing VersionId is treated as an explicit cleanup block.
    if (putAttempted && !versionId) {
      throw new ObjectStorageCanaryCleanupError({ cause: new Error('OBJECT_VERSION_ID_MISSING_EXACT_CLEANUP_UNAVAILABLE'), ...(primaryError ? { primaryError } : {}), checks, bucket: input.bucket, key })
    }
    if (putAttempted && versionId) {
      try {
        const deleted = await input.client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: key, VersionId: versionId }))
        if (deleted.DeleteMarker === true) throw new Error('DELETE_CREATED_MARKER')
        checks.push({ id: 'delete', state: 'passed' })
        try {
          await input.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key, VersionId: versionId }))
          throw new Error('OBJECT_VERSION_STILL_READABLE_AFTER_DELETE')
        } catch (verificationError) {
          const status = (verificationError as { $metadata?: { httpStatusCode?: unknown } })?.$metadata?.httpStatusCode
          if (status !== 404) throw verificationError
        }
        checks.push({ id: 'delete_verified', state: 'passed' })
      } catch (cleanupError) {
        throw new ObjectStorageCanaryCleanupError({ cause: cleanupError, ...(primaryError ? { primaryError } : {}), checks, bucket: input.bucket, key, versionId })
      }
    }
  }
  if (primaryError) throw primaryError
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  const evidence: ObjectStorageCanaryEvidence = {
    schema_version: '1', state: 'ready', release_id: input.releaseId, environment: 'production', simulated: false,
    provider: 'aliyun-oss', bucket: input.bucket, endpoint: input.endpoint, region: input.region, canary_prefix: prefix,
    object_key_sha256: createHash('sha256').update(key).digest('hex'), payload_sha256: payloadHash,
    encryption: input.encryption, checks, observed_at: observedAt,
  }
  const artifactBody = JSON.stringify({ ...evidence, artifact_ref: undefined }, null, 2) + '\n'
  const artifactHash = createHash('sha256').update(artifactBody).digest('hex')
  const artifactTarget = resolve(input.artifactRoot, 'object-storage', input.releaseId, `${runId}.json`)
  mkdirSync(dirname(artifactTarget), { recursive: true, mode: 0o700 })
  writeFileSync(artifactTarget, artifactBody, { mode: 0o600, flag: 'wx' })
  evidence.artifact_ref = `artifact://production/${relative(resolve(input.artifactRoot), artifactTarget).split('\\').join('/')}#${artifactHash}`
  mkdirSync(dirname(resolve(input.evidencePath)), { recursive: true, mode: 0o700 })
  writeFileSync(resolve(input.evidencePath), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return evidence
}

export async function main() {
  try {
    const config = objectStorageCanaryConfig(process.env)
    const client = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle, credentials: createAliyunEcsRoleCredentials(config.roleName) })
    const evidence = await runObjectStorageCanary({ client, ...config })
    console.log(JSON.stringify(evidence, null, 2))
  } catch (error) {
    const cleanup = error instanceof ObjectStorageCanaryCleanupError ? {
      phase: error.phase,
      data_path_state: error.dataPathState,
      cleanup_state: error.cleanupState,
      completed_checks: error.completedChecks,
      orphan_possible: true,
      cleanup_target: error.cleanupTarget,
      cleanup_error: error.cause instanceof Error ? error.cause.message : 'DELETE_OBJECT_VERSION_FAILED',
    } : undefined
    console.error(JSON.stringify({ state: 'blocked', reason: error instanceof Error ? error.message : 'OBJECT_STORAGE_CANARY_FAILED', ...(cleanup ?? {}) }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
