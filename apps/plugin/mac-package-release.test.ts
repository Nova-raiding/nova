import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

describe('macOS production package release gate', () => {
  it.skipIf(process.platform !== 'darwin')('refuses to publish without a configured Developer ID signer', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'storenova-mac-release-gate-'))
    const output = resolve(directory, 'plugin.dmg')
    try {
      const env = { ...process.env }
      delete env.STORENOVA_MAC_SIGNER_THUMBPRINT
      delete env.STORENOVA_MAC_TEAM_ID
      delete env.STORENOVA_MAC_NOTARY_PROFILE
      const result = spawnSync(process.execPath, [resolve(process.cwd(), 'apps/plugin/scripts/build-signed-macos-package.mjs'), output], { env, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('STORENOVA_MAC_SIGNER_THUMBPRINT')
      expect(existsSync(output)).toBe(false)
      expect(existsSync(`${output}.sha256`)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')('refuses an unavailable Developer ID identity without creating a deliverable', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'storenova-mac-release-identity-'))
    const output = resolve(directory, 'plugin.dmg')
    try {
      const env = {
        ...process.env,
        STORENOVA_MAC_SIGNER_THUMBPRINT: '0'.repeat(40),
        STORENOVA_MAC_TEAM_ID: '0'.repeat(10),
        STORENOVA_MAC_NOTARY_PROFILE: 'unavailable-test-profile',
      }
      const result = spawnSync(process.execPath, [resolve(process.cwd(), 'apps/plugin/scripts/build-signed-macos-package.mjs'), output], { env, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Developer ID Application identity is unavailable')
      expect(existsSync(output)).toBe(false)
      expect(existsSync(`${output}.sha256`)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')('does not overwrite an existing release image', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'storenova-mac-release-existing-'))
    const output = resolve(directory, 'plugin.dmg')
    try {
      writeFileSync(output, 'existing release')
      const env = {
        ...process.env,
        STORENOVA_MAC_SIGNER_THUMBPRINT: '0'.repeat(40),
        STORENOVA_MAC_TEAM_ID: '0'.repeat(10),
        STORENOVA_MAC_NOTARY_PROFILE: 'unavailable-test-profile',
      }
      const result = spawnSync(process.execPath, [resolve(process.cwd(), 'apps/plugin/scripts/build-signed-macos-package.mjs'), output], { env, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('release output already exists')
      expect(readFileSync(output, 'utf8')).toBe('existing release')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
