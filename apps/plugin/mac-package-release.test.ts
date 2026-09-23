import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
})
