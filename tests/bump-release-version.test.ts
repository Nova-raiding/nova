import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpRelease, nextReleaseVersion } from '../scripts/bump-release-version.js'

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

describe('release version policy', () => {
  it('represents each 0.01 release step as a SemVer patch increment', () => {
    expect(nextReleaseVersion('0.1.1')).toBe('0.1.2')
    expect(nextReleaseVersion('1.4.9')).toBe('1.4.10')
  })

  it('rejects non-SemVer repository versions', () => {
    expect(() => nextReleaseVersion('0.11')).toThrow('invalid release version')
  })

  it('updates the plugin workspace lock version with all plugin release metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-version-bump-'))
    try {
      writeFileSync(join(root, 'VERSION'), '0.2.10\n')
      writeJson(join(root, 'package.json'), { version: '0.2.10' })
      writeJson(join(root, 'package-lock.json'), {
        version: '0.2.10',
        packages: {
          '': { version: '0.2.10' },
          'apps/plugin': { version: '0.1.0+codex.20261010030424' },
        },
      })
      writeJson(join(root, 'apps/plugin/package.json'), { version: '0.1.0+codex.20261010030424' })
      writeJson(join(root, 'apps/plugin/.codex-plugin/plugin.json'), { version: '0.1.0+codex.20261010030424' })
      writeJson(join(root, '.codex-marketplace/plugins/merchant-marketing/package.json'), { version: '0.1.0+codex.20261010030424' })
      writeJson(join(root, '.codex-marketplace/plugins/merchant-marketing/.codex-plugin/plugin.json'), { version: '0.1.0+codex.20261010030424' })
      writeJson(join(root, 'release-metadata.json'), { repositoryVersion: '0.2.10', pluginVersion: '0.1.0+codex.20261010030424' })
      writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')

      const result = bumpRelease(root, new Date('2026-10-11T12:34:56.000Z'))
      const lock = readJson(join(root, 'package-lock.json'))
      expect(lock.packages['apps/plugin'].version).toBe(result.pluginVersion)
      expect(readJson(join(root, 'apps/plugin/package.json')).version).toBe(result.pluginVersion)
      expect(readJson(join(root, 'apps/plugin/.codex-plugin/plugin.json')).version).toBe(result.pluginVersion)
      expect(readJson(join(root, '.codex-marketplace/plugins/merchant-marketing/package.json')).version).toBe(result.pluginVersion)
      expect(readJson(join(root, '.codex-marketplace/plugins/merchant-marketing/.codex-plugin/plugin.json')).version).toBe(result.pluginVersion)
      expect(readJson(join(root, 'release-metadata.json')).pluginVersion).toBe(result.pluginVersion)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
