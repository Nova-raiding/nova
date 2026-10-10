import { describe, expect, it } from 'vitest'
import { optionalExpectedVersion } from './http-task-routes.js'

describe('HTTP task mutation version input', () => {
  it('allows omission for compatibility and accepts only positive safe integer versions', () => {
    expect(optionalExpectedVersion({})).toBeUndefined()
    expect(optionalExpectedVersion({ expected_version: 4 })).toBe(4)
  })

  it.each(['4', '', null, 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, true])(
    'rejects malformed expected_version %s instead of dropping the concurrency check',
    (expected_version) => {
      expect(() => optionalExpectedVersion({ expected_version })).toThrowError(
        expect.objectContaining({ code: 'EXPECTED_VERSION_INVALID', status: 400 }),
      )
    },
  )
})
