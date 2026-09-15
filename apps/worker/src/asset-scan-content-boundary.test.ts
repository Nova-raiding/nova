import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLAMAV_MAX_FILE_BYTES, readBoundedAssetScanContent, readWorkerConfig } from './main.js'

describe('asset scan content boundary', () => {
  it('defaults to the delivery-chain 50 MiB contract and reads CLAMAV_MAX_FILE_BYTES', () => {
    const base = { DATABASE_URL: 'postgres://worker', WORKER_WORKSPACES: 'ws_a' }
    expect(DEFAULT_CLAMAV_MAX_FILE_BYTES).toBe(50 * 1024 * 1024)
    expect(readWorkerConfig(base).clamavMaxFileBytes).toBe(DEFAULT_CLAMAV_MAX_FILE_BYTES)
    expect(readWorkerConfig({ ...base, CLAMAV_MAX_FILE_BYTES: '4096' }).clamavMaxFileBytes).toBe(4096)
    expect(() => readWorkerConfig({ ...base, CLAMAV_MAX_FILE_BYTES: '0' })).toThrow('CLAMAV_MAX_FILE_BYTES')
  })

  it('rejects an oversized Content-Length before pulling response bytes and cancels the body', async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
      headers: { 'content-length': '5' },
    })

    await expect(readBoundedAssetScanContent(response, 4)).rejects.toMatchObject({ code: 'ASSET_SCAN_CONTENT_TOO_LARGE', retryable: false })
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects and cancels a stream that crosses the limit when Content-Length is absent', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]))
        controller.enqueue(Uint8Array.from([4, 5]))
      },
      cancel,
    }))

    await expect(readBoundedAssetScanContent(response, 4)).rejects.toMatchObject({ code: 'ASSET_SCAN_CONTENT_TOO_LARGE', retryable: false })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('accepts a response exactly at the limit without requiring Content-Length', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]))
        controller.enqueue(Uint8Array.from([3, 4]))
        controller.close()
      },
    }))

    await expect(readBoundedAssetScanContent(response, 4)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]))
  })

  it('fails closed on a malformed Content-Length without consuming the body', async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
      headers: { 'content-length': 'unknown' },
    })

    await expect(readBoundedAssetScanContent(response, 4)).rejects.toMatchObject({ code: 'ASSET_SCAN_CONTENT_LENGTH_INVALID', retryable: false })
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
