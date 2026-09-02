import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudObjectNotFoundError, LocalObjectStorage, ObjectStorageError, ObjectStoragePartialWriteError, S3CompatibleObjectStorage, isRetryableObjectStorageReadError, parseS3CompatibleObjectStorageConfig, type CloudObjectTransport, withObjectStorageCleanupRetry, withObjectStorageReadRetry } from './object-storage.js'

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

  it('rejects unsafe retry schedules before invoking storage', async () => {
    const operation = vi.fn(async () => 'ok')
    await expect(withObjectStorageReadRetry(operation, { baseDelayMs: Number.NaN })).rejects.toMatchObject({ code: 'OBJECT_RETRY_CONFIG_INVALID' })
    await expect(withObjectStorageReadRetry(operation, { baseDelayMs: 1.5 })).rejects.toMatchObject({ code: 'OBJECT_RETRY_CONFIG_INVALID' })
    await expect(withObjectStorageReadRetry(operation, { baseDelayMs: 60_001 })).rejects.toMatchObject({ code: 'OBJECT_RETRY_CONFIG_INVALID' })
    expect(operation).not.toHaveBeenCalled()
  })
})

describe('object storage cleanup retry policy', () => {
  it('retries only transient, idempotent cleanup failures', async () => {
    let calls = 0
    await expect(withObjectStorageCleanupRetry(async () => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('provider busy'), { code: 'SlowDown' })
    }, { baseDelayMs: 0, attempts: 3 })).resolves.toBeUndefined()
    expect(calls).toBe(3)
  })

  it('does not retry a missing object or unsafe configuration', async () => {
    let calls = 0
    await expect(withObjectStorageCleanupRetry(async () => {
      calls += 1
      throw new CloudObjectNotFoundError()
    }, { baseDelayMs: 0, attempts: 3 })).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    expect(calls).toBe(1)
    const operation = vi.fn(async () => undefined)
    await expect(withObjectStorageCleanupRetry(operation, { attempts: 0 })).rejects.toMatchObject({ code: 'OBJECT_RETRY_CONFIG_INVALID' })
    expect(operation).not.toHaveBeenCalled()
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

  it('canonicalizes filename case so local and cloud object keys have identical identity', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('case portable')
    const first = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_case', fileName: 'Logo.PNG', contentType: 'IMAGE/PNG', body })
    const replay = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_case', fileName: 'logo.png', contentType: 'image/png', body })
    expect(first.key).toBe('quarantine/ws_a/asset_case/logo.png')
    expect(replay).toEqual(first)
  })

  it('copies locally without deleting quarantine, then performs evidence-bound idempotent cleanup', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('two phase local bytes')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_two_phase', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    const input = { workspaceId: 'ws_a', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://receipt-local', expectedSha256: digest(body), expectedSizeBytes: body.byteLength }

    const first = await store.copyQuarantineToClean(input)
    const second = await store.copyQuarantineToClean(input)
    expect(second).toEqual(first)
    await expect(store.get('ws_a', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body })
    await expect(store.get('ws_a', first.key)).resolves.toMatchObject({ body })

    await expect(store.deleteQuarantineAfterCommit({ ...input, expectedSizeBytes: body.byteLength + 1 })).rejects.toMatchObject({ code: 'OBJECT_PROMOTION_EVIDENCE_MISMATCH' })
    await expect(store.get('ws_a', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body })
    await expect(store.deleteQuarantineAfterCommit(input)).resolves.toBeUndefined()
    await expect(store.deleteQuarantineAfterCommit(input)).resolves.toBeUndefined()
    await expect(store.head('ws_a', quarantine.key, { includeQuarantine: true })).resolves.toBeNull()
  })

  it('rejects cross-tenant and corrupt local copy retries while preserving quarantine', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('local source survives')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_local_failure', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    const input = { workspaceId: 'ws_a', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://receipt-local-failure', expectedSha256: digest(body), expectedSizeBytes: body.byteLength }
    const clean = await store.copyQuarantineToClean(input)
    await writeFile(join(store.rootDir, clean.key), new TextEncoder().encode('corrupt'))

    await expect(store.copyQuarantineToClean({ ...input, workspaceId: 'ws_b' })).rejects.toMatchObject({ code: 'OBJECT_SCOPE_DENIED' })
    await expect(store.copyQuarantineToClean(input)).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_FAILED' })
    await expect(store.get('ws_a', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body })
  })

  it('makes local clean and quarantine deletion idempotent', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('delete locally')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_delete', fileName: 'x.txt', contentType: 'text/plain', body })

    await expect(store.delete('ws_a', quarantine.key)).rejects.toMatchObject({ code: 'QUARANTINE_ACCESS_DENIED' })
    await expect(store.delete('ws_a', quarantine.key, { includeQuarantine: true })).resolves.toBeUndefined()
    await expect(store.delete('ws_a', quarantine.key, { includeQuarantine: true })).resolves.toBeUndefined()

    const second = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_delete_clean', fileName: 'x.txt', contentType: 'text/plain', body })
    const clean = await store.promoteClean({ workspaceId: 'ws_a', quarantineKey: second.key, scanEvidenceRef: 'scanner://delete-local' })
    await expect(store.delete('ws_a', clean.key)).resolves.toBeUndefined()
    await expect(store.delete('ws_a', clean.key)).resolves.toBeUndefined()
    await expect(store.head('ws_a', clean.key)).resolves.toBeNull()
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

  it('reports a typed not-found error when metadata outlives the object body', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('durable asset bytes')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_orphaned', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    const clean = await store.promoteClean({ workspaceId: 'ws_a', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://scan-orphaned' })
    await rm(join(store.rootDir, clean.key))

    await expect(store.get('ws_a', clean.key)).rejects.toMatchObject({
      name: 'ObjectStorageError',
      code: 'OBJECT_NOT_FOUND',
      status: 404,
      message: '对象不存在',
    })
  })

  it('does not acknowledge a local idempotent upload when only metadata remains', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('metadata without body')
    const uploaded = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_partial', fileName: 'x.txt', contentType: 'text/plain', body })
    await rm(join(store.rootDir, uploaded.key))

    await expect(store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_partial', fileName: 'x.txt', contentType: 'text/plain', body }))
      .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_FAILED', status: 500 })
  })

  it('fails closed when a clean metadata record loses or corrupts scanner evidence', async () => {
    const store = await storage()
    const body = new TextEncoder().encode('evidence-bound clean object')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_a', assetId: 'asset_evidence', fileName: 'x.txt', contentType: 'text/plain', body })
    const clean = await store.promoteClean({ workspaceId: 'ws_a', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://evidence-bound' })
    const metadataPath = join(store.rootDir, `${clean.key}.meta.json`)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>

    for (const value of ['', 'scanner://bad\nheader']) {
      await writeFile(metadataPath, JSON.stringify({ ...metadata, scanEvidenceRef: value }))
      await expect(store.get('ws_a', clean.key)).rejects.toMatchObject({ code: 'SCAN_EVIDENCE_REQUIRED', status: 400 })
    }
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

  it('fails closed when a cloud clean metadata record has no scanner evidence', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) { objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('cloud evidence')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_evidence', fileName: 'x.txt', contentType: 'text/plain', body })
    const clean = await store.promoteClean({ workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://cloud-evidence' })
    const metadataKey = `merchant/${clean.key}.merchant-meta.json`
    const existing = objects.get(metadataKey)!
    const metadata = JSON.parse(new TextDecoder().decode(existing.body)) as Record<string, unknown>
    objects.set(metadataKey, { ...existing, body: new TextEncoder().encode(JSON.stringify({ ...metadata, scanEvidenceRef: '' })) })
    await expect(store.get('ws_cloud', clean.key)).rejects.toMatchObject({ code: 'SCAN_EVIDENCE_REQUIRED', status: 400 })
  })

  it('copies in S3 without source deletion and makes post-commit cleanup converge after a partial delete', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    let failMetadataDelete = true
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) {
        if (key.endsWith('.merchant-meta.json') && key.includes('/quarantine/') && failMetadataDelete) {
          failMetadataDelete = false
          throw new Error('transient metadata delete failure')
        }
        objects.delete(key)
      },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('two phase cloud bytes')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_two_phase', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    const input = { workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://receipt-cloud', expectedSha256: digest(body), expectedSizeBytes: body.byteLength }

    const first = await store.copyQuarantineToClean(input)
    await expect(store.copyQuarantineToClean(input)).resolves.toEqual(first)
    expect(objects.has(`merchant/${quarantine.key}`)).toBe(true)
    expect(objects.has(`merchant/${quarantine.key}.merchant-meta.json`)).toBe(true)

    await expect(store.deleteQuarantineAfterCommit(input)).rejects.toMatchObject({ code: 'OBJECT_STORAGE_UNAVAILABLE' })
    expect(objects.has(`merchant/${quarantine.key}`)).toBe(false)
    expect(objects.has(`merchant/${quarantine.key}.merchant-meta.json`)).toBe(true)
    await expect(store.deleteQuarantineAfterCommit(input)).resolves.toBeUndefined()
    await expect(store.deleteQuarantineAfterCommit(input)).resolves.toBeUndefined()
    expect(objects.has(`merchant/${quarantine.key}.merchant-meta.json`)).toBe(false)
  })

  it('preserves S3 quarantine on target partial write, evidence mismatch, and cross-tenant calls', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    let failCleanMetadata = true
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) {
        objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata })
        if (key.includes('/clean/') && key.endsWith('.merchant-meta.json') && failCleanMetadata) {
          failCleanMetadata = false
          throw new Error('clean metadata outage')
        }
      },
      async delete(key) { objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('cloud source survives')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_copy_failure', fileName: 'x.bin', contentType: 'application/octet-stream', body })
    const input = { workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://receipt-cloud-failure', expectedSha256: digest(body), expectedSizeBytes: body.byteLength }

    await expect(store.copyQuarantineToClean(input)).rejects.toThrow('clean metadata outage')
    await expect(store.get('ws_cloud', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body })
    await expect(store.copyQuarantineToClean({ ...input, expectedSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'OBJECT_PROMOTION_EVIDENCE_MISMATCH' })
    await expect(store.copyQuarantineToClean({ ...input, workspaceId: 'ws_other' })).rejects.toMatchObject({ code: 'OBJECT_SCOPE_DENIED' })
    await expect(store.get('ws_cloud', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body })
  })

  it('does not acknowledge an idempotent cloud upload when only metadata remains', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) { objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('durable body')
    const uploaded = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_partial', fileName: 'x.txt', contentType: 'text/plain', body })
    objects.delete(`merchant/${uploaded.key}`)
    await expect(store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_partial', fileName: 'x.txt', contentType: 'text/plain', body }))
      .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_FAILED' })
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

  it('reports a durable orphan key when metadata persistence and cleanup both fail', async () => {
    const transport: CloudObjectTransport = {
      async head() { return null },
      async get() { throw new CloudObjectNotFoundError() },
      async put(key) {
        if (key.endsWith('.merchant-meta.json')) throw new Error('metadata provider outage https://provider.example/write?token=secret-token')
      },
      async delete() { throw new Error('cleanup provider outage apiKey=secret-key') },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })

    let error: ObjectStoragePartialWriteError | undefined
    try {
      await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_orphan', fileName: 'x.txt', contentType: 'text/plain', body: new TextEncoder().encode('orphan me') })
    } catch (caught) {
      error = caught as ObjectStoragePartialWriteError
    }
    expect(error).toMatchObject({
        name: 'ObjectStoragePartialWriteError',
        orphanKey: 'quarantine/ws_cloud/asset_orphan/x.txt',
        cleanupErrors: [expect.any(Error), expect.any(Error)],
      } satisfies Partial<ObjectStoragePartialWriteError>)
    expect(error?.causeMessage).toBe('metadata provider outage https://provider.example/write?[REDACTED]')
    expect(error?.cleanupErrorMessages).toEqual(['cleanup provider outage apiKey=[REDACTED]', 'cleanup provider outage apiKey=[REDACTED]'])
    expect(JSON.stringify(error)).not.toContain('secret-token')
    expect(JSON.stringify(error)).not.toContain('secret-key')
  })

  it('rejects a same-byte retry when immutable content metadata conflicts', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) { objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('same bytes')
    await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_metadata', fileName: 'x.bin', contentType: 'application/octet-stream', body })

    await expect(store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_metadata', fileName: 'x.bin', contentType: 'text/plain', body }))
      .rejects.toMatchObject({ code: 'OBJECT_ALREADY_EXISTS', status: 409 })
  })

  it('retries quarantine cleanup after clean promotion committed but metadata deletion failed', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    let failQuarantineMetadataDelete = true
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) {
        if (key.includes('/quarantine/') && key.endsWith('.merchant-meta.json') && failQuarantineMetadataDelete) {
          failQuarantineMetadataDelete = false
          throw new Error('transient metadata delete failure')
        }
        objects.delete(key)
      },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('promote once')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_retry', fileName: 'x.txt', contentType: 'text/plain', body })

    await expect(store.promoteClean({ workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://retry-1' }))
      .rejects.toMatchObject({ code: 'OBJECT_STORAGE_UNAVAILABLE' })
    await expect(store.get('ws_cloud', 'clean/ws_cloud/asset_retry/x.txt')).resolves.toMatchObject({ body })

    await expect(store.promoteClean({ workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://retry-1' }))
      .resolves.toMatchObject({ zone: 'clean', scanEvidenceRef: 'scanner://retry-1' })
    await expect(store.head('ws_cloud', quarantine.key, { includeQuarantine: true })).resolves.toBeNull()
  })

  it('keeps quarantine when an existing clean target body is missing or corrupt', async () => {
    for (const [caseName, targetBody] of [
      ['missing', undefined],
      ['corrupt', new TextEncoder().encode('corrupt clean body')],
    ] as const) {
      const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
      const transport: CloudObjectTransport = {
        async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
        async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
        async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
        async delete(key) { objects.delete(key) },
      }
      const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
      const body = new TextEncoder().encode(`quarantine source ${caseName}`)
      const quarantine = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: `asset_${caseName}`, fileName: 'x.txt', contentType: 'text/plain', body })
      const cleanKey = quarantine.key.replace('quarantine/', 'clean/')
      const sourceMetadata = objects.get(`merchant/${quarantine.key}.merchant-meta.json`)!
      const cleanMetadata = {
        ...JSON.parse(new TextDecoder().decode(sourceMetadata.body)),
        key: cleanKey,
        zone: 'clean',
        scanEvidenceRef: 'scanner://existing-clean',
      }
      objects.set(`merchant/${cleanKey}.merchant-meta.json`, { body: new TextEncoder().encode(JSON.stringify(cleanMetadata)), contentType: 'application/json', metadata: { workspaceId: 'ws_cloud', zone: 'clean' } })
      if (targetBody) objects.set(`merchant/${cleanKey}`, { body: targetBody, contentType: 'text/plain', metadata: { workspaceId: 'ws_cloud', zone: 'clean' } })

      await expect(store.promoteClean({ workspaceId: 'ws_cloud', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://existing-clean' }))
        .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_FAILED' })
      await expect(store.get('ws_cloud', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body })
    }
  })

  it('rejects a self-consistent but different clean object and preserves the quarantine source', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>()
    const transport: CloudObjectTransport = {
      async head(key) { const item = objects.get(key); return item ? { contentType: item.contentType, sizeBytes: item.body.byteLength, metadata: item.metadata } : null },
      async get(key) { const item = objects.get(key); if (!item) throw new CloudObjectNotFoundError(); return { body: item.body, contentType: item.contentType, metadata: item.metadata } },
      async put(key, input) { objects.set(key, { body: input.body, contentType: input.contentType, metadata: input.metadata }) },
      async delete(key) { objects.delete(key) },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const sourceBody = new TextEncoder().encode('source')
    const targetBody = new TextEncoder().encode('different clean body')
    const quarantine = await store.putQuarantine({ workspaceId: 'ws_conflict', assetId: 'asset_conflict', fileName: 'x.txt', contentType: 'text/plain', body: sourceBody })
    const cleanKey = quarantine.key.replace('quarantine/', 'clean/')
    const targetSha = digest(targetBody)
    const sourceMetadata = objects.get(`merchant/${quarantine.key}.merchant-meta.json`)!
    const cleanMetadata = { ...JSON.parse(new TextDecoder().decode(sourceMetadata.body)), key: cleanKey, zone: 'clean', sha256: targetSha, sizeBytes: targetBody.byteLength, scanEvidenceRef: 'scanner://conflict' }
    objects.set(`merchant/${cleanKey}.merchant-meta.json`, { body: new TextEncoder().encode(JSON.stringify(cleanMetadata)), contentType: 'application/json', metadata: { workspaceId: 'ws_conflict', zone: 'clean' } })
    objects.set(`merchant/${cleanKey}`, { body: targetBody, contentType: 'text/plain', metadata: { workspaceId: 'ws_conflict', zone: 'clean' } })
    await expect(store.promoteClean({ workspaceId: 'ws_conflict', quarantineKey: quarantine.key, scanEvidenceRef: 'scanner://conflict' })).rejects.toMatchObject({ code: 'OBJECT_PROMOTION_CONFLICT' })
    await expect(store.get('ws_conflict', quarantine.key, { includeQuarantine: true })).resolves.toMatchObject({ body: sourceBody })
  })

  it('makes cloud deletion converge when the body or metadata was already removed', async () => {
    const objects = new Set<string>()
    const transport: CloudObjectTransport = {
      async head(key) { return objects.has(key) ? { sizeBytes: 1 } : null },
      async get(key) { if (!objects.has(key)) throw new CloudObjectNotFoundError(); return { body: new Uint8Array([1]) } },
      async put(key) { objects.add(key) },
      async delete(key) {
        if (!objects.delete(key)) throw new CloudObjectNotFoundError()
      },
    }
    const store = new S3CompatibleObjectStorage(transport, { keyPrefix: 'merchant' })
    const body = new TextEncoder().encode('delete me')
    const uploaded = await store.putQuarantine({ workspaceId: 'ws_cloud', assetId: 'asset_delete', fileName: 'x.txt', contentType: 'text/plain', body })
    objects.delete(`merchant/${uploaded.key}`)

    await expect(store.delete('ws_cloud', uploaded.key, { includeQuarantine: true })).resolves.toBeUndefined()
    await expect(store.delete('ws_cloud', uploaded.key, { includeQuarantine: true })).resolves.toBeUndefined()
    expect(objects).toHaveLength(0)
  })
})
