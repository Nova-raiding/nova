import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const verifier = resolve(pluginRoot, 'scripts/verify-installed-bridge.mjs')
const bundledCommand = process.platform === 'win32' ? './runtime/node.exe' : './runtime/node'
const installationFixtureTimeoutMs = 30_000

function makeProfileFixture(profile: 'production' | 'qa-broker') {
  const directory = mkdtempSync(resolve(tmpdir(), `merchant-${profile}-verify-`))
  const source = resolve(directory, 'source')
  const installed = resolve(directory, 'installed')
  cpSync(pluginRoot, source, { recursive: true })
  if (profile === 'production') unlinkSync(resolve(source, 'mcp/keychain-broker.mjs'))
  const bundleProfile = {
    schema_version: '1',
    profile,
    qa_only: profile === 'qa-broker',
    release_eligible: profile === 'production',
    credential_broker: {
      path: 'mcp/keychain-broker.mjs',
      included: profile === 'qa-broker',
      authenticated_peer_identity: false,
      release_eligible: false,
    },
  }
  writeFileSync(resolve(source, 'bundle-profile.json'), `${JSON.stringify(bundleProfile, null, 2)}\n`)
  cpSync(source, installed, { recursive: true })
  return { directory, source, installed }
}

function verifyProfileFixture(source: string, installed: string) {
  const result = spawnSync(process.execPath, [verifier, '--source', source, '--installed', installed], { encoding: 'utf8' })
  return { result, evidence: JSON.parse(result.stdout) }
}

describe('installed MCP bridge verification', () => {
  it('accepts the exact bundled Node startup transformation and runs its tool discovery', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-bundled-verify-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(pluginRoot, installed, { recursive: true })
      const runtime = resolve(installed, 'runtime')
      mkdirSync(runtime)
      const bundledNode = resolve(installed, bundledCommand)
      // Homebrew's macOS node is a small launcher linked to a nearby dylib;
      // copying that launcher alone makes it unusable in a temporary directory.
      if (process.platform === 'darwin') symlinkSync(process.execPath, bundledNode)
      else { copyFileSync(process.execPath, bundledNode); chmodSync(bundledNode, 0o755) }
      const configPath = resolve(installed, '.mcp.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      config.mcpServers['merchant-marketing'].command = bundledCommand
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

      const result = spawnSync(process.execPath, [verifier, '--source', pluginRoot, '--installed', installed], { encoding: 'utf8' })
      const evidence = JSON.parse(result.stdout)
      expect(result.status, JSON.stringify({ stderr: result.stderr, manifest: evidence.manifest, discovery: evidence.tools.installed_discovery_error })).toBe(0)
      expect(evidence.manifest.errors).toEqual([])
      expect(evidence.tools.installed_discovery_error).toBeNull()
      expect(evidence.tools.unconfigured_call).toMatchObject({
        tool: 'workspace.health',
        blocked: true,
        error: null,
      })
      expect(['MCP_AUTH_REQUIRED', 'MCP_CONFIGURATION_REQUIRED']).toContain(evidence.tools.unconfigured_call.code)
      expect(evidence.runtime_files.find((file: { path: string }) => file.path === '.mcp.json')).toMatchObject({ matches: true })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, installationFixtureTimeoutMs)

  it('reports an older installed bridge version as drift without hiding its live tool surface', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-stale-bridge-verify-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(pluginRoot, installed, { recursive: true })
      const staleVersion = '0.1.0+codex.20261009233435'
      for (const path of ['.codex-plugin/plugin.json', 'package.json']) {
        const file = resolve(installed, path)
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        manifest.version = staleVersion
        writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
      }

      const result = spawnSync(process.execPath, [verifier, '--source', pluginRoot, '--installed', installed], { encoding: 'utf8' })
      const evidence = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(evidence.manifest.errors).toContain(`installed version does not match expected source version`)
      expect(evidence.tools.installed_discovery_error).toBeNull()
      expect(evidence.tools.count).toBeGreaterThan(0)
      expect(evidence.tools.unconfigured_call).toMatchObject({ blocked: true, error: null })
      expect(['MCP_AUTH_REQUIRED', 'MCP_CONFIGURATION_REQUIRED']).toContain(evidence.tools.unconfigured_call.code)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, installationFixtureTimeoutMs)

  it('keeps the installable marketplace verifier in sync with the canonical verifier', () => {
    const mirrorVerifier = resolve(pluginRoot, '../../.codex-marketplace/plugins/merchant-marketing/scripts/verify-installed-bridge.mjs')
    expect(readFileSync(mirrorVerifier, 'utf8')).toBe(readFileSync(verifier, 'utf8'))
  })

  it('rejects a bundled runtime path when its executable is absent', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-bundled-verify-missing-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(pluginRoot, installed, { recursive: true })
      const configPath = resolve(installed, '.mcp.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      config.mcpServers['merchant-marketing'].command = bundledCommand
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

      const result = spawnSync(process.execPath, [verifier, '--source', pluginRoot, '--installed', installed], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).manifest.errors).toContain(
        `MCP startup must use node or the present ${bundledCommand} runtime with ./mcp/bridge.mjs`,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, installationFixtureTimeoutMs)

  it.each(['scripts/verify-chatgpt-macos.mjs', 'scripts/launch-verified-chatgpt-macos.mjs'])(
    'rejects an installed plugin missing login dependency %s', missingPath => {
      const directory = mkdtempSync(resolve(tmpdir(), 'merchant-login-dependency-missing-'))
      const installed = resolve(directory, 'installed')
      try {
        cpSync(pluginRoot, installed, { recursive: true })
        unlinkSync(resolve(installed, missingPath))
        const result = spawnSync(process.execPath, [verifier, '--source', pluginRoot, '--installed', installed], { encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout).runtime_inventory.missing).toContain(missingPath)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    installationFixtureTimeoutMs,
  )

  it('requires production profile metadata and rejects a packaged credential broker', () => {
    const fixture = makeProfileFixture('production')
    try {
      const baseline = verifyProfileFixture(fixture.source, fixture.installed)
      expect(baseline.result.status, baseline.result.stderr).toBe(0)
      expect(existsSync(resolve(fixture.source, 'mcp/keychain-broker.mjs'))).toBe(false)
      expect(baseline.evidence.runtime_files.find((file: { path: string }) => file.path === 'bundle-profile.json'))
        .toMatchObject({ matches: true })
      expect(baseline.evidence.runtime_inventory.source_count).toBeGreaterThan(0)

      copyFileSync(resolve(pluginRoot, 'mcp/keychain-broker.mjs'), resolve(fixture.installed, 'mcp/keychain-broker.mjs'))
      const withBroker = verifyProfileFixture(fixture.source, fixture.installed)
      expect(withBroker.result.status).toBe(1)
      expect(withBroker.evidence.runtime_inventory.unexpected).toContain('mcp/keychain-broker.mjs')
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  }, installationFixtureTimeoutMs)

  it('requires and hashes the credential broker only for the QA profile', () => {
    const fixture = makeProfileFixture('qa-broker')
    try {
      const baseline = verifyProfileFixture(fixture.source, fixture.installed)
      expect(baseline.result.status, baseline.result.stderr).toBe(0)
      expect(baseline.evidence.runtime_files.find((file: { path: string }) => file.path === 'bundle-profile.json'))
        .toMatchObject({ matches: true })
      expect(baseline.evidence.runtime_files.find((file: { path: string }) => file.path === 'mcp/keychain-broker.mjs'))
        .toMatchObject({ matches: true })

      writeFileSync(resolve(fixture.installed, 'mcp/keychain-broker.mjs'), 'tampered broker')
      const changedBroker = verifyProfileFixture(fixture.source, fixture.installed)
      expect(changedBroker.result.status).toBe(1)
      expect(changedBroker.evidence.runtime_files.find((file: { path: string }) => file.path === 'mcp/keychain-broker.mjs'))
        .toMatchObject({ matches: false })

      unlinkSync(resolve(fixture.installed, 'mcp/keychain-broker.mjs'))
      unlinkSync(resolve(fixture.installed, 'bundle-profile.json'))
      const missingProfile = verifyProfileFixture(fixture.source, fixture.installed)
      expect(missingProfile.result.status).toBe(1)
      expect(missingProfile.evidence.runtime_inventory.missing).toContain('bundle-profile.json')
      expect(missingProfile.evidence.runtime_inventory.missing).toContain('mcp/keychain-broker.mjs')
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  }, installationFixtureTimeoutMs)
})
