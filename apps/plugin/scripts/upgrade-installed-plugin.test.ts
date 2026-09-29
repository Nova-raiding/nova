import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const activeMarketplace = resolve(root, 'active-marketplace.txt')
  writeFileSync(activeMarketplace, realpathSync(marketplaceRoot))
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(args) + '\\n')
if (args.join(' ') === 'plugin marketplace list --json') {
  const active = fs.existsSync(process.env.FAKE_ACTIVE_MARKETPLACE) ? fs.readFileSync(process.env.FAKE_ACTIVE_MARKETPLACE, 'utf8') : null
  const root = process.env.FAKE_IGNORE_ACTIVE_MARKETPLACE === '1' ? process.env.FAKE_CONFIGURED_ROOT : active
  process.stdout.write(JSON.stringify({ marketplaces: root ? [{ name: 'merchant-local', root, marketplaceSource: { sourceType: 'local', source: root } }] : [] }))
  process.exit(0)
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  if (process.env.FAKE_FAIL_FIRST_REMOVE_AFTER_CHANGE === '1' && !fs.existsSync(process.env.FAKE_REMOVE_FAILED_ONCE)) {
    fs.writeFileSync(process.env.FAKE_REMOVE_FAILED_ONCE, '1');
    fs.rmSync(process.env.FAKE_ACTIVE_MARKETPLACE, { force: true });
    process.stderr.write('simulated timeout after remove mutation'); process.exit(2)
  }
  fs.rmSync(process.env.FAKE_ACTIVE_MARKETPLACE, { force: true });
  process.stdout.write(JSON.stringify({ ok: true })); process.exit(0)
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  if (process.env.FAKE_FAIL_STAGE_ADD_AFTER_CHANGE === '1' && args[3] !== process.env.FAKE_CONFIGURED_ROOT) {
    fs.writeFileSync(process.env.FAKE_ACTIVE_MARKETPLACE, args[3]);
    process.stderr.write('simulated staged add timeout after mutation'); process.exit(2)
  }
  if (process.env.FAKE_FAIL_RESTORE_ADD === '1' && args[3] === process.env.FAKE_CONFIGURED_ROOT) {
    process.stderr.write('simulated canonical restore add failure'); process.exit(2)
  }
  fs.writeFileSync(process.env.FAKE_ACTIVE_MARKETPLACE, args[3]);
  process.stdout.write(JSON.stringify({ ok: true })); process.exit(0)
}
if (args.join(' ') === 'plugin add merchant-marketing@merchant-local --json') {
  fs.mkdirSync(path.dirname(process.env.FAKE_INSTALLED), { recursive: true })
  let pluginSource = process.env.FAKE_MARKETPLACE_PLUGIN
  if (fs.existsSync(process.env.FAKE_ACTIVE_MARKETPLACE)) {
    const active = fs.readFileSync(process.env.FAKE_ACTIVE_MARKETPLACE, 'utf8')
    const staged = path.join(active, 'plugin')
    if (fs.existsSync(staged)) pluginSource = staged
  }
  fs.cpSync(pluginSource, process.env.FAKE_INSTALLED, { recursive: true })
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
    FAKE_CONFIGURED_ROOT: realpathSync(marketplaceRoot),
    FAKE_MARKETPLACE_PLUGIN: marketplacePlugin,
    FAKE_INSTALLED: installed,
    FAKE_ACTIVE_MARKETPLACE: activeMarketplace,
    FAKE_REMOVE_FAILED_ONCE: resolve(root, 'remove-failed-once'),
  }
  return { root, marketplaceRoot, marketplacePlugin, callsPath, fakeCodex, installed, env }
}

function stagingDirectories(root: string) {
  return readdirSync(root).filter(name => name.startsWith('.storenova-qa-stage-'))
}

function runUpgrade(fixture: ReturnType<typeof setup>, configuredRoot = fixture.marketplaceRoot, sourceRoot = source, extraArgs: string[] = []) {
  const configuredRootPath = existsSync(configuredRoot) ? realpathSync(configuredRoot) : resolve(configuredRoot)
  return spawnSync(process.execPath, [script,
    '--source', sourceRoot,
    '--local-source', fixture.marketplaceRoot,
    '--marketplace', 'merchant-local',
    '--codex', fixture.fakeCodex,
    '--codex-home', resolve(fixture.root, 'codex-home'),
    ...extraArgs,
  ], {
    encoding: 'utf8',
    env: { ...fixture.env, FAKE_CONFIGURED_ROOT: configuredRootPath,
      ...(configuredRoot === fixture.marketplaceRoot ? {} : { FAKE_IGNORE_ACTIVE_MARKETPLACE: '1' }) },
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
      if (process.platform === 'darwin') {
        rmSync(resolve(fixture.marketplacePlugin, 'mcp/keychain-credential-helper'), { force: true })
        rmSync(resolve(fixture.marketplacePlugin, 'mcp/keychain-credential-helper.build.json'), { force: true })
      }
      const result = runUpgrade(fixture)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, plugin_version: version })
      if (process.platform === 'darwin') {
        expect(existsSync(resolve(fixture.installed, 'mcp/keychain-credential-helper'))).toBe(true)
        expect(existsSync(resolve(fixture.installed, 'mcp/keychain-credential-helper.build.json'))).toBe(true)
      }
      expect(fakeCommands(fixture.callsPath)).toEqual([
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'add', 'merchant-marketing@merchant-local', '--json'],
      ])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('persists and verifies the explicit QA broker profile in a new immutable cache', () => {
    const fixture = setup()
    try {
      const result = runUpgrade(fixture, fixture.marketplaceRoot, source, ['--package-profile', 'qa-broker'])
      expect(result.status, result.stderr).toBe(0)
      const profile = JSON.parse(readFileSync(resolve(fixture.installed, 'bundle-profile.json'), 'utf8'))
      expect(profile).toMatchObject({ profile: 'qa-broker', qa_only: true, release_eligible: false,
        credential_broker: { included: true, authenticated_peer_identity: false } })
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, package_profile: { installed: 'qa-broker' } })
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('restores the canonical marketplace when remove reports failure after mutating registration', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.marketplaceRoot,
        '--marketplace', 'merchant-local', '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'),
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_FIRST_REMOVE_AFTER_CHANGE: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(readFileSync(resolve(fixture.root, 'active-marketplace.txt'), 'utf8')).toBe(realpathSync(fixture.marketplaceRoot))
      expect(fakeCommands(fixture.callsPath).filter(args => args[0] === 'plugin' && args[1] === 'marketplace'
        && (args[2] === 'remove' || args[2] === 'add'))).toEqual([
        ['plugin', 'marketplace', 'remove', 'merchant-local', '--json'],
        ['plugin', 'marketplace', 'add', realpathSync(fixture.marketplaceRoot), '--json'],
      ])
      expect(existsSync(fixture.installed)).toBe(false)
      expect(stagingDirectories(fixture.root)).toEqual([])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('checks the registry and restores canonical source when staged add fails after mutating it', () => {
    const fixture = setup()
    try {
      const failed = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.marketplaceRoot,
        '--marketplace', 'merchant-local', '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'),
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_STAGE_ADD_AFTER_CHANGE: '1' }, timeout: 30_000 })
      expect(failed.status).not.toBe(0)
      expect(failed.stderr).toContain('simulated staged add timeout after mutation')
      expect(failed.stderr).not.toContain('QA_STAGE_REGISTRY_RECOVERY_FAILED')
      expect(readFileSync(fixture.env.FAKE_ACTIVE_MARKETPLACE, 'utf8')).toBe(realpathSync(fixture.marketplaceRoot))
      expect(stagingDirectories(fixture.root)).toEqual([])
      expect(fakeCommands(fixture.callsPath).filter(args => args[0] === 'plugin' && args[1] === 'marketplace'
        && (args[2] === 'remove' || args[2] === 'add'))).toEqual([
        ['plugin', 'marketplace', 'remove', 'merchant-local', '--json'],
        ['plugin', 'marketplace', 'add', expect.stringMatching(/\.storenova-qa-stage-/u), '--json'],
        ['plugin', 'marketplace', 'remove', 'merchant-local', '--json'],
        ['plugin', 'marketplace', 'add', realpathSync(fixture.marketplaceRoot), '--json'],
      ])
      expect(fakeCommands(fixture.callsPath).some(args => args[0] === 'plugin' && args[1] === 'add')).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('reports actual missing registry and still cleans staging when canonical restore add fails', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.marketplaceRoot,
        '--marketplace', 'merchant-local', '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'),
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_RESTORE_ADD: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('QA_STAGE_REGISTRY_RECOVERY_FAILED')
      expect(result.stderr).toContain('marketplace registration is missing')
      expect(result.stderr).toContain('Manual recovery: run codex plugin marketplace remove merchant-local --json')
      expect(existsSync(fixture.env.FAKE_ACTIVE_MARKETPLACE)).toBe(false)
      expect(stagingDirectories(fixture.root)).toEqual([])
      expect(fakeCommands(fixture.callsPath).filter(args => args[0] === 'plugin' && args[1] === 'marketplace')
        .filter(args => args[2] === 'add' && args[3] === realpathSync(fixture.marketplaceRoot))).toHaveLength(2)
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
      expect(result.stderr).toContain('PLUGIN_VERSION_CONTENT_COLLISION')
      expect(result.stderr).toContain('local marketplace plugin source does not match')
      expect(result.stderr).toContain('digest differs: mcp/bridge.mjs')
      expect(result.stderr).toContain('publish and install a new plugin version')
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
      expect(result.stderr).toContain('PLUGIN_VERSION_CONTENT_COLLISION')
      expect(result.stderr).toContain(`existing cache for immutable version ${version} does not match`)
      expect(result.stderr).toContain('digest differs: mcp/bridge.mjs')
      expect(result.stderr).toContain('publish and install a new plugin version')
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
