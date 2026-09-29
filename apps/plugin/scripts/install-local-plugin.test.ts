import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = resolve(process.cwd(), 'apps/plugin')
const script = resolve(source, 'scripts/install-local-plugin.mjs')
const version = JSON.parse(readFileSync(resolve(source, '.codex-plugin/plugin.json'), 'utf8')).version as string

function setup(sourceRoot = source) {
  const root = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-direct-install-'))
  const localSource = resolve(root, 'marketplace')
  mkdirSync(localSource, { recursive: true })
  writeFileSync(resolve(localSource, 'marketplace.json'), JSON.stringify({ name: 'merchant-local-test' }))
  const calls = resolve(root, 'codex-calls.jsonl')
  const fakeCodex = resolve(root, 'codex')
  const installed = resolve(root, 'codex-home/plugins/cache/merchant-local-test/merchant-marketing', version)
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CODEX_CALLS,JSON.stringify(args)+'\\n')
if(args.join(' ')==='plugin marketplace list'){process.stdout.write('MARKETPLACE ROOT\\n');process.exit(0)}
if(args[0]==='plugin'&&args[1]==='marketplace'&&args[2]==='add'){process.stdout.write('{"ok":true}\\n');process.exit(0)}
if(args.join(' ')==='plugin add merchant-marketing@merchant-local-test --json'){fs.mkdirSync(path.dirname(process.env.FAKE_INSTALLED),{recursive:true});fs.cpSync(process.env.FAKE_SOURCE_ROOT,process.env.FAKE_INSTALLED,{recursive:true});process.stdout.write('{"ok":true}\\n');process.exit(0)}
process.stderr.write('unexpected fake Codex command');process.exit(2)
`)
  chmodSync(fakeCodex, 0o755)
  return {
    root, localSource, fakeCodex, installed, calls,
    env: { ...process.env, FAKE_CODEX_CALLS: calls, FAKE_INSTALLED: installed, FAKE_SOURCE_ROOT: sourceRoot },
  }
}

function runInstall(fixture: ReturnType<typeof setup>, sourceRoot = source) {
  return spawnSync(process.execPath, [script, '--source', sourceRoot, '--local-source', fixture.localSource, '--codex', fixture.fakeCodex, '--codex-home', resolve(fixture.root, 'codex-home'), '--installed', fixture.installed], {
    encoding: 'utf8', env: fixture.env, timeout: 150_000,
  })
}

describe('direct local plugin install runtime build', () => {
  it('builds and validates the macOS Keychain helper before reporting the installed bridge usable', () => {
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
      expect(existsSync(fixture.installed)).toBe(true)
      expect(existsSync(resolve(fixture.installed, 'mcp/keychain-credential-helper'))).toBe(false)
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
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }) }
  }, 150_000)
})
