import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(`apps/plugin/scripts/${path}`, 'utf8')
const mirror = (path: string) => readFileSync(`.codex-marketplace/plugins/merchant-marketing/scripts/${path}`, 'utf8')

describe('local plugin package release profile contract', () => {
  it('keeps package and release gates byte-identical in the marketplace mirror', () => {
    for (const path of [
      'local-plugin-package-profile.mjs',
      'package-local-plugin.mjs',
      'build-signed-macos-package.mjs',
      'build-signed-windows-package.ps1',
    ]) expect(mirror(path), path).toBe(source(path))
  })

  it('ships the installer verifier dependencies in every local package', () => {
    const packaging = source('package-local-plugin.mjs')
    const start = packaging.indexOf('const required = [')
    const end = packaging.indexOf(']\nfor (const relativePath of required)', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const required = packaging.slice(start, end)
    expect(required).toContain("'scripts/package-local-plugin.mjs'")
    expect(required).toContain("'scripts/local-plugin-package-profile.mjs'")
  })

  it('forces and verifies production profile in both signed release builders', () => {
    const mac = source('build-signed-macos-package.mjs')
    expect(mac).toContain("candidate, '--profile', 'production'")
    expect(mac.match(/assertReleaseEligiblePackageProfile/gu)).toHaveLength(3)

    const windows = source('build-signed-windows-package.ps1')
    expect(windows).toContain("$packageArguments += @('--profile', 'production')")
    expect(windows).toContain("$bundleProfile.profile -ne 'production'")
    expect(windows).toContain('$bundleProfile.release_eligible -ne $true')
    expect(windows).toContain('$bundleProfile.credential_broker.included -ne $false')
  })

  it('verifies candidate provenance before macOS signing and provenance rewriting', () => {
    const mac = source('build-signed-macos-package.mjs')
    const verifyIndex = mac.indexOf('const candidateProvenanceCheck = verifyBundleProvenance(staged)')
    const signIndex = mac.indexOf("run('/usr/bin/codesign', ['--force', '--sign', signer, '--options', 'runtime'")
    const rewriteIndex = mac.indexOf('writeBundleProvenance(staged, {')
    expect(verifyIndex).toBeGreaterThan(mac.indexOf("run('/usr/bin/tar', ['-xzf', candidate, '-C', staged])"))
    expect(verifyIndex).toBeGreaterThan(-1)
    expect(verifyIndex).toBeLessThan(signIndex)
    expect(verifyIndex).toBeLessThan(rewriteIndex)
    expect(mac.slice(verifyIndex, signIndex)).toContain('candidateProvenanceCheck.source_dirty !== false')
    expect(mac.slice(verifyIndex, signIndex)).toContain('candidateProvenanceCheck.version !== manifest.version')
    expect(mac.slice(verifyIndex, signIndex)).toContain("candidateProvenanceCheck.platform !== 'darwin'")
    expect(mac.slice(verifyIndex, signIndex)).toContain('candidateProvenanceCheck.architecture !== process.arch')
  })

  it('keeps every QA broker archive non-installable as a release candidate', () => {
    const packaging = source('package-local-plugin.mjs')
    expect(packaging).toContain('ready_to_install: profileManifest.release_eligible === true')
    expect(packaging).toContain("if (profileManifest.qa_only) bundleStatus.release_status = 'qa_only'")
  })
})
