import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudObjectNotFoundError, LocalObjectStorage, ObjectStorageError, S3CompatibleObjectStorage, isRetryableObjectStorageReadError, parseS3CompatibleObjectStorageConfig, type CloudObjectTransport, withObjectStorageReadRetry } from './object-storage.js'

const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex')

describe('object storage read retry policy', () => {
  it('retries transient provider failures and returns the eventual value', async () => {
    let calls = 0
    const value = await withObjectStorageReadRetry(async () => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('provider busy'), { code: 'SlowDown' })
      return 'ok'
    }, { baseDelayMs: 0 })
    expect(value).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry missing, permission, or integrity failures', async () => {
    expect(isRetryableObjectStorageReadError(Object.assign(new Error('missing'), { code: 'NoSuchKey', status: 404 }))).toBe(false)
    expect(isRetryableObjectStorageReadError(Object.assign(new Error('denied'), { name: 'AccessDenied', status: 403 }))).toBe(false)
    expect(isRetryableObjectStorageReadError(new ObjectStorageError('OBJECT_INTEGRITY_FAILED', 'tampered', 500))).toBe(false)
    expect(isRetryableObjectStorageReadError(new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', 'outage', 503))).toBe(true)
    let calls = 0
    await expect(withObjectStorageReadRetry(async () => { calls += 1; throw Object.assign(new Error('missing'), { code: 'NoSuchKey', status: 404 }) }, { baseDelayMs: 0 })).rejects.toMatchObject({ code: 'NoSuchKey' })
    expect(calls).toBe(1)
  })
})

describe('LocalObjectStorage', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

  async function storage() {
    const root = await mkdtemp(join(tmpdir(), 'merchant-object-storage-'))
    roots.push(root)
    return new LocalObjectStorage(root)
  }

  it('uploads binary bytes to quarantine, verifies digest, and only reads after clean promotion', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('brand logo bytes')
    const metadata = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_1', fileName: 'logo.png', contentType: 'image/png', body, expectedSha256: digest(body), expectedSizeBytes: body.byteLength })
    expect(metadata).toMatchObject({ key: 'quarantine/ws_a/asset_1/logo.png', zone: 'quarantine', sizeBytes: body.byteLength, sha256: digest(body) })
    await expect(store.get('ws_a', metadata.key)).rejects.toMatchObject({ code: 'QUARANTINE_ACCESS_DENIED' })
    expect(await store.head('ws_a', metadata.key, { includeQuarantine: true })).toMatchObject({ key: metadata.key })

    await expect(store.promoteClean({ workspaceId: 'ws_a', quarantineKey: metadata.key, scanEvidenceRef: '' })).rejects.toMatchObject({ code: 'SCAN_EVIDENCE_REQUIRED' })
    const clean = await store.promoteClean({ workspaceId: 'ws_a', quarantineKey: metadata.key, scanEvidenceRef: 'scanner://scan-123' })
    expect(clean).toMatchObject({ key: 'clean/ws_a/asset_1/logo.png', zone: 'clean', scanEvidenceRef: 'scanner://scan-123' })
    await expect(store.head('ws_a', metadata.key, { includeQuarantine: true })).resolves.toBeNull()
    await expect(store.get('ws_b', clean.key)).rejects.toMatchObject({ code: 'OBJECT_SCOPE_DENIED' })
    await expect(store.get('ws_a', clean.key)).resolves.toMatchObject({ body, metadata: expect.objectContaining({ zone: 'clean' }) })
  })

  it('rejects mismatched bytes, traversal, oversize objects, and conflicting keys without a partial object', async () => {
    const store = await storage()
    const body = new Uint8Array([1, 2, 3])
    await expect(store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_2', fileName: 'x.bin', contentType: 'application/octet-stream', body, expectedSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'OBJECT_DIGEST_MISMATCH' })
    await expect(store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_2', fileName: '../x.bin', contentType: 'application/octet-stream', body })).rejects.toMatchObject({ code: 'OBJECT_NAME_INVALID' })
    const limited = new LocalObjectStorage(store.rootDir, { maxObjectBytes: 2 })
    await expect(limited.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_2', fileName: 'x.bin', contentType: 'application/octet-stream', body })).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
    const first = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_2', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    await expect(store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_2', fileName: 'x.bin', contentType: 'application/octet-stream', body: new Uint8Array([9]) })).rejects.toMatchObject({ code: 'OBJECT_ALREADY_EXISTS' })
    await expect(store.head('ws_a', 'quarantine/ws_b/asset_2/x.bin', { includeQuarantine: true })).rejects.toMatchObject({ code: 'OBJECT_SCOPE_DENIED' })
    await expect(store.head('ws_a', `quarantine/ws_a/asset_2/${first.key.includes('..') ? 'x' : '../x'}`, { includeQuarantine: true })).rejects.toBeInstanceOf(ObjectStorageError)
  })

  it('detects on-disk tampering instead of returning corrupted bytes', async () => {
    const store = await storage()
    const body = new Uint8Array([7, 8, 9])
    const metadata = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_3', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    await store.promoteClean({ workspaceId: 'ws_a', quarantineKey: metadata.key, scanEvidenceRef: 'scanner://scan-456' })
    await writeFile(join(store.rootDir, 'clean/ws_a/asset_3/x.bin'), new Uint8Array([0]))
    await expect(store.get('ws_a', 'clean/ws_a/asset_3/x.bin')).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_FAILED' })
    await expect(readFile(join(store.rootDir, 'clean/ws_a/asset_3/x.bin'))).resolves.toEqual(Buffer.from([0]))
  })
})

describe('S3CompatibleObjectStorage', () => {
  it('rejects cloud metadata and private IP endpoints in production', () => {
    const base = { bucket: 'merchant-assets', region: 'cn-shanghai', kmsKeyId: 'kms-key-1' }
    for (const endpoint of ['https://169.254.169.254', 'https://10.0.0.5', 'https://[fd00::1]']) {
      expect(() => parseS3CompatibleObjectStorageConfig({ ...base, endpoint })).toThrowError('对象存储 endpoint 不得包含凭证、查询参数或本地地址')
    }
  })

  it('rejects unsafe key prefixes even when the transport is injected directly', () => {
    const transport: CloudObjectTransport = { async head() { return null }, async get() { throw new Error('unused') }, async put() {}, async delete() {} }
    expect(() => new S3CompatibleObjectStorage(transport, { keyPrefix: '../outside' })).toThrowError('对象存储 key 前缀无效')
  })

  it('does not turn cloud permission or outage errors into a false 404', async () => {
    const transport: CloudObjectTransport = {
      async head() { return null },
      async get() { throw Object.assign(new Error('access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }) },
      async put() { throw new Error('unreachable') },
      async delete() { throw new Error('unreachable') },
    }
    const store = new S3CompatibleObjectStorage(transport)
    await expect(store.get('ws_cloud', 'clean/ws_cloud/asset_1/logo.png')).rejects.toMatchObject({ code: 'OBJECT_STORAGE_UNAVAILABLE', status: 503 })
  })

  it('keeps the same quarantine, tenant and integrity contract over a cloud transport', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw Object.assign(new Error('not found'), { code: 'NoSuchKey' }); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { if (input.ifAbsent && objects.has(key)) throw new Error('exists'); objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) { objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('cloud bytes')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_1', fileName: 'logo.png', contentType: 'image/png', body, expectedSha256: digest(body) })
    await expect(store.get('ws_cloud', quarantine.key)).rejects.toMatchObject({ code: 'QUARANTINE_ACCESS_DENIED' })
    const clean = await store.promoteClean({ workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://cloud-1' })
    await expect(store.get('ws_cloud', clean.key)).resolves.toMatchObject({ body, metadata: expect.objectContaining({ zone: 'clean' }) })
    await expect(store.get('ws_other', clean.key)).rejects.toMatchObject({ code: 'OBJECT_SCOPE_DENIED' })
  })

  it('compensates the cloud body when metadata persistence fails', async () => {
    const objects = new Map<string, Uint8Array>()
    const deleted: string[] = []
    const transport: CloudObjectTransport = {
      async head(key) { return objects.has(key) ? { sizeBytes: objects.get(key)?.byteLength } : null },
      async get(key) {
        const body = objects.get(key)
        if (!body) throw new CloudObjectNotFoundError()
        return { body }
      },
      async put(key, input) {
        objects.set(key, input.body)
        if (key.endsWith('.merchant-meta.json')) throw new Error('metadata provider outage')
      },
      async delete(key) { deleted.push(key); objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('rollback me')

    await expect(store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_rollback', fileName: 'x.txt', contentType: 'text/plain', body }))
      .rejects.toThrow('metadata provider outage')
    expect(objects).toHaveLength(0)
    expect(deleted).toEqual([
      'merchant/quarantine/ws_cloud/asset_rollback/x.txt',
      'merchant/quarantine/ws_cloud/asset_rollback/x.txt.merchant-meta.json',
    ])
  })
})
