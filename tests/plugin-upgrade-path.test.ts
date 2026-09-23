import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = resolve(process.cwd(), 'apps/plugin')

describe('plugin upgrade path', () => {
  it('installs through the Codex CLI and verifies the versioned runtime and tools', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-upgrade-'))
    const installed = resolve(directory, 'installed')
    const fakeCodex = resolve(directory, 'codex')
    writeFileSync(fakeCodex, `#!/usr/bin/env node
const { cpSync, mkdirSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({ marketplaces: [{ name: 'merchant-local', root: process.env.FAKE_MARKETPLACE_ROOT, marketplaceSource: { sourceType: 'local', source: process.env.FAKE_MARKETPLACE_ROOT } }] }))
  process.exit(0)
}
if (args.join(' ') === 'plugin add merchant-marketing@merchant-local --json') {
  mkdirSync(process.env.FAKE_INSTALLED, { recursive: true })
  cpSync(process.env.FAKE_MARKETPLACE_PLUGIN, process.env.FAKE_INSTALLED, { recursive: true })
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(fakeCodex, 0o755)
    try {
      const result = spawnSync(process.execPath, [resolve(source, 'scripts/upgrade-installed-plugin.mjs'),
        '--source', source, '--marketplace', 'merchant-local', '--codex', fakeCodex, '--installed', installed], {
        encoding: 'utf8',
        env: { ...process.env,
          FAKE_MARKETPLACE_ROOT: resolve(process.cwd(), '.codex-marketplace'),
          FAKE_MARKETPLACE_PLUGIN: resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing'),
          FAKE_INSTALLED: installed,
        },
      })
      expect(result.status, result.stderr).toBe(0)
      const evidence = JSON.parse(result.stdout)
      expect(evidence).toMatchObject({ ok: true, runtime_inventory: { missing: [], unexpected: [] } })
      expect(evidence.tools.missing_from_installed).toEqual([])
      expect(evidence.tools.unexpected_in_installed).toEqual([])
      expect(result.stderr).toContain('Fully restart ChatGPT/Codex')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('fails closed when an installed Skill runtime file is stale or unexpected', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-drift-'))
    const installed = resolve(directory, 'installed')
    cpSync(source, installed, { recursive: true })
    const staleSkill = resolve(installed, 'skills/merchant-marketing/references/stale-runtime.md')
    mkdirSync(resolve(staleSkill, '..'), { recursive: true })
    writeFileSync(staleSkill, 'stale runtime\n')
    try {
      const result = spawnSync(process.execPath, [resolve(source, 'scripts/verify-installed-bridge.mjs'), '--source', source, '--installed', installed], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      const evidence = JSON.parse(result.stdout)
      expect(evidence.ok).toBe(false)
      expect(evidence.runtime_inventory.unexpected).toContain('skills/merchant-marketing/references/stale-runtime.md')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('fails closed before invoking Codex when source manifest and package versions drift', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-source-version-'))
    const copiedSource = resolve(directory, 'source')
    const marker = resolve(directory, 'codex-was-called')
    const fakeCodex = resolve(directory, 'codex')
    cpSync(source, copiedSource, { recursive: true })
    const packagePath = resolve(copiedSource, 'package.json')
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
    writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, version: '9.9.9' }, null, 2)}\n`)
    writeFileSync(fakeCodex, `#!/bin/sh\ntouch "${marker}"\n`)
    chmodSync(fakeCodex, 0o755)
    try {
      const result = spawnSync(process.execPath, [resolve(copiedSource, 'scripts/upgrade-installed-plugin.mjs'), '--source', copiedSource, '--codex', fakeCodex], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('manifest and package versions differ')
      expect(() => readFileSync(marker)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when a versioned cache directory does not match the source version', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-cache-version-'))
    const installed = resolve(directory, '0.0.1')
    cpSync(source, installed, { recursive: true })
    try {
      const result = spawnSync(process.execPath, [resolve(source, 'scripts/verify-installed-bridge.mjs'), '--source', source, '--installed', installed], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      const evidence = JSON.parse(result.stdout)
      expect(evidence.ok).toBe(false)
      expect(evidence.manifest.errors).toContainEqual(expect.stringContaining('installed cache directory version'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('keeps the source and marketplace upgrade scripts byte-identical', () => {
    const marketplace = resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing')
    for (const path of ['scripts/upgrade-installed-plugin.mjs', 'scripts/upgrade-installed-plugin.test.ts', 'scripts/verify-installed-bridge.mjs', 'scripts/install-local-macos.sh']) {
      expect(readFileSync(resolve(marketplace, path), 'utf8'), path).toBe(readFileSync(resolve(source, path), 'utf8'))
    }
  })
})
