import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assertImageArtifactQuality, ImageArtifactQualityError } from './image-quality.js'

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii')
  return Buffer.concat([head, body, Buffer.alloc(4)])
}

function png(colorType: 0 | 3, value: number): string {
  const width = 64; const height = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, colorType === 3 ? 0 : value)])
  const raw = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length)
  const chunks = [pngChunk('IHDR', ihdr)]
  if (colorType === 3) chunks.push(pngChunk('PLTE', Buffer.from([value, value, value])))
  chunks.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)))
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]).toString('base64')}`
}

describe('image artifact quality gate', () => {
  it('blocks an all-white grayscale PNG', () => {
    expect(() => assertImageArtifactQuality(png(0, 255))).toThrow(ImageArtifactQualityError)
  })

  it('blocks an all-white indexed PNG', () => {
    expect(() => assertImageArtifactQuality(png(3, 255))).toThrow(ImageArtifactQualityError)
  })

  it('accepts an all-black grayscale PNG as visible content', () => {
    expect(() => assertImageArtifactQuality(png(0, 0))).not.toThrow()
  })
})
