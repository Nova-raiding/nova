import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = resolve(process.cwd(), 'apps/plugin')
const script = resolve(source, 'scripts/upgrade-installed-plugin.mjs')
const version = JSON.parse(readFileSync(resolve(source, '.codex-plugin/plugin.json'), 'utf8')).version as string

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-safe-upgrade-'))
  const marketplaceRoot = resolve(root, 'marketplace')
  const marketplacePlugin = resolve(marketplaceRoot, 'plugins/merchant-marketing')
  mkdirSync(marketplacePlugin, { recursive: true })
  cpSync(source, marketplacePlugin, { recursive: true })
  writeFileSync(resolve(marketplaceRoot, 'marketplace.json'), JSON.stringify({
    name: 'merchant-local',
    plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: './plugins/merchant-marketing' } }],
  }, null, 2))

  const callsPath = resolve(root, 'codex-calls.jsonl')
  const fakeCodex = resolve(root, 'codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(args) + '\\n')
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({ marketplaces: [{ name: 'merchant-local', root: process.env.FAKE_CONFIGURED_ROOT, marketplaceSource: { sourceType: 'local', source: process.env.FAKE_CONFIGURED_ROOT } }] }))
  process.exit(0)
}
if (args.join(' ') === 'plugin add merchant-marketing@merchant-local --json') {
  fs.mkdirSync(path.dirname(process.env.FAKE_INSTALLED), { recursive: true })
  fs.cpSync(process.env.FAKE_MARKETPLACE_PLUGIN, process.env.FAKE_INSTALLED, { recursive: true })
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
process.stderr.write('unexpected fake Codex command')
process.exit(2)
`)
  chmodSync(fakeCodex, 0o755)
  const installed = resolve(root, 'codex-home/plugins/cache/merchant-local/merchant-marketing', version)
  const env = {
    ...process.env,
    FAKE_CODEX_CALLS: callsPath,
    FAKE_CONFIGURED_ROOT: marketplaceRoot,
    FAKE_MARKETPLACE_PLUGIN: marketplacePlugin,
    FAKE_INSTALLED: installed,
  }
  return { root, marketplaceRoot, marketplacePlugin, callsPath, fakeCodex, installed, env }
}

function runUpgrade(fixture: ReturnType<typeof setup>, configuredRoot = fixture.marketplaceRoot, sourceRoot = source) {
  return spawnSync(process.execPath, [script,
    '--source', sourceRoot,
    '--local-source', fixture.marketplaceRoot,
    '--marketplace', 'merchant-local',
    '--codex', fixture.fakeCodex,
    '--codex-home', resolve(fixture.root, 'codex-home'),
  ], {
    encoding: 'utf8',
    env: { ...fixture.env, FAKE_CONFIGURED_ROOT: configuredRoot },
    timeout: 30_000,
  })
}

function fakeCommands(path: string) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as string[])
}

describe('safe local plugin upgrade preflight', () => {
  it('checks the local marketplace and complete source mirror before installing', () => {
    const fixture = setup()
    try {
      const result = runUpgrade(fixture)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, plugin_version: version })
      expect(fakeCommands(fixture.callsPath)).toEqual([
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'add', 'merchant-marketing@merchant-local', '--json'],
      ])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('refuses an unexpected registered marketplace root before plugin add', () => {
    const fixture = setup()
    try {
      const result = runUpgrade(fixture, resolve(fixture.root, 'other-source'))
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('does not resolve to the expected local source')
      expect(fakeCommands(fixture.callsPath)).toEqual([['plugin', 'marketplace', 'list', '--json']])
      expect(existsSync(fixture.installed)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it('refuses a marketplace mirror whose runtime bytes differ from the source', () => {
    const fixture = setup()
    try {
      writeFileSync(resolve(fixture.marketplacePlugin, 'mcp/bridge.mjs'), 'stale bridge')
      const result = runUpgrade(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('local marketplace plugin source does not match')
      expect(result.stderr).toContain('digest differs: mcp/bridge.mjs')
      expect(fakeCommands(fixture.callsPath)).toEqual([['plugin', 'marketplace', 'list', '--json']])
      expect(existsSync(fixture.installed)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it('refuses a marketplace mirror with an unbound plugin version before invoking Codex', () => {
    const fixture = setup()
    try {
      const manifestPath = resolve(fixture.marketplacePlugin, '.codex-plugin/plugin.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.version = '9.9.9'
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      const result = runUpgrade(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('local marketplace plugin manifest/package version must match source plugin')
      expect(fakeCommands(fixture.callsPath)).toEqual([])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it('refuses to overwrite an existing cache path when the immutable version has drifted', () => {
    const fixture = setup()
    try {
      mkdirSync(fixture.installed, { recursive: true })
      cpSync(source, fixture.installed, { recursive: true })
      writeFileSync(resolve(fixture.installed, 'mcp/bridge.mjs'), 'cache from different bytes')
      const result = runUpgrade(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`existing cache for immutable version ${version} does not match`)
      expect(result.stderr).toContain('digest differs: mcp/bridge.mjs')
      expect(fakeCommands(fixture.callsPath)).toEqual([['plugin', 'marketplace', 'list', '--json']])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('rejects invalid source bundle provenance before invoking Codex', () => {
    const fixture = setup()
    const sourceCopy = resolve(fixture.root, 'source')
    cpSync(source, sourceCopy, { recursive: true })
    writeFileSync(resolve(sourceCopy, 'bundle-provenance.json'), '{invalid json')
    try {
      const result = runUpgrade(fixture, fixture.marketplaceRoot, sourceCopy)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('source bundle provenance is invalid')
      expect(fakeCommands(fixture.callsPath)).toEqual([])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })
})
