import { describe, expect, it } from 'vitest'
import { nextReleaseVersion } from '../scripts/bump-release-version.js'

describe('release version policy', () => {
  it('represents each 0.01 release step as a SemVer patch increment', () => {
    expect(nextReleaseVersion('0.1.1')).toBe('0.1.2')
    expect(nextReleaseVersion('1.4.9')).toBe('1.4.10')
  })

  it('rejects non-SemVer repository versions', () => {
    expect(() => nextReleaseVersion('0.11')).toThrow('invalid release version')
  })
})
