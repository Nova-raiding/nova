import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { installBundledPlugin } from './install-chatgpt-bundled.mjs'
import { writeBundleProvenance } from './bundle-provenance.mjs'

const plugin = 'merchant-marketing'
const version = '0.1.0+codex.20260923125500'

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'storenova-bundled-install-'))
  const source = resolve(root, 'package')
  const home = resolve(root, 'home')
  const agentsHome = resolve(home, '.agents')
  const codexHome = resolve(home, '.codex')
  const destination = resolve(home, 'plugins', plugin)
  const cache = resolve(codexHome, 'plugins', 'cache', 'merchant-personal', plugin, 'local')
  const registry = resolve(agentsHome, 'plugins', 'marketplace.json')
  const config = resolve(codexHome, 'config.toml')
  mkdirSync(resolve(source, '.codex-plugin'), { recursive: true })
  mkdirSync(resolve(source, 'runtime'), { recursive: true })
  mkdirSync(resolve(source, 'mcp'), { recursive: true })
  writeFileSync(resolve(source, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: plugin, name: plugin, version, mcpServers: './.mcp.json' }))
  writeFileSync(resolve(source, 'package.json'), JSON.stringify({ name: '@merchant-marketing/plugin', version }))
  writeFileSync(resolve(source, '.mcp.json'), JSON.stringify({ mcpServers: { [plugin]: { command: 'node', args: ['./mcp/bridge.mjs'] } } }))
  writeFileSync(resolve(source, 'mcp', 'bridge.mjs'), 'new-version-bridge')
  writeFileSync(resolve(source, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), 'test-runtime')
  writeBundleProvenance(source, { plugin, version, platform: process.platform, architecture: process.arch,
    gitCommit: 'a'.repeat(40), sourceDirty: false })
  return { root, source, home, agentsHome, codexHome, destination, cache, registry, config,
    run: (beforeConfigCommit?: () => void, afterConfigMoved?: () => void) => installBundledPlugin({ sourceRoot: source, home, agentsHome, codexHome, beforeConfigCommit, afterConfigMoved }),
    cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function knownPlugin(path: string) {
  mkdirSync(resolve(path, '.codex-plugin'), { recursive: true })
  writeFileSync(resolve(path, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: plugin, name: plugin, version, mcpServers: './.mcp.json' }))
  writeFileSync(resolve(path, 'package.json'), JSON.stringify({ name: '@merchant-marketing/plugin', version }))
  writeFileSync(resolve(path, '.mcp.json'), JSON.stringify({ mcpServers: { [plugin]: { command: 'node', args: ['./mcp/bridge.mjs'] } } }))
  mkdirSync(resolve(path, 'mcp'), { recursive: true })
  writeFileSync(resolve(path, 'mcp', 'bridge.mjs'), 'source-of-previous-version')
  writeFileSync(resolve(path, 'merchant-note.txt'), 'keep this previous version')
}

function registryAt(path: string, sourcePath = './plugins/merchant-marketing') {
  mkdirSync(resolve(path, '..'), { recursive: true })
  const text = JSON.stringify({ name: 'merchant-personal', plugins: [{ name: plugin, source: { source: 'local', path: sourcePath } }] })
  writeFileSync(path, text)
  return text
}

describe('bundled ChatGPT local installer safety', () => {
  it('refuses an unknown existing destination without modifying it or user configuration', () => {
    const f = fixture()
    try {
      mkdirSync(f.destination, { recursive: true })
      writeFileSync(resolve(f.destination, 'user-data.txt'), 'do not remove')
      const before = registryAt(f.registry)
      mkdirSync(resolve(f.config, '..'), { recursive: true })
      writeFileSync(f.config, 'model = "user-choice"\n')
      expect(() => f.run()).toThrow(/not recognized as Store Nova/u)
      expect(readFileSync(resolve(f.destination, 'user-data.txt'), 'utf8')).toBe('do not remove')
      expect(readFileSync(f.registry, 'utf8')).toBe(before)
      expect(readFileSync(f.config, 'utf8')).toBe('model = "user-choice"\n')
      expect(existsSync(f.cache)).toBe(false)
    } finally { f.cleanup() }
  })

  it('refuses a registry entry for the same name from another source', () => {
    const f = fixture()
    try {
      const before = registryAt(f.registry, './other-plugin')
      expect(() => f.run()).toThrow(/different source/u)
      expect(readFileSync(f.registry, 'utf8')).toBe(before)
      expect(existsSync(f.destination)).toBe(false)
    } finally { f.cleanup() }
  })

  it('rejects a package version that could escape the cache directory', () => {
    const f = fixture()
    try {
      writeFileSync(resolve(f.source, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: plugin, name: plugin, version: '../../../other', mcpServers: './.mcp.json' }))
      expect(() => f.run()).toThrow(/Bundled plugin manifest is invalid/u)
      expect(existsSync(f.destination)).toBe(false)
      expect(existsSync(f.cache)).toBe(false)
    } finally { f.cleanup() }
  })

  it('keeps recoverable source and cache backups after a known Store Nova upgrade', () => {
    const f = fixture()
    try {
      knownPlugin(f.destination)
      knownPlugin(f.cache)
      registryAt(f.registry)
      mkdirSync(resolve(f.config, '..'), { recursive: true })
      writeFileSync(f.config, '[plugins."merchant-marketing@merchant-personal"]\nenabled = false\n')
      const result = f.run()
      expect(result.ok).toBe(true)
      expect(result.previous_source).toBeTruthy()
      expect(result.previous_cache).toBeTruthy()
      expect(readFileSync(resolve(result.previous_source!, 'merchant-note.txt'), 'utf8')).toBe('keep this previous version')
      expect(readFileSync(resolve(result.previous_cache!, 'merchant-note.txt'), 'utf8')).toBe('keep this previous version')
      expect(readFileSync(result.previous_config!, 'utf8')).toContain('enabled = false')
      expect(existsSync(resolve(f.destination, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))).toBe(true)
      expect(readFileSync(f.config, 'utf8')).toContain('enabled = true')
    } finally { f.cleanup() }
  })

  it('restores the old directories and registry after a post-swap failure', () => {
    const f = fixture()
    try {
      knownPlugin(f.destination)
      knownPlugin(f.cache)
      const before = registryAt(f.registry)
      expect(() => f.run(() => { throw new Error('injected failure') })).toThrow('injected failure')
      expect(readFileSync(resolve(f.destination, 'merchant-note.txt'), 'utf8')).toBe('keep this previous version')
      expect(readFileSync(resolve(f.cache, 'merchant-note.txt'), 'utf8')).toBe('keep this previous version')
      expect(readFileSync(f.registry, 'utf8')).toBe(before)
      expect(existsSync(f.config)).toBe(false)
    } finally { f.cleanup() }
  })

  it('does not overwrite a concurrent config.toml edit and rolls back the upgrade', () => {
    const f = fixture()
    try {
      knownPlugin(f.destination)
      const before = registryAt(f.registry)
      mkdirSync(resolve(f.config, '..'), { recursive: true })
      writeFileSync(f.config, 'model = "old"\n')
      expect(() => f.run(() => writeFileSync(f.config, 'model = "concurrent-edit"\n'))).toThrow(/changed during installation/u)
      expect(readFileSync(f.config, 'utf8')).toBe('model = "concurrent-edit"\n')
      expect(readFileSync(resolve(f.destination, 'merchant-note.txt'), 'utf8')).toBe('keep this previous version')
      expect(readFileSync(f.registry, 'utf8')).toBe(before)
    } finally { f.cleanup() }
  })

  it('does not replace a config file created after the old one was moved aside', () => {
    const f = fixture()
    try {
      knownPlugin(f.destination)
      const before = registryAt(f.registry)
      mkdirSync(resolve(f.config, '..'), { recursive: true })
      writeFileSync(f.config, 'model = "old"\n')
      expect(() => f.run(undefined, () => writeFileSync(f.config, 'model = "concurrent-creation"\n'))).toThrow()
      expect(readFileSync(f.config, 'utf8')).toBe('model = "concurrent-creation"\n')
      expect(readFileSync(resolve(f.destination, 'merchant-note.txt'), 'utf8')).toBe('keep this previous version')
      expect(readFileSync(f.registry, 'utf8')).toBe(before)
      const backups = readdirSync(f.codexHome).filter(name => name.startsWith('.config-previous-'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(resolve(f.codexHome, backups[0]!), 'utf8')).toBe('model = "old"\n')
    } finally { f.cleanup() }
  })
})
