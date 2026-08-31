import { describe, expect, it } from 'vitest'
import { validateImageGenerationCallbackResult } from './image-generation-callback.js'

const hash = 'a'.repeat(64)

describe('image generation callback schema', () => {
  it('accepts bounded success and failure payloads and normalizes whitespace', () => {
    expect(validateImageGenerationCallbackResult({ intent_hash: ` ${hash} `, images: ['https://cdn.example/image.png'] })).toEqual({ intent_hash: hash, images: ['https://cdn.example/image.png'] })
    expect(validateImageGenerationCallbackResult({ intent_hash: hash, provider_request_id: 'provider-1', error: { code: ' PROVIDER_FAILED ', message: ' upstream failed ' } })).toMatchObject({ provider_request_id: 'provider-1', error: { code: 'PROVIDER_FAILED', message: 'upstream failed' } })
  })

  it.each([
    ['empty error', { intent_hash: hash, error: {} }],
    ['non-string error field', { intent_hash: hash, error: { code: 'E', message: 1 } }],
    ['error and images together', { intent_hash: hash, images: ['https://cdn.example/a.png'], error: { code: 'E', message: 'failed' } }],
    ['neither images nor error', { intent_hash: hash }],
    ['invalid image reference', { intent_hash: hash, images: ['http://cdn.example/a.png'] }],
    ['oversized provider request id', { intent_hash: hash, provider_request_id: 'p'.repeat(257), images: ['https://cdn.example/a.png'] }],
    ['oversized error message', { intent_hash: hash, error: { code: 'E', message: 'x'.repeat(501) } }],
    ['wrong intent hash type', { intent_hash: 123, images: ['https://cdn.example/a.png'] }],
    ['empty image reference', { intent_hash: hash, images: [''] }],
    ['too many images', { intent_hash: hash, images: Array.from({ length: 7 }, () => 'https://cdn.example/a.png') }],
    ['unknown field', { intent_hash: hash, images: ['https://cdn.example/a.png'], extra: true }],
  ])('rejects %s', (_label, payload) => {
    expect(() => validateImageGenerationCallbackResult(payload)).toThrow()
  })

  it('validates the API-only event id without weakening the result schema', () => {
    expect(validateImageGenerationCallbackResult({ event_id: 'event-1', intent_hash: hash, images: ['data:image/png;base64,aA=='] }, { allowEventId: true })).toMatchObject({ event_id: 'event-1' })
    expect(() => validateImageGenerationCallbackResult({ intent_hash: hash, images: ['https://cdn.example/a.png'] }, { allowEventId: true })).toThrow('event_id')
  })
})
