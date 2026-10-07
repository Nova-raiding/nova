import { describe, expect, it } from 'vitest'
import { validateImageGenerationCallbackResult } from './image-generation-callback.js'

const intentHash = 'a'.repeat(64)
const httpsImage = 'https://cdn.example/image.png'

describe('image generation callback contract regression', () => {
  it('accepts either images or an error, but never both or neither', () => {
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [httpsImage] }).images).toEqual([httpsImage])
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, error: { code: 'FAILED', message: 'provider failed' } }).error).toEqual({ code: 'FAILED', message: 'provider failed' })
    expect(() => validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [httpsImage], error: { code: 'FAILED', message: 'provider failed' } })).toThrow(/both images and error/u)
    expect(() => validateImageGenerationCallbackResult({ intent_hash: intentHash })).toThrow(/images or error/u)
  })

  it('accepts HTTPS image URLs and base64 image data URIs', () => {
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [httpsImage] }).images).toEqual([httpsImage])
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, images: ['data:image/png;base64,aA=='] }).images).toEqual(['data:image/png;base64,aA=='])
  })

  it.each([
    ['HTTP URL', 'http://cdn.example/image.png'],
    ['URL userinfo', 'https://user:secret@cdn.example/image.png'],
    ['URL hash', 'https://cdn.example/image.png#fragment'],
  ])('rejects %s image references', (_label, image) => {
    expect(() => validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [image] })).toThrow()
  })

  it('accepts image arrays at the 1 and 6 item boundaries', () => {
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [httpsImage] }).images).toHaveLength(1)
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, images: Array.from({ length: 6 }, (_, index) => `https://cdn.example/${index}.png`) }).images).toHaveLength(6)
  })

  it.each([0, 7])('rejects an image array of length %i', (length) => {
    expect(() => validateImageGenerationCallbackResult({ intent_hash: intentHash, images: Array.from({ length }, () => httpsImage) })).toThrow(/1 to 6/u)
  })

  it('rejects unknown fields and keeps event_id optional unless explicitly enabled', () => {
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [httpsImage] })).not.toHaveProperty('event_id')
    expect(validateImageGenerationCallbackResult({ intent_hash: intentHash, event_id: 'evt-1', images: [httpsImage] }, { allowEventId: true }).event_id).toBe('evt-1')
    expect(() => validateImageGenerationCallbackResult({ intent_hash: intentHash, event_id: 'evt-1', images: [httpsImage] })).toThrow(/unknown callback field: event_id/u)
    expect(() => validateImageGenerationCallbackResult({ intent_hash: intentHash, images: [httpsImage], unexpected: true })).toThrow(/unknown callback field: unexpected/u)
  })
})
