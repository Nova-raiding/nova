import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript packaging module
import { assertPackageProfileEntries, assertReleaseEligiblePackageProfile, packageProfileManifest, parsePackageCliArgs, profileSourceEntries, readPackageProfile } from './local-plugin-package-profile.mjs'

describe('local plugin package profiles', () => {
  it('defaults to a production package that declares and excludes the QA broker', () => {
    expect(readPackageProfile([], {})).toBe('production')
    expect(profileSourceEntries('production', () => true)).toEqual([])
    expect(packageProfileManifest('production')).toMatchObject({
      profile: 'production', qa_only: false, release_eligible: true,
      credential_broker: { included: false, authenticated_peer_identity: false, release_eligible: false },
    })
    expect(() => assertPackageProfileEntries('production', ['bundle-profile.json', 'mcp/keychain-broker.mjs']))
      .toThrow('production package must not contain the unauthenticated credential broker')
  })

  it('allows only the fail-closed production profile through a release gate', () => {
    expect(assertReleaseEligiblePackageProfile(packageProfileManifest('production'))).toMatchObject({ profile: 'production' })
    expect(() => assertReleaseEligiblePackageProfile(packageProfileManifest('qa-broker')))
      .toThrow('release-eligible production bundle profile')
    expect(() => assertReleaseEligiblePackageProfile({ profile: 'production', qa_only: false, release_eligible: true }))
      .toThrow('release-eligible production bundle profile')
  })

  it('marks the QA profile itself as release-ineligible', () => {
    expect(packageProfileManifest('qa-broker')).toMatchObject({
      profile: 'qa-broker', qa_only: true, release_eligible: false,
      credential_broker: { included: true, authenticated_peer_identity: false, release_eligible: false },
    })
  })

  it('requires the broker source and exactly one packaged broker for the explicit QA profile', () => {
    expect(readPackageProfile(['out.tar.gz', '--profile', 'qa-broker'], {})).toBe('qa-broker')
    expect(() => profileSourceEntries('qa-broker', () => false)).toThrow('QA broker package input is missing')
    expect(profileSourceEntries('qa-broker', () => true)).toEqual(['mcp/keychain-broker.mjs'])
    expect(() => assertPackageProfileEntries('qa-broker', ['bundle-profile.json']))
      .toThrow('QA broker package must contain exactly one')
    expect(assertPackageProfileEntries('qa-broker', ['mcp/keychain-broker.mjs', 'bundle-profile.json'])).toMatchObject({ qa_only: true })
  })

  it('rejects ambiguous, missing, and unknown profile selection', () => {
    expect(() => readPackageProfile(['--profile'], {})).toThrow('profile value is required')
    expect(() => readPackageProfile(['--profile', 'qa-broker', '--profile', 'production'], {})).toThrow('only once')
    expect(() => readPackageProfile(['--profile', 'qa-broker'], { STORENOVA_PLUGIN_PACKAGE_PROFILE: 'production' })).toThrow('disagree')
    expect(() => readPackageProfile([], { STORENOVA_PLUGIN_PACKAGE_PROFILE: 'debug' })).toThrow('unsupported')
  })

  it('does not treat a leading CLI option as the output path', () => {
    expect(parsePackageCliArgs(['--profile', 'qa-broker'])).toEqual({
      output: undefined, windowsHelperDirectory: undefined, ciTestCertificate: false,
    })
    expect(parsePackageCliArgs(['artifact.tar.gz', '--profile', 'production'])).toMatchObject({ output: 'artifact.tar.gz' })
    expect(parsePackageCliArgs(['--profile', 'production', 'artifact.tar.gz'])).toMatchObject({ output: 'artifact.tar.gz' })
  })

  it('fails closed for ambiguous or unsupported CLI package arguments', () => {
    expect(() => parsePackageCliArgs(['one.tar.gz', 'two.tar.gz'])).toThrow('output may be specified only once')
    expect(() => parsePackageCliArgs(['--windows-helper-dir', 'one', '--windows-helper-dir', 'two'])).toThrow('only once')
    expect(() => parsePackageCliArgs(['--ci-test-certificate', '--ci-test-certificate'])).toThrow('only once')
    expect(() => parsePackageCliArgs(['--unknown'])).toThrow('unsupported')
  })
})
