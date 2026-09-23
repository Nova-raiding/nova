import { describe, expect, it } from 'vitest'
import { FeatureFlagValidationError, validateTypedFeatureFlagValue } from './feature-flags.js'

describe('feature flag value contract', () => {
  it('accepts dense JSON arrays and objects', () => {
    expect(validateTypedFeatureFlagValue({ type: 'json', value: [null, { enabled: true }] })).toEqual({
      type: 'json', value: [null, { enabled: true }],
    })
  })

  it('rejects sparse arrays instead of silently serializing holes as null', () => {
    const sparse = Array(1)
    expect(() => validateTypedFeatureFlagValue({ type: 'json', value: sparse })).toThrow(FeatureFlagValidationError)
  })
})
