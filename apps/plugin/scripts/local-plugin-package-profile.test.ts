import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript packaging module
import { assertPackageProfileEntries, assertReleaseEligiblePackageProfile, packageProfileManifest, packageInstallStatus, parsePackageCliArgs, profileSourceEntries, readPackageProfile } from './local-plugin-package-profile.mjs'

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


describe('local stdio package installation status', () => {
  const nativeVerified = { profile: 'production', platform: 'darwin', sourceDirty: false,
    gitCommit: 'a'.repeat(40), bundledRuntimeVerified: true, nativeHelperVerified: true,
    windowsHelperVerified: false, ciTestCertificate: false }

  it('marks a verified clean native macOS package ready for local installation', () => {
    expect(packageInstallStatus(nativeVerified)).toEqual({ release_status: 'local_stdio_candidate', ready_to_install: true })
  })

  it.each([
    ['dirty source', { sourceDirty: true }],
    ['unverified source cleanliness', { sourceDirty: undefined }],
    ['missing Git source identity', { gitCommit: '' }],
    ['invalid Git source identity', { gitCommit: 'not-a-commit' }],
    ['missing bundled Node validation', { bundledRuntimeVerified: false }],
    ['unverified bundled Node validation', { bundledRuntimeVerified: undefined }],
    ['missing native source/binary validation', { nativeHelperVerified: false }],
    ['unverified native source/binary validation', { nativeHelperVerified: undefined }],
    ['test certificate mode', { ciTestCertificate: true }],
    ['unverified certificate mode', { ciTestCertificate: undefined }],
  ])('does not mark a native package ready with %s', (_label, missing) => {
    expect(packageInstallStatus({ ...nativeVerified, ...missing }).ready_to_install).toBe(false)
  })

  it('keeps both clean and dirty QA broker packages QA-only and not ready', () => {
    for (const sourceDirty of [false, true]) {
      expect(packageInstallStatus({ ...nativeVerified, profile: 'qa-broker', sourceDirty }))
        .toEqual({ release_status: 'qa_only', ready_to_install: false })
    }
  })

  it('preserves Windows helper verification and non-test certificate requirements', () => {
    const windowsVerified = { ...nativeVerified, platform: 'win32', nativeHelperVerified: false, windowsHelperVerified: true }
    expect(packageInstallStatus(windowsVerified)).toEqual({ release_status: 'signed_candidate', ready_to_install: true })
    expect(packageInstallStatus({ ...windowsVerified, windowsHelperVerified: false }).ready_to_install).toBe(false)
    expect(packageInstallStatus({ ...windowsVerified, ciTestCertificate: true }))
      .toEqual({ release_status: 'ci_test_only', ready_to_install: false })
  })

  it('does not mark an unsupported desktop platform ready', () => {
    expect(packageInstallStatus({ ...nativeVerified, platform: 'linux' }).ready_to_install).toBe(false)
  })
})
