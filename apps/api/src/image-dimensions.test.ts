import { describe, expect, it } from 'vitest'
import { imageDimensionLimits, readImageDimensions } from './image-dimensions.js'

const digest = 'a'.repeat(64)
function pngHeader(width: number, height: number) {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  // IHDR fields after the dimensions are zero-filled; CRC covers type + data.
  let crc = 0xffffffff
  for (const byte of bytes.subarray(12, 29)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29)
  return bytes
}

describe('readImageDimensions', () => {
  it('reads bounded dimensions from a PNG header and binds them to source identity', () => {
    expect(readImageDimensions(pngHeader(1280, 720), 'image/png', digest, 3)).toEqual({ width: 1280, height: 720, sha256: digest, sourceRevision: 3 })
  })
  it('returns unread for malformed, MIME-mismatched, truncated, or oversized headers', () => {
    expect(readImageDimensions(pngHeader(1280, 720), 'image/jpeg', digest, 1)).toBeUndefined()
    expect(readImageDimensions(Buffer.from('not an image'), 'image/png', digest, 1)).toBeUndefined()
    expect(readImageDimensions(pngHeader(0, 10), 'image/png', digest, 1)).toBeUndefined()
    expect(readImageDimensions(pngHeader(imageDimensionLimits.maxDimension + 1, 1), 'image/png', digest, 1)).toBeUndefined()
    expect(readImageDimensions(pngHeader(10_001, 10_001), 'image/png', digest, 1)).toBeUndefined()
    expect(readImageDimensions(pngHeader(1, 1), 'image/png', digest, 0)).toBeUndefined()
  })
  it('reads dimensions from JPEG SOF and WebP VP8X headers', () => {
    const jpg = Buffer.alloc(13)
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 9, 8, 0, 50, 0, 60, 1, 1]).copy(jpg)
    expect(readImageDimensions(jpg, 'image/jpeg', digest, 1)).toMatchObject({ width: 60, height: 50 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8, 'ascii'); webp.writeUInt32LE(10, 16)
    webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(359, 27, 3)
    expect(readImageDimensions(webp, 'image/webp', digest, 2)).toMatchObject({ width: 640, height: 360 })
  })
})
