import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MemoryAssetScanAttemptRepository } from '../../../packages/persistence/src/asset-scan-attempt-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { verifyScannerRequestProof } from '../../../packages/security/src/scanner-request-proof.js'
import { executeAssetScan } from './main.js'

function clamAvVersion(definitionsPublishedAt: Date): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const time = [definitionsPublishedAt.getUTCHours(), definitionsPublishedAt.getUTCMinutes(), definitionsPublishedAt.getUTCSeconds()].map(value => String(value).padStart(2, '0')).join(':')
  const versionDate = `${weekdays[definitionsPublishedAt.getUTCDay()]} ${months[definitionsPublishedAt.getUTCMonth()]} ${definitionsPublishedAt.getUTCDate()} ${time} ${definitionsPublishedAt.getUTCFullYear()}`
  return `ClamAV 1.4.6/28108/${versionDate}`
}

describe('durable scanner callback', () => {
  it('replays byte-identical signed evidence after an accepted API response is lost, without rescanning', async () => {
    const testNow = new Date()
    const definitionsPublishedAt = new Date(testNow.getTime() - 60 * 60_000)
    const body = Buffer.from('clean image bytes')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const objectKey = 'quarantine/ws_scan/asset_1/source.png'
    const event: DurableOutboxEvent = { id: 'evt_scan_durable', workspaceId: 'ws_scan', aggregateId: 'asset_1', eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: 'asset_1', storage_key: objectKey, sha256, size_bytes: body.byteLength }, createdAt: new Date().toISOString() }
    const keys = generateKeyPairSync('ed25519')
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const repository = new MemoryAssetScanAttemptRepository()
    const scanner = { version: vi.fn(async () => clamAvVersion(definitionsPublishedAt)), scan: vi.fn(async () => ({ status: 'clean' as const, target: 'stream', raw: 'stream: OK' })) }
    const callbackBodies: string[] = []
    const requests: Array<{ method: string; target: string; headers: Headers; body?: string }> = []
    let callbackCount = 0
    const fetcher: typeof fetch = async (url, init) => {
      const target = new URL(String(url)).pathname + new URL(String(url)).search
      requests.push({ method: init?.method ?? 'GET', target, headers: new Headers(init?.headers), ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
      if (String(url).endsWith('/scan-content')) return new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'x-asset-source-revision': '3', 'x-asset-object-key': encodeURIComponent(objectKey) } })
      callbackBodies.push(String(init?.body))
      callbackCount += 1
      if (callbackCount === 1) throw new TypeError('socket closed after API commit')
      return new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
    }
    const input = { apiBaseUrl: 'http://api:8787', apiToken: 'token', apiSigningSecret: 'secret', receiptPrivateKeyPem: privateKey, receiptKeyId: 'key-1', scannerServiceId: 'scanner', scannerInstanceId: 'replica-a', policyVersion: 'v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, attemptRepository: repository, scanner, event, fetcher, now: () => testNow }

    await expect(executeAssetScan(input)).rejects.toThrow('socket closed after API commit')
    expect((await repository.getByOutboxEvent('ws_scan', event.id))).toMatchObject({ callbackStatus: 'pending', callbackAttempts: 1, lastCallbackError: 'socket closed after API commit' })
    await expect(executeAssetScan({ ...input, scannerInstanceId: 'replica-b', scanner: { version: vi.fn(() => { throw new Error('must not rescan') }), scan: vi.fn(() => { throw new Error('must not rescan') }) } })).resolves.toMatchObject({ verdict: 'clean' })
    expect(scanner.version).toHaveBeenCalledOnce()
    expect(scanner.scan).toHaveBeenCalledOnce()
    expect(callbackBodies).toHaveLength(2)
    expect(callbackBodies[1]).toBe(callbackBodies[0])
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(verifyScannerRequestProof({
        secret: 'secret', method: request.method, requestTarget: request.target, workspaceId: 'ws_scan', body: request.body,
        timestamp: request.headers.get('x-scanner-timestamp') ?? '', nonce: request.headers.get('x-scanner-nonce') ?? '',
        bodySha256: request.headers.get('x-scanner-body-sha256') ?? '', signature: request.headers.get('x-scanner-workspace-signature') ?? '',
      })).toBe(true)
    }
    expect(requests[0]!.headers.get('x-scanner-body-sha256')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(requests[1]!.body).toBe(requests[2]!.body)
    expect(requests[1]!.headers.get('x-scanner-body-sha256')).toBe(requests[2]!.headers.get('x-scanner-body-sha256'))
    expect(requests[1]!.headers.get('x-scanner-nonce')).not.toBe(requests[2]!.headers.get('x-scanner-nonce'))
    expect(requests[1]!.headers.get('x-scanner-workspace-signature')).not.toBe(requests[2]!.headers.get('x-scanner-workspace-signature'))
    expect((await repository.getByOutboxEvent('ws_scan', event.id))).toMatchObject({ callbackStatus: 'accepted', callbackAttempts: 2 })
  })

  it.each([
    ['stale definitions', 'ClamAV 1.4.6/28107/Fri Aug 28 00:00:00 2026', 'CLAMAV_DEFINITIONS_STALE'],
    ['malformed version', 'ClamAV malformed', 'CLAMAV_VERSION_INVALID'],
  ])('fails closed before scanning or signing with %s', async (_label, version, code) => {
    const body = Buffer.from('untrusted image bytes')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const objectKey = 'quarantine/ws_scan/asset_stale/source.png'
    const event: DurableOutboxEvent = { id: `evt_${code}`, workspaceId: 'ws_scan', aggregateId: 'asset_stale', eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: 'asset_stale', storage_key: objectKey, sha256, size_bytes: body.byteLength }, createdAt: '2026-08-30T10:00:00.000Z' }
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const scan = vi.fn(async () => ({ status: 'clean' as const, target: 'stream', raw: 'stream: OK' }))
    const fetcher: typeof fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'x-asset-source-revision': '1', 'x-asset-object-key': encodeURIComponent(objectKey) } })
    const promise = executeAssetScan({ apiBaseUrl: 'http://api:8787', apiToken: 'token', apiSigningSecret: 'secret', receiptPrivateKeyPem: privateKey, receiptKeyId: 'key-1', scannerServiceId: 'scanner', scannerInstanceId: 'replica-a', policyVersion: 'v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, definitionsMaxAgeSeconds: 86_400, attemptRepository: new MemoryAssetScanAttemptRepository(), scanner: { version: async () => version, scan }, event, fetcher, now: () => new Date('2026-08-30T10:00:00.000Z') })
    await expect(promise).rejects.toMatchObject({ code, retryable: true })
    expect(scan).not.toHaveBeenCalled()
  })

  it('binds a redrive event source revision to the scan-content response before ClamAV access', async () => {
    const body = Buffer.from('redrive image bytes')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const objectKey = 'quarantine/ws_scan/asset_redrive/source.png'
    const event: DurableOutboxEvent = { id: 'evt_scan_redrive', workspaceId: 'ws_scan', aggregateId: 'asset_redrive', eventType: 'asset.scan_redrive_requested', sequence: 4, payload: { asset_id: 'asset_redrive', storage_key: objectKey, sha256, size_bytes: body.byteLength, source_revision: 4 }, createdAt: '2026-08-30T10:00:00.000Z' }
    const version = vi.fn(async () => 'ClamAV 1.4.6/28108/Sat Aug 30 09:00:00 2026')
    const scan = vi.fn(async () => ({ status: 'clean' as const, target: 'stream', raw: 'stream: OK' }))
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const fetcher: typeof fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'x-asset-source-revision': '3', 'x-asset-object-key': encodeURIComponent(objectKey) } })

    await expect(executeAssetScan({ apiBaseUrl: 'http://api:8787', apiToken: 'token', apiSigningSecret: 'secret', receiptPrivateKeyPem: privateKey, receiptKeyId: 'key-1', scannerServiceId: 'scanner', scannerInstanceId: 'replica-a', policyVersion: 'v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, attemptRepository: new MemoryAssetScanAttemptRepository(), scanner: { version, scan }, event, fetcher, now: () => new Date('2026-08-30T10:00:00.000Z') }))
      .rejects.toMatchObject({ code: 'ASSET_SCAN_CONTENT_BINDING_INVALID', retryable: false })
    expect(version).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
  })

  it('rejects a redrive event without a positive integer source revision before content fetch', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const event: DurableOutboxEvent = { id: 'evt_scan_redrive_unbound', workspaceId: 'ws_scan', aggregateId: 'asset_redrive', eventType: 'asset.scan_redrive_requested', sequence: 4, payload: { asset_id: 'asset_redrive', storage_key: 'quarantine/ws_scan/asset_redrive/source.png', sha256: 'a'.repeat(64), size_bytes: 1 }, createdAt: new Date().toISOString() }
    await expect(executeAssetScan({ apiBaseUrl: 'http://api:8787', apiToken: 'token', apiSigningSecret: 'secret', receiptPrivateKeyPem: 'unused', receiptKeyId: 'key-1', scannerServiceId: 'scanner', scannerInstanceId: 'replica-a', policyVersion: 'v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, attemptRepository: new MemoryAssetScanAttemptRepository(), event, fetcher }))
      .rejects.toMatchObject({ code: 'ASSET_SCAN_EVENT_INVALID', retryable: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['ASSET_SCAN_SOURCE_INTEGRITY_FAILED', false, undefined],
    ['ASSET_SCAN_STATE_INVALID', true, true],
  ] as const)('classifies scan-content 409 %s without invoking ClamAV', async (code, terminal, expectedTerminal) => {
    const version = vi.fn(async () => 'unused')
    const scan = vi.fn(async () => ({ status: 'clean' as const, target: 'stream', raw: 'stream: OK' }))
    const event: DurableOutboxEvent = { id: `evt_${code}`, workspaceId: 'ws_scan', aggregateId: 'asset_409', eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: 'asset_409', storage_key: 'quarantine/ws_scan/asset_409/source.png', sha256: 'a'.repeat(64), size_bytes: 1 }, createdAt: new Date().toISOString() }
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: { code, message: code === 'ASSET_SCAN_STATE_INVALID' ? 'already terminal' : 'object mismatch', details: { retryable: false } } }), { status: 409, headers: { 'content-type': 'application/json' } })
    const execution = executeAssetScan({ apiBaseUrl: 'http://api:8787', apiToken: 'token', apiSigningSecret: 'secret', receiptPrivateKeyPem: 'unused', receiptKeyId: 'key-1', scannerServiceId: 'scanner', scannerInstanceId: 'replica-a', policyVersion: 'v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, attemptRepository: new MemoryAssetScanAttemptRepository(), scanner: { version, scan }, event, fetcher })
    if (terminal) await expect(execution).resolves.toEqual({ terminal: expectedTerminal })
    else await expect(execution).rejects.toMatchObject({ code: 'ASSET_SCAN_SOURCE_INTEGRITY_FAILED', retryable: false })
    expect(version).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
  })

  it('preserves a structured API callback error code in durable failure evidence', async () => {
    const testNow = new Date()
    const body = Buffer.from('callback error image bytes')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const objectKey = 'quarantine/ws_scan/asset_callback/source.png'
    const event: DurableOutboxEvent = { id: 'evt_scan_callback_error', workspaceId: 'ws_scan', aggregateId: 'asset_callback', eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: 'asset_callback', storage_key: objectKey, sha256, size_bytes: body.byteLength }, createdAt: '2026-08-30T10:00:00.000Z' }
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const repository = new MemoryAssetScanAttemptRepository()
    const fetcher: typeof fetch = async url => String(url).endsWith('/scan-content')
      ? new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'x-asset-source-revision': '1', 'x-asset-object-key': encodeURIComponent(objectKey) } })
      : new Response(JSON.stringify({ error: { code: 'ASSET_SCAN_RECEIPT_INVALID', message: 'receipt expired', details: { retryable: false } } }), { status: 400, headers: { 'content-type': 'application/json' } })

    await expect(executeAssetScan({ apiBaseUrl: 'http://api:8787', apiToken: 'token', apiSigningSecret: 'secret', receiptPrivateKeyPem: privateKey, receiptKeyId: 'key-1', scannerServiceId: 'scanner', scannerInstanceId: 'replica-a', policyVersion: 'v1', clamavHost: 'clamav', clamavPort: 3310, clamavTimeoutMs: 1000, attemptRepository: repository, scanner: { version: async () => clamAvVersion(new Date(testNow.getTime() - 60 * 60_000)), scan: async () => ({ status: 'clean' as const, target: 'stream', raw: 'stream: OK' }) }, event, fetcher, now: () => testNow }))
      .rejects.toMatchObject({ code: 'ASSET_SCAN_RECEIPT_INVALID', retryable: false, message: 'receipt expired' })
    expect(await repository.getByOutboxEvent('ws_scan', event.id)).toMatchObject({ callbackStatus: 'pending', callbackAttempts: 1, lastCallbackError: 'ASSET_SCAN_RECEIPT_INVALID: receipt expired' })
  })
})
