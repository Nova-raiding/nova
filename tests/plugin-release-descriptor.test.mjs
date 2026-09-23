import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { signPluginReleaseDescriptor, verifyPluginReleaseDescriptor } from '../scripts/plugin-release-descriptor.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-release-descriptor-'))
  const pluginRoot = join(root, 'plugin')
  mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'mcp'))
  mkdirSync(join(pluginRoot, 'skills', 'merchant-marketing'), { recursive: true })
  writeFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: 'merchant-marketing', version: '0.1.0+codex.1' }))
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '0.1.0+codex.1' }))
  writeFileSync(join(pluginRoot, 'mcp', 'bridge.mjs'), 'stdio bridge')
  writeFileSync(join(pluginRoot, 'skills', 'merchant-marketing', 'SKILL.md'), 'local skill')
  const packagePath = join(root, 'plugin.tar.gz')
  const tar = spawnSync('tar', ['-czf', packagePath, '-C', pluginRoot,
    '.codex-plugin/plugin.json', 'package.json', 'mcp/bridge.mjs', 'skills/merchant-marketing/SKILL.md'])
  assert.equal(tar.status, 0, tar.stderr?.toString())
  for (const args of [
    ['init', '-q'], ['add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source'],
  ]) {
    const git = spawnSync('git', args, { cwd: pluginRoot })
    assert.equal(git.status, 0, git.stderr?.toString())
  }
  const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: pluginRoot, encoding: 'utf8' }).stdout.trim()
  const keys = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'private.pem')
  writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const options = {
    privateKeyPath, pluginRoot, packagePath, keyId: 'local-release-2026',
    releaseId: 'release-1', gitSha, platform: 'win32-x64', mcpMethodsSha256: 'b'.repeat(64),
  }
  const verifyOptions = {
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), packagePath,
    keyId: options.keyId, releaseId: options.releaseId, gitSha: options.gitSha,
    platform: options.platform, mcpMethodsSha256: options.mcpMethodsSha256,
  }
  return { root, pluginRoot, packagePath, privateKeyPath, options, verifyOptions }
}

test('signs exact local package bytes and binds release, Git, platform, bridge and MCP identity', () => {
  const f = fixture()
  const document = signPluginReleaseDescriptor(f.options)
  assert.equal(document.schema_version, 'plugin-release/2')
  assert.equal(document.plugin_version, '0.1.0+codex.1')
  assert.equal(verifyPluginReleaseDescriptor(document, f.verifyOptions), document)
  assert.match(document.signature_base64, /^[A-Za-z0-9+/]{86}==$/u)
})

test('rejects tampered package, descriptor, wrong trust anchor and wrong candidate identity', () => {
  const f = fixture()
  const document = signPluginReleaseDescriptor(f.options)
  const original = readFileSync(f.packagePath)
  writeFileSync(f.packagePath, 'different package')
  assert.throws(() => verifyPluginReleaseDescriptor(document, f.verifyOptions), /package digest or size mismatch/u)
  writeFileSync(f.packagePath, original)
  assert.throws(() => verifyPluginReleaseDescriptor({ ...document, bridge_sha256: '0'.repeat(64) }, f.verifyOptions), /signature is invalid/u)
  assert.throws(() => verifyPluginReleaseDescriptor(document, { ...f.verifyOptions, releaseId: 'release-2' }), /release_id does not match/u)
  assert.throws(() => verifyPluginReleaseDescriptor(document, { ...f.verifyOptions, platform: 'darwin-arm64' }), /platform does not match/u)
  const other = generateKeyPairSync('ed25519')
  assert.throws(() => verifyPluginReleaseDescriptor(document, { ...f.verifyOptions, publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) }), /signature is invalid/u)
  assert.throws(() => verifyPluginReleaseDescriptor({ ...document, unexpected: true }, f.verifyOptions), /fields are not exact/u)
})

test('refuses to sign an archive whose bridge differs from its descriptor source', () => {
  const f = fixture()
  const bridge = join(f.pluginRoot, 'mcp', 'bridge.mjs')
  const original = readFileSync(bridge)
  writeFileSync(bridge, 'changed package bridge')
  const tar = spawnSync('tar', ['-czf', f.packagePath, '-C', f.pluginRoot,
    '.codex-plugin/plugin.json', 'package.json', 'mcp/bridge.mjs', 'skills/merchant-marketing/SKILL.md'])
  assert.equal(tar.status, 0, tar.stderr?.toString())
  writeFileSync(bridge, original)
  assert.throws(() => signPluginReleaseDescriptor(f.options), /bridge.mjs differs from signed source/u)
})

test('refuses dirty or differently identified Git source', () => {
  const f = fixture()
  assert.throws(() => signPluginReleaseDescriptor({ ...f.options, gitSha: 'a'.repeat(40) }), /Git SHA differs/u)
  writeFileSync(join(f.pluginRoot, 'mcp', 'bridge.mjs'), 'dirty bridge')
  assert.throws(() => signPluginReleaseDescriptor(f.options), /clean and committed/u)
})

test('refuses symlink package and permissive private key', () => {
  const f = fixture()
  const packageLink = join(f.root, 'package-link.tar.gz')
  symlinkSync(f.packagePath, packageLink)
  assert.throws(() => signPluginReleaseDescriptor({ ...f.options, packagePath: packageLink }), /regular non-symlink/u)
  const exposedKey = join(f.root, 'permissive.pem')
  writeFileSync(exposedKey, 'not a key', { mode: 0o644 })
  assert.throws(() => signPluginReleaseDescriptor({ ...f.options, privateKeyPath: exposedKey }), /0600\/0400/u)
})
