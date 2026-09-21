import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(repositoryRoot, 'apps/plugin')
const adapterRoot = resolve(repositoryRoot, '.codex-marketplace/plugins/merchant-marketing')
const verifier = resolve(sourceRoot, 'scripts/verify-installed-bridge.mjs')
const expectedVersion = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8')).version as string

describe('local plugin source adapter', () => {
  it('matches the canonical plugin runtime and tool surface through the real verifier', () => {
    const result = spawnSync(process.execPath, [
      verifier,
      '--source', sourceRoot,
      '--installed', adapterRoot,
      '--expected-version', expectedVersion,
    ], { encoding: 'utf8', timeout: 20_000 })

    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    const evidence = JSON.parse(result.stdout) as {
      ok: boolean
      plugin_version: string
      source_manifest: { version: string; package_version: string; errors: string[] }
      manifest: { errors: string[] }
      runtime_files: Array<{ path: string; matches: boolean }>
      runtime_inventory: { source_count: number; installed_count: number; missing: string[]; unexpected: string[] }
      tools: {
        count: number
        source_count: number
        missing: string[]
        forbidden: string[]
        missing_from_installed: string[]
        unexpected_in_installed: string[]
        duplicates: string[]
      }
    }

    expect(evidence).toMatchObject({
      ok: true,
      plugin_version: expectedVersion,
      source_manifest: { version: expectedVersion, package_version: expectedVersion, errors: [] },
      manifest: { errors: [] },
      runtime_inventory: { missing: [], unexpected: [] },
      tools: {
        missing: [],
        forbidden: [],
        missing_from_installed: [],
        unexpected_in_installed: [],
        duplicates: [],
      },
    })
    expect(evidence.runtime_inventory.source_count).toBeGreaterThan(0)
    expect(evidence.runtime_inventory.installed_count).toBe(evidence.runtime_inventory.source_count)
    expect(evidence.runtime_files).toHaveLength(evidence.runtime_inventory.source_count)
    expect(evidence.runtime_files.every(file => file.matches)).toBe(true)
    expect(evidence.tools.source_count).toBeGreaterThan(0)
    expect(evidence.tools.count).toBe(evidence.tools.source_count)
  })
})
