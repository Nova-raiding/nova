import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = resolve(process.cwd(), 'apps/plugin')
const script = resolve(source, 'scripts/install-local-plugin.mjs')
const version = JSON.parse(readFileSync(resolve(source, '.codex-plugin/plugin.json'), 'utf8')).version as string

function setup(sourceRoot = source, { marketplaceSourceRoot }: { marketplaceSourceRoot?: string } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-direct-install-'))
  const localSource = resolve(root, 'marketplace')
  const marketplacePlugin = resolve(localSource, 'plugins/merchant-marketing')
  mkdirSync(marketplacePlugin, { recursive: true })
  cpSync(marketplaceSourceRoot ?? sourceRoot, marketplacePlugin, { recursive: true })
  if (!marketplaceSourceRoot) writeFileSync(resolve(marketplacePlugin, 'bundle-profile.json'), `${JSON.stringify({
    schema_version: '1', profile: 'qa-broker', qa_only: true, release_eligible: false,
    credential_broker: { path: 'mcp/keychain-broker.mjs', included: true, authenticated_peer_identity: false, release_eligible: false },
  }, null, 2)}\n`)
  writeFileSync(resolve(localSource, 'marketplace.json'), JSON.stringify({
    name: 'merchant-local-test',
    plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: './plugins/merchant-marketing' } }],
  }))
  const calls = resolve(root, 'codex-calls.jsonl')
  const fakeCodex = resolve(root, 'codex')
  const activeMarketplace = resolve(root, 'active-marketplace.txt')
  const installed = resolve(root, 'codex-home/plugins/cache/merchant-local-test/merchant-marketing', version)
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CODEX_CALLS,JSON.stringify(args)+'\\n')
if(args.join(' ')==='plugin marketplace list --json'){
 if(process.env.FAKE_INVALID_LIST_AFTER_ADD==='1'&&fs.existsSync(process.env.FAKE_ADD_OCCURRED_FILE)){process.stdout.write('{not-json');process.exit(0)}
 const root=fs.existsSync(process.env.FAKE_ACTIVE_MARKETPLACE)?fs.readFileSync(process.env.FAKE_ACTIVE_MARKETPLACE,'utf8'):null
 process.stdout.write(JSON.stringify({marketplaces:root?[{name:'merchant-local-test',root,marketplaceSource:{sourceType:'local',source:root}}]:[]}));process.exit(0)
}
if(args[0]==='plugin'&&args[1]==='marketplace'&&args[2]==='add'){
 if(process.env.FAKE_UNKNOWN_ON_ADD==='1'){fs.writeFileSync(process.env.FAKE_ACTIVE_MARKETPLACE,process.env.FAKE_UNKNOWN_ROOT);process.stderr.write('simulated unexpected registration');process.exit(2)}
 if(process.env.FAKE_FAIL_ADD_BEFORE==='1'){process.stderr.write('simulated marketplace add failure before mutation');process.exit(2)}
 fs.writeFileSync(process.env.FAKE_ACTIVE_MARKETPLACE,args[3])
 if(process.env.FAKE_INVALID_LIST_AFTER_ADD==='1')fs.writeFileSync(process.env.FAKE_ADD_OCCURRED_FILE,'yes')
 if(process.env.FAKE_FAIL_ADD_AFTER==='1'){process.stderr.write('simulated marketplace add failure after mutation');process.exit(2)}
 process.stdout.write('{"ok":true}\\n');process.exit(0)
}
if(args[0]==='plugin'&&args[1]==='marketplace'&&args[2]==='remove'){
 if(process.env.FAKE_FAIL_REMOVE_BEFORE==='1'){process.stderr.write('simulated marketplace cleanup failure');process.exit(2)}
 fs.rmSync(process.env.FAKE_ACTIVE_MARKETPLACE,{force:true})
 process.stdout.write('{"ok":true}\\n');process.exit(0)
}
if(args.join(' ')==='plugin add merchant-marketing@merchant-local-test --json'){
 if(process.env.FAKE_FAIL_INSTALL_BEFORE==='1'){process.stderr.write('simulated install failure before mutation');process.exit(2)}
 fs.mkdirSync(path.dirname(process.env.FAKE_INSTALLED),{recursive:true});fs.cpSync(process.env.FAKE_SOURCE_ROOT,process.env.FAKE_INSTALLED,{recursive:true})
 if(process.env.FAKE_CORRUPT_INSTALL==='1')fs.writeFileSync(path.join(process.env.FAKE_INSTALLED,'mcp/bridge.mjs'),'corrupted install')
 if(process.env.FAKE_FAIL_INSTALL_AFTER==='1'){process.stderr.write('simulated install failure after mutation');process.exit(2)}
 process.stdout.write('{"ok":true}\\n');process.exit(0)
}
process.stderr.write('unexpected fake Codex command');process.exit(2)
`)
  chmodSync(fakeCodex, 0o755)
  return {
    root, localSource, marketplacePlugin, fakeCodex, installed, calls, activeMarketplace,
    env: { ...process.env, FAKE_CODEX_CALLS: calls, FAKE_INSTALLED: installed, FAKE_SOURCE_ROOT: marketplacePlugin,
      FAKE_ACTIVE_MARKETPLACE: activeMarketplace, FAKE_ADD_OCCURRED_FILE: resolve(root, 'marketplace-add-observed.txt') },
  }
}

function runInstall(fixture: ReturnType<typeof setup>, sourceRoot = source) {
  return spawnSync(process.execPath, [script, '--source', sourceRoot, '--local-source', fixture.localSource, '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed, '--package-profile', 'qa-broker'], {
    encoding: 'utf8', env: fixture.env, timeout: 150_000,
  })
}

function codexCommands(fixture: ReturnType<typeof setup>) {
  if (!existsSync(fixture.calls)) return []
  return readFileSync(fixture.calls, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as string[])
}

function rollbackDirectories(fixture: ReturnType<typeof setup>) {
  const cacheParent = resolve(fixture.installed, '..')
  return existsSync(cacheParent) ? readdirSync(cacheParent).filter(name => name.startsWith('.storenova-local-install-rollback-')) : []
}

describe('direct local plugin install runtime build', () => {
  // The macOS path builds the Keychain helper under its own 120s bound.
  it('installs the checked-in marketplace mirror with its explicit QA-only package profile', () => {
    const fixture = setup(source, { marketplaceSourceRoot: resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing') })
    try {
      const result = runInstall(fixture)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: 'local_stdio', restart_required: true })
      expect(codexCommands(fixture).some(command => command.slice(0, 3).join(' ') === 'plugin marketplace add')).toBe(true)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 180_000)

  it('rejects a marketplace plugin path that escapes its canonical plugins directory', () => {
    const fixture = setup()
    try {
      const escapedPlugin = resolve(fixture.root, 'escaped-plugin')
      cpSync(fixture.marketplacePlugin, escapedPlugin, { recursive: true })
      writeFileSync(resolve(fixture.localSource, 'marketplace.json'), JSON.stringify({
        name: 'merchant-local-test',
        plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: '../escaped-plugin' } }],
      }))

      const result = runInstall(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('local marketplace source for merchant-marketing must resolve to')
      expect(existsSync(fixture.calls)).toBe(false)
      expect(existsSync(fixture.installed)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it.skipIf(process.platform !== 'darwin')('builds and validates the macOS Keychain helper before reporting the installed bridge usable', () => {
    const fixture = setup()
    try {
      const result = runInstall(fixture)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: 'local_stdio', version, restart_required: true })
      if (process.platform === 'darwin') {
        expect(existsSync(resolve(fixture.installed, 'mcp/keychain-credential-helper'))).toBe(true)
        expect(existsSync(resolve(fixture.installed, 'mcp/keychain-credential-helper.build.json'))).toBe(true)
      }
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 150_000)

  it.skipIf(process.platform !== 'darwin')('fails explicitly and emits no success result when the helper build fails', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-broken-helper-source-'))
    const sourceCopy = resolve(temp, 'plugin')
    cpSync(source, sourceCopy, { recursive: true })
    rmSync(resolve(sourceCopy, 'mcp/keychain-credential-helper'), { force: true })
    rmSync(resolve(sourceCopy, 'mcp/keychain-credential-helper.build.json'), { force: true })
    writeFileSync(resolve(sourceCopy, 'scripts/build-keychain-helper.mjs'), `process.stderr.write('simulated Swift compiler failure'); process.exit(1)\n`)
    const fixture = setup(sourceCopy)
    try {
      const result = runInstall(fixture, sourceCopy)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('LOCAL_PLUGIN_KEYCHAIN_BUILD_FAILED')
      expect(result.stderr).toContain('simulated Swift compiler failure')
      expect(result.stdout).not.toContain('"ok": true')
      expect(existsSync(fixture.installed)).toBe(false)
      expect(existsSync(resolve(fixture.installed, 'mcp/keychain-credential-helper'))).toBe(false)
      expect(existsSync(fixture.activeMarketplace)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }) }
  }, 150_000)

  it.skipIf(process.platform !== 'darwin')('does not report success when the builder exits zero without valid helper artifacts', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-empty-helper-source-'))
    const sourceCopy = resolve(temp, 'plugin')
    cpSync(source, sourceCopy, { recursive: true })
    writeFileSync(resolve(sourceCopy, 'scripts/build-keychain-helper.mjs'), `process.stdout.write('builder returned without artifacts')\n`)
    const fixture = setup(sourceCopy)
    try {
      const result = runInstall(fixture, sourceCopy)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('LOCAL_PLUGIN_KEYCHAIN_HELPER_INVALID')
      expect(result.stdout).not.toContain('"ok": true')
      expect(existsSync(fixture.installed)).toBe(false)
      expect(existsSync(fixture.activeMarketplace)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }) }
  }, 150_000)

  it('rejects a same-version marketplace mirror with different runtime bytes before invoking Codex', () => {
    const fixture = setup()
    try {
      writeFileSync(resolve(fixture.marketplacePlugin, 'mcp/bridge.mjs'), 'same version, different runtime')
      const result = runInstall(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('PLUGIN_VERSION_CONTENT_COLLISION')
      expect(result.stderr).toContain('digest differs: mcp/bridge.mjs')
      expect(result.stderr).toContain('publish and install a new plugin version')
      expect(existsSync(fixture.calls)).toBe(false)
      expect(existsSync(fixture.installed)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('rejects a same-version cache with different runtime bytes before plugin add', () => {
    const fixture = setup()
    try {
      mkdirSync(fixture.installed, { recursive: true })
      cpSync(source, fixture.installed, { recursive: true })
      writeFileSync(resolve(fixture.installed, 'mcp/bridge.mjs'), 'same version, stale cache')
      const result = runInstall(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('PLUGIN_VERSION_CONTENT_COLLISION')
      expect(result.stderr).toContain(`existing cache for immutable version ${version}`)
      expect(result.stderr).toContain('publish and install a new plugin version')
      expect(existsSync(fixture.calls)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('checks that a failed marketplace add did not leave a registration behind', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_ADD_BEFORE: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('simulated marketplace add failure before mutation')
      expect(existsSync(fixture.activeMarketplace)).toBe(false)
      expect(existsSync(fixture.installed)).toBe(false)
      expect(codexCommands(fixture).filter(args => args[2] === 'add' || args[2] === 'remove')).toEqual([
        ['plugin', 'marketplace', 'add', fixture.localSource, '--json'],
      ])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('removes a registration when marketplace add reports failure after changing the registry', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_ADD_AFTER: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('simulated marketplace add failure after mutation')
      expect(result.stderr).not.toContain('LOCAL_PLUGIN_REGISTRY_ROLLBACK_FAILED')
      expect(existsSync(fixture.activeMarketplace)).toBe(false)
      expect(existsSync(fixture.installed)).toBe(false)
      expect(codexCommands(fixture).filter(args => args[2] === 'add' || args[2] === 'remove')).toEqual([
        ['plugin', 'marketplace', 'add', fixture.localSource, '--json'],
        ['plugin', 'marketplace', 'remove', 'merchant-local-test', '--json'],
      ])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('leaves registry state untouched when marketplace listing becomes unreadable after add', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], {
        encoding: 'utf8', env: { ...fixture.env, FAKE_INVALID_LIST_AFTER_ADD: '1' }, timeout: 30_000,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('LOCAL_PLUGIN_MARKETPLACE_ADD_STATE_UNKNOWN')
      expect(result.stderr).toContain('LOCAL_PLUGIN_REGISTRY_ROLLBACK_FAILED')
      expect(result.stderr).toContain('inspect with codex plugin marketplace list --json before manually removing merchant-local-test')
      expect(readFileSync(fixture.activeMarketplace, 'utf8')).toBe(fixture.localSource)
      expect(existsSync(fixture.installed)).toBe(false)
      expect(codexCommands(fixture)).toEqual([
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'marketplace', 'add', fixture.localSource, '--json'],
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'marketplace', 'list', '--json'],
      ])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('rolls back a partial cache and its newly added registry while preserving the install error', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_INSTALL_AFTER: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('simulated install failure after mutation')
      expect(result.stderr).not.toContain('LOCAL_PLUGIN_CACHE_ROLLBACK_FAILED')
      expect(result.stderr).not.toContain('LOCAL_PLUGIN_REGISTRY_ROLLBACK_FAILED')
      expect(existsSync(fixture.installed)).toBe(false)
      expect(existsSync(fixture.activeMarketplace)).toBe(false)
      expect(rollbackDirectories(fixture)).toEqual([])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('removes an install whose command succeeds but whose cached bridge fails verification', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], {
        encoding: 'utf8', env: { ...fixture.env, FAKE_CORRUPT_INSTALL: '1' }, timeout: 30_000,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('installed local plugin differs from its source package')
      expect(existsSync(fixture.installed)).toBe(false)
      expect(existsSync(fixture.activeMarketplace)).toBe(false)
      expect(rollbackDirectories(fixture)).toEqual([])
      expect(codexCommands(fixture)).toEqual([
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'marketplace', 'add', fixture.localSource, '--json'],
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'add', 'merchant-marketing@merchant-local-test', '--json'],
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'marketplace', 'remove', 'merchant-local-test', '--json'],
        ['plugin', 'marketplace', 'list', '--json'],
      ])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('keeps the original install error visible when marketplace cleanup itself fails', () => {
    const fixture = setup()
    try {
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_INSTALL_AFTER: '1', FAKE_FAIL_REMOVE_BEFORE: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('simulated install failure after mutation')
      expect(result.stderr).toContain('LOCAL_PLUGIN_REGISTRY_ROLLBACK_FAILED')
      expect(result.stderr).toContain(realpathSync(fixture.localSource))
      expect(existsSync(fixture.activeMarketplace)).toBe(true)
      expect(existsSync(fixture.installed)).toBe(false)
      expect(rollbackDirectories(fixture)).toEqual([])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('refuses an unknown pre-existing marketplace and leaves it untouched', () => {
    const fixture = setup()
    try {
      const unknown = resolve(fixture.root, 'other-marketplace')
      mkdirSync(unknown)
      writeFileSync(fixture.activeMarketplace, unknown)
      const result = runInstall(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('LOCAL_PLUGIN_UNKNOWN_MARKETPLACE')
      expect(result.stderr).toContain(unknown)
      expect(readFileSync(fixture.activeMarketplace, 'utf8')).toBe(unknown)
      expect(codexCommands(fixture).some(args => args[2] === 'add' || args[2] === 'remove')).toBe(false)
      expect(existsSync(fixture.installed)).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('does not remove a different registration that appears while marketplace add fails', () => {
    const fixture = setup()
    try {
      const unknown = resolve(fixture.root, 'concurrent-marketplace')
      mkdirSync(unknown)
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_UNKNOWN_ON_ADD: '1', FAKE_UNKNOWN_ROOT: unknown }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('LOCAL_PLUGIN_UNKNOWN_MARKETPLACE')
      expect(result.stderr).toContain('LOCAL_PLUGIN_REGISTRY_ROLLBACK_SKIPPED')
      expect(readFileSync(fixture.activeMarketplace, 'utf8')).toBe(unknown)
      expect(existsSync(fixture.installed)).toBe(false)
      expect(codexCommands(fixture).some(args => args[2] === 'remove')).toBe(false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)

  it('restores a verified existing cache and preserves its pre-existing marketplace on failure', () => {
    const fixture = setup()
    try {
      writeFileSync(fixture.activeMarketplace, realpathSync(fixture.localSource))
      mkdirSync(fixture.installed, { recursive: true })
      cpSync(fixture.marketplacePlugin, fixture.installed, { recursive: true })
      const sourceBridge = readFileSync(resolve(source, 'mcp/bridge.mjs'), 'utf8')
      const result = spawnSync(process.execPath, [script, '--source', source, '--local-source', fixture.localSource,
        '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed,
        '--package-profile', 'qa-broker'], { encoding: 'utf8', env: { ...fixture.env, FAKE_FAIL_INSTALL_AFTER: '1' }, timeout: 30_000 })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('simulated install failure after mutation')
      expect(readFileSync(resolve(fixture.installed, 'mcp/bridge.mjs'), 'utf8')).toBe(sourceBridge)
      expect(readFileSync(fixture.activeMarketplace, 'utf8')).toBe(realpathSync(fixture.localSource))
      expect(codexCommands(fixture).some(args => args[2] === 'remove')).toBe(false)
      expect(rollbackDirectories(fixture)).toEqual([])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }, 30_000)
})
