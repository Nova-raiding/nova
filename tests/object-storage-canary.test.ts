import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ObjectStorageCanaryCleanupError, objectStorageCanaryConfig, runObjectStorageCanary } from '../scripts/object-storage-canary.js'

const uuid = '12345678-1234-4123-8123-123456789abc'
const env = () => ({ NODE_ENV: 'production', OBJECT_STORAGE_CANARY_CONFIRM: 'true', OBJECT_STORAGE_VERSIONING: 'true', RELEASE_ID: '0.1.2', ASSET_STORAGE_ENDPOINT: 'https://merchant.oss-cn-test.aliyuncs.com', ASSET_STORAGE_BUCKET: 'merchant', ASSET_STORAGE_REGION: 'cn-test', ASSET_STORAGE_PREFIX: 'merchant-assets', ASSET_STORAGE_ECS_RAM_ROLE: 'merchant-role', ASSET_STORAGE_SSE_MODE: 'AES256', OBJECT_STORAGE_CANARY_ARTIFACT_ROOT: '/tmp/artifacts', OBJECT_STORAGE_CANARY_EVIDENCE_PATH: '/tmp/evidence.json' })

describe('object storage canary', () => {
  it('fails closed outside production or without explicit confirmation', () => {
    expect(() => objectStorageCanaryConfig({ ...env(), NODE_ENV: 'development' })).toThrow('NODE_ENV_PRODUCTION_REQUIRED')
    expect(() => objectStorageCanaryConfig({ ...env(), OBJECT_STORAGE_CANARY_CONFIRM: 'false' })).toThrow('OBJECT_STORAGE_CANARY_CONFIRM_REQUIRED')
  })

  it('rejects unsafe release IDs, endpoints, and incomplete KMS configuration', () => {
    expect(() => objectStorageCanaryConfig({ ...env(), RELEASE_ID: '../prod' })).toThrow('RELEASE_ID_INVALID')
    expect(() => objectStorageCanaryConfig({ ...env(), ASSET_STORAGE_ENDPOINT: 'http://oss.example.test' })).toThrow('ASSET_STORAGE_ENDPOINT_INVALID')
    expect(() => objectStorageCanaryConfig({ ...env(), ASSET_STORAGE_SSE_MODE: 'aws:kms' })).toThrow('ASSET_STORAGE_KMS_KEY_ID_REQUIRED')
  })

  it('runs exact scoped PUT/HEAD/GET/encryption/delete and writes redacted immutable evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oss-canary-'))
    const payload = new TextEncoder().encode('canary payload')
    const commands: any[] = []
    const client = { send: vi.fn(async (command: any) => {
      commands.push(command)
      const name = command.constructor.name
      if (name === 'HeadObjectCommand') return { ContentLength: payload.byteLength, ServerSideEncryption: 'AES256' }
      if (name === 'GetObjectCommand') return { Body: { transformToByteArray: async () => payload } }
      if (name === 'PutObjectCommand') return { VersionId: 'version-1' }
      return {}
    }) }
    const evidence = await runObjectStorageCanary({ client, bucket: 'merchant', endpoint: 'https://oss.example.test', region: 'cn-test', releaseId: '0.1.2', encryption: 'AES256', artifactRoot: join(root, 'artifacts'), evidencePath: join(root, 'evidence.json'), uuid: () => uuid, payload, now: () => new Date('2026-09-14T10:00:00Z') })
    expect(commands.map(command => command.constructor.name)).toEqual(['PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand'])
    expect(commands.every(command => command.input.Key === `merchant-assets/canary/0.1.2/${uuid}/probe.bin`)).toBe(true)
    expect(commands.at(-1).input.VersionId).toBe('version-1')
    expect(evidence.checks.map(check => check.id)).toEqual(['put', 'head', 'get_hash', 'encryption', 'delete'])
    expect(evidence.artifact_ref).toMatch(/^artifact:\/\/production\/object-storage\/0\.1\.2\/.+#[a-f0-9]{64}$/u)
    const serialized = readFileSync(join(root, 'evidence.json'), 'utf8')
    expect(serialized).not.toContain('merchant-role')
    expect(serialized).not.toMatch(/access.?key|secret.?key|session.?token/iu)
  })

  it('attempts cleanup of only the exact random key after a failed read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oss-canary-fail-'))
    const keys: string[] = []
    const client = { send: vi.fn(async (command: any) => {
      keys.push(command.input.Key)
      if (command.constructor.name === 'HeadObjectCommand') throw new Error('head failed')
      if (command.constructor.name === 'PutObjectCommand') return { VersionId: 'version-1' }
      return {}
    }) }
    await expect(runObjectStorageCanary({ client, bucket: 'merchant', endpoint: 'https://oss.example.test', region: 'cn-test', releaseId: '0.1.2', encryption: 'AES256', artifactRoot: join(root, 'artifacts'), evidencePath: join(root, 'evidence.json'), uuid: () => uuid })).rejects.toThrow('head failed')
    expect(keys).toEqual([`merchant-assets/canary/0.1.2/${uuid}/probe.bin`, `merchant-assets/canary/0.1.2/${uuid}/probe.bin`, `merchant-assets/canary/0.1.2/${uuid}/probe.bin`])
  })

  it('separates a successful data path from an exact-version cleanup permission failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oss-canary-cleanup-fail-'))
    const payload = new TextEncoder().encode('canary payload')
    const client = { send: vi.fn(async (command: any) => {
      const name = command.constructor.name
      if (name === 'PutObjectCommand') return { VersionId: 'version-1' }
      if (name === 'HeadObjectCommand') return { ContentLength: payload.byteLength, ServerSideEncryption: 'AES256' }
      if (name === 'GetObjectCommand') return { Body: { transformToByteArray: async () => payload } }
      if (name === 'DeleteObjectCommand') throw new Error('AccessDenied: oss:DeleteObjectVersion')
      return {}
    }) }

    const failure = await runObjectStorageCanary({ client, bucket: 'merchant', endpoint: 'https://oss.example.test', region: 'cn-test', releaseId: '0.1.2', encryption: 'AES256', artifactRoot: join(root, 'artifacts'), evidencePath: join(root, 'evidence.json'), uuid: () => uuid, payload }).catch(error => error)
    expect(failure).toBeInstanceOf(ObjectStorageCanaryCleanupError)
    expect(failure).toMatchObject({
      code: 'OBJECT_STORAGE_CANARY_CLEANUP_FAILED', phase: 'cleanup', dataPathState: 'passed', cleanupState: 'failed',
      cleanupTarget: { bucket: 'merchant', key: `merchant-assets/canary/0.1.2/${uuid}/probe.bin`, version_id: 'version-1' },
      completedChecks: [{ id: 'put', state: 'passed' }, { id: 'head', state: 'passed' }, { id: 'get_hash', state: 'passed' }, { id: 'encryption', state: 'passed' }],
    })
    expect(client.send.mock.calls.at(-1)?.[0].input).toMatchObject({ Key: `merchant-assets/canary/0.1.2/${uuid}/probe.bin`, VersionId: 'version-1' })
  })

  it('blocks with an orphan warning and never issues an unversioned delete when PUT omits VersionId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oss-canary-no-version-'))
    const client = { send: vi.fn(async (command: any) => command.constructor.name === 'PutObjectCommand' ? {} : {}) }
    const failure = await runObjectStorageCanary({ client, bucket: 'merchant', endpoint: 'https://oss.example.test', region: 'cn-test', releaseId: '0.1.2', encryption: 'AES256', artifactRoot: join(root, 'artifacts'), evidencePath: join(root, 'evidence.json'), uuid: () => uuid }).catch(error => error)
    expect(failure).toBeInstanceOf(ObjectStorageCanaryCleanupError)
    expect(failure).toMatchObject({ dataPathState: 'failed', cleanupState: 'failed', cleanupTarget: { version_id: null } })
    expect((failure as ObjectStorageCanaryCleanupError).cause).toMatchObject({ message: 'OBJECT_VERSION_ID_MISSING_EXACT_CLEANUP_UNAVAILABLE' })
    expect(client.send).toHaveBeenCalledTimes(1)
  })
})
