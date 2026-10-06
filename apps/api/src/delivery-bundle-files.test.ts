import { describe, expect, it } from 'vitest'
import { parseDeliveryBundleFiles } from './server.js'

describe('delivery bundle file byte parsing', () => {
  it('rejects malformed base64 instead of silently changing the verified bytes', () => {
    for (const content_base64 of ['Zg=', 'Zg', 'AAAA\n', 'AAAA AA=', 'AA=A', 'AA-_', 'A===']) {
      expect(() => parseDeliveryBundleFiles([{ path: 'content.bin', mimeType: 'application/octet-stream', content_base64 }])).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    }
  })

  it('preserves the exact decoded bytes for canonical base64', () => {
    const files = parseDeliveryBundleFiles([{ path: 'content.bin', mimeType: 'application/octet-stream', content_base64: Buffer.from([0, 1, 2, 255]).toString('base64') }])
    expect(files[0]?.content).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  it('preserves UTF-8 content bytes without normalizing or re-encoding them', () => {
    const original = Buffer.from('中文商品说明🙂\u0000', 'utf8')
    const files = parseDeliveryBundleFiles([{ path: 'content.txt', mimeType: 'text/plain; charset=utf-8', content_base64: original.toString('base64') }])
    expect(Buffer.from(files[0]?.content as Uint8Array)).toEqual(original)
  })
})
