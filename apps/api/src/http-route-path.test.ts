import { describe, expect, it } from 'vitest'
import { decodeHttpPathSegment } from './http-route-path.js'

describe('decodeHttpPathSegment', () => {
  it('decodes a valid URL path segment', () => {
    expect(decodeHttpPathSegment('asset%20id')).toBe('asset id')
  })

  it.each(['%', '%2', '%GG', '%E0%A4%A'])('rejects malformed encoding %s as a client error', value => {
    expect(() => decodeHttpPathSegment(value)).toThrow(expect.objectContaining({
      code: 'INVALID_REQUEST',
      status: 400,
    }))
  })
})
