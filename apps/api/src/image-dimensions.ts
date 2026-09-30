/** Server-side pixel dimensions parsed from the uploaded image bytes.
 * The result is deliberately bound to both the byte digest and source revision.
 */
export interface ImageDimensions {
  width: number
  height: number
  sha256: string
  sourceRevision: number
}

const MAX_DIMENSION = 30_000
const MAX_PIXELS = 100_000_000
const MAX_JPEG_HEADER_BYTES = 1024 * 1024

function dimensions(width: number, height: number): { width: number; height: number } | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) return undefined
  return { width, height }
}

function pngCrc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function png(bytes: Buffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(sig) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || pngCrc32(bytes.subarray(12, 29)) !== bytes.readUInt32BE(29)) return undefined
  return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
}

function jpeg(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  const end = Math.min(bytes.length, MAX_JPEG_HEADER_BYTES)
  while (offset + 4 <= end) {
    if (bytes[offset] !== 0xff) return undefined
    while (offset < end && bytes[offset] === 0xff) offset++
    if (offset >= end) return undefined
    const marker = bytes[offset++]!
    if (marker === 0xd9 || marker === 0xda) return undefined
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > end) return undefined
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > end) return undefined
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return undefined
      return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
    }
    offset += length
  }
  return undefined
}

function webp(bytes: Buffer) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const riffEnd = bytes.readUInt32LE(4) + 8
  if (riffEnd > bytes.length || riffEnd < 20) return undefined
  const chunk = bytes.toString('ascii', 12, 16)
  const chunkLength = bytes.readUInt32LE(16)
  if (chunkLength + 20 > riffEnd) return undefined
  if (chunk === 'VP8X' && chunkLength >= 10) return dimensions(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
  if (chunk === 'VP8 ' && chunkLength >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
  if (chunk === 'VP8L' && chunkLength >= 5 && bytes[20] === 0x2f) {
    const b1 = bytes[21]!, b2 = bytes[22]!, b3 = bytes[23]!, b4 = bytes[24]!
    return dimensions(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)))
  }
  return undefined
}

/** Header-only bounded parsing. Unsupported, malformed, or oversized files are unread. */
export function readImageDimensions(input: Uint8Array, mimeType: string, sha256: string, sourceRevision: number): ImageDimensions | undefined {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.length > 50 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) return undefined
  const type = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  const parsed = type === 'image/png' ? png(bytes) : type === 'image/jpeg' || type === 'image/jpg' ? jpeg(bytes) : type === 'image/webp' ? webp(bytes) : undefined
  return parsed ? { ...parsed, sha256, sourceRevision } : undefined
}

export const imageDimensionLimits = { maxDimension: MAX_DIMENSION, maxPixels: MAX_PIXELS, maxJpegHeaderBytes: MAX_JPEG_HEADER_BYTES }
