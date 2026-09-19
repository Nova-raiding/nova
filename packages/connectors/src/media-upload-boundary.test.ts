import { describe, expect, it, vi } from 'vitest'
import type { ConnectorContext, HttpConnectorConfig, MediaUploadInput, MediaUploadReceipt, OrphanedMediaRecord } from './index.js'
import { createConfiguredConnector, validateMediaUploadInput } from './index.js'

const MAX_MEDIA_UPLOAD_BYTES = 15 * 1024 * 1024

function readyConfig(): HttpConnectorConfig {
  return {
    clientId: 'app-test',
    oauth: { authorizeUrl: 'https://platform.test/oauth/authorize', tokenUrl: 'https://platform.test/oauth/token', refreshUrl: 'https://platform.test/oauth/refresh' },
    api: { baseUrl: 'https://platform.test/api', syncPath: '/products', createPath: '/products', updatePath: '/products/update', queryPath: '/publish/status' },
    timeoutMs: 500,
    signer: { kind: 'test', sign: () => ({}) },
    mapProducts: () => [],
    mapWriteReceipt: (_payload, input, operation, platform) => ({ platform, operation, remoteId: input.remoteId ?? 'remote-test', requestId: 'request-test', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }),
    mapWriteStatus: () => ({ found: true, state: 'submitted', simulated: false }),
    mappingEvidence: { version: 'test.mapping.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' },
    mediaUploadPath: '/media/upload',
    mapMediaUpload: payload => ({ mediaId: String((payload as { mediaId?: string }).mediaId ?? 'media-test') }),
    mediaUploadEvidence: { version: 'test.media.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' },
    capabilityEvidence: ['authorize', 'refresh', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'].map(capability => ({ platform: 'jd' as const, capability: capability as never, state: 'test_e2e' as const, evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' })),
  }
}

const credentials = {
  kind: 'test' as const,
  async resolve() { return { accessToken: 'access-token' } },
  async store({ accountId }: { accountId: string }) { return { accountId, credentialRef: `vault://${accountId}` } },
}

const context: ConnectorContext = { workspaceId: 'ws-media', accountId: 'acct-media', credentialRef: 'vault://acct-media' }

function media(overrides: Partial<MediaUploadInput> = {}): MediaUploadInput {
  return { visualRef: 'visual-1', role: 'main', mimeType: 'image/png', sha256: 'a'.repeat(64), bytes: new Uint8Array([1, 2, 3]), idempotencyKey: 'media-key-1', ...overrides }
}

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

function connectorWith(fetchMock: (url: string | URL, init?: RequestInit) => Promise<Response>, options: Record<string, unknown> = {}) {
  return createConfiguredConnector('jd', {
    config: readyConfig(), credentials, fetch: fetchMock as never, allowTestCredentials: true, allowTestAdapters: true, ...options,
  })
}

describe('media upload transport boundary', () => {
  it('uploads within the worker transport bound', async () => {
    const calls: Array<{ url: string; body?: string }> = []
    const connector = connectorWith(async (url, init) => { calls.push({ url: String(url), body: init?.body as string | undefined }); return response({ mediaId: 'media-1', url: 'https://cdn.test/1.png' }) })
    await expect(connector.uploadMedia!(context, media())).resolves.toMatchObject({ mediaId: 'media-1', url: 'https://cdn.test/1.png', simulated: false })
    expect(calls[0]?.url).toBe('https://platform.test/api/media/upload')
    expect(calls[0]?.body).toContain('"idempotencyKey":"media-key-1"')
  })

  it('rejects oversized, empty and non-image media before any provider call', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'must-not-be-used' }))
    const connector = connectorWith(fetchMock)
    const oversized = new Uint8Array(MAX_MEDIA_UPLOAD_BYTES + 1)
    for (const [input, expected] of [
      [media({ bytes: oversized }), 'byte limit'],
      [media({ bytes: new Uint8Array() }), 'image bytes'],
      [media({ mimeType: 'application/pdf' }), 'image MIME type'],
      [media({ mimeType: 'image' }), 'image MIME type'],
      [media({ mimeType: 'image/png\r\nx-injected: 1' }), 'image MIME type'],
      [media({ idempotencyKey: '   ' }), 'idempotency key'],
    ] as const) {
      await expect(connector.uploadMedia!(context, input)).rejects.toMatchObject({ normalized: { code: 'VALIDATION_FAILED', retryable: false } })
      expect(validateMediaUploadInput(input)).toContain(expected)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reuses the upload receipt for a retried idempotency key', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'media-cached' }))
    const connector = connectorWith(fetchMock)
    const first = await connector.uploadMedia!(context, media({ idempotencyKey: 'retry-key' }))
    const second = await connector.uploadMedia!(context, media({ idempotencyKey: 'retry-key' }))
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses to reuse an idempotency key for different content', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'media-1' }))
    const connector = connectorWith(fetchMock)
    await connector.uploadMedia!(context, media({ idempotencyKey: 'reused-key' }))
    await expect(connector.uploadMedia!(context, media({ idempotencyKey: 'reused-key', bytes: new Uint8Array([9, 9, 9]) })))
      .rejects.toMatchObject({ normalized: { code: 'CONFLICT', retryable: false } })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('media compensation', () => {
  it('deletes and forgets the receipt when the platform delete adapter confirms it', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'media-deletable' }))
    const deleted: MediaUploadReceipt[] = []
    const connector = connectorWith(fetchMock, { deleteMedia: async (_ctx: ConnectorContext, receipt: MediaUploadReceipt) => { deleted.push(receipt); return true } })
    const receipt = await connector.uploadMedia!(context, media({ idempotencyKey: 'delete-key' }))
    await expect(connector.discardMedia!(context, receipt, 'validate_write_failed', 'delete-key')).resolves.toEqual({ deleted: true })
    expect(deleted).toEqual([receipt])
    // A deleted remote object must never be reused by a retry.
    await connector.uploadMedia!(context, media({ idempotencyKey: 'delete-key' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the idempotency cache when the platform cannot delete the media', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'media-orphan', url: 'https://cdn.test/orphan.png' }))
    const connector = connectorWith(fetchMock)
    const receipt = await connector.uploadMedia!(context, media({ idempotencyKey: 'orphan-key' }))
    const result = await connector.discardMedia!(context, receipt, 'validate_write_failed')
    expect(result.deleted).toBe(false)
    expect(result.orphaned).toMatchObject({
      platform: 'jd', workspaceId: 'ws-media', accountId: 'acct-media', mediaId: 'media-orphan',
      url: 'https://cdn.test/orphan.png', visualRef: 'visual-1', role: 'main', idempotencyKey: 'orphan-key', reason: 'validate_write_failed',
    })
    expect(result.orphaned?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    // The orphan is still usable: a retry must reuse it instead of uploading a
    // second copy that would also have to be reconciled.
    await connector.uploadMedia!(context, media({ idempotencyKey: 'orphan-key' }))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports an unconfirmed delete as an orphan instead of claiming success', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'media-unconfirmed' }))
    const connector = connectorWith(fetchMock, { deleteMedia: async () => false })
    const receipt = await connector.uploadMedia!(context, media({ idempotencyKey: 'unconfirmed-key' }))
    await expect(connector.discardMedia!(context, receipt, 'publish_canceled')).resolves.toMatchObject({ deleted: false, orphaned: { reason: 'publish_canceled' } })
  })

  it('hands orphan markers to the durable reconciliation sink', async () => {
    const fetchMock = vi.fn(async () => response({ mediaId: 'media-sink' }))
    const markers: OrphanedMediaRecord[] = []
    const connector = connectorWith(fetchMock, {
      deleteMedia: () => { throw new Error('platform delete endpoint unavailable') },
      onOrphanedMedia: (record: OrphanedMediaRecord) => { markers.push(record) },
    })
    const receipt = await connector.uploadMedia!(context, media({ idempotencyKey: 'sink-key' }))
    await connector.discardMedia!(context, receipt, 'write_rejected')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ mediaId: 'media-sink', reason: 'write_rejected', idempotencyKey: 'sink-key' })
  })

  it('never compensates a receipt owned by another platform', async () => {
    const connector = connectorWith(async () => response({ mediaId: 'media-1' }))
    await expect(connector.discardMedia!(context, { platform: 'taobao', visualRef: 'v', role: 'main', mediaId: 'm', sha256: 'a'.repeat(64), simulated: false }, 'write_rejected'))
      .rejects.toMatchObject({ normalized: { code: 'VALIDATION_FAILED', retryable: false } })
  })
})
