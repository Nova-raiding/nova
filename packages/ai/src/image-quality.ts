import { inflateSync } from 'node:zlib'

/**
 * Reject provider artifacts that are technically valid images but contain no
 * visible subject. This is intentionally conservative: it only inspects
 * inline PNG artifacts with a real canvas and leaves URLs/JPEGs to the
 * storage-side scanner. Tiny fixtures used by unit tests are not gated.
 */
export class ImageArtifactQualityError extends Error {
  readonly code = 'IMAGE_ARTIFACT_QUALITY_FAILED'
  readonly providerOutcome = 'unknown' as const
  readonly providerSucceeded = true
  readonly reconciliationRequired = true
  readonly retryable = false
  readonly details = { provider_succeeded: true, provider_outcome: 'unknown', reconciliation_required: true, quality_gate: 'near_empty_white_png' }
  constructor() { super('image provider returned an almost-empty white artifact'); this.name = 'ImageArtifactQualityError' }
}

export function assertImageArtifactQuality(image: string): void {
  if (process.env.IMAGE_ARTIFACT_QUALITY_GATE === 'false') return
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/iu.exec(image)
  if (!match) return
  const bytes = Buffer.from(match[1]!, 'base64')
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0
  const idat: Buffer[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const bodyStart = offset + 8
    const bodyEnd = bodyStart + length
    if (bodyEnd + 4 > bytes.length) return
    if (type === 'IHDR' && length >= 13) {
      width = bytes.readUInt32BE(bodyStart); height = bytes.readUInt32BE(bodyStart + 4)
      bitDepth = bytes[bodyStart + 8]!; colorType = bytes[bodyStart + 9]!
    } else if (type === 'IDAT') idat.push(bytes.subarray(bodyStart, bodyEnd))
    offset = bodyEnd + 4
    if (type === 'IEND') break
  }
  // RGB/RGBA, 8-bit PNGs are sufficient for relay output. Other valid PNG
  // variants remain subject to the downstream malware/storage checks.
  if (width * height < 4096 || bitDepth !== 8 || ![2, 6].includes(colorType) || !idat.length) return
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(idat)) } catch { return }
  if (raw.length < (stride + 1) * height) return
  let previous = Buffer.alloc(stride)
  let visible = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels]! : 0
      const up = previous[x]!
      const upLeft = x >= channels ? previous[x - channels]! : 0
      if (filter === 1) row[x] = (row[x]! + left) & 255
      else if (filter === 2) row[x] = (row[x]! + up) & 255
      else if (filter === 3) row[x] = (row[x]! + Math.floor((left + up) / 2)) & 255
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft)
        row[x] = (row[x]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255
      } else if (filter !== 0) return
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * channels
      const alpha = channels === 4 ? row[i + 3]! : 255
      if (alpha > 8 && (row[i]! < 245 || row[i + 1]! < 245 || row[i + 2]! < 245)) visible += 1
    }
    previous = row
  }
  if (visible / (width * height) < 0.002) {
    throw new ImageArtifactQualityError()
  }
}
