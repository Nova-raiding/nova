import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { assertPrivateSigningKey, signPluginReleaseDescriptor, verifyPluginReleaseDescriptor, windowsSigningKeyAclProtected } from '../scripts/plugin-release-descriptor.mjs'

function appendTarMember(packageBytes, name, type = '0', linkname = '') {
  const archive = gunzipSync(packageBytes)
  let offset = 0
  while (offset + 512 <= archive.length && archive.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const size = Number.parseInt(archive.subarray(offset + 124, offset + 136).toString('ascii'), 8)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'ascii')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write('00000000000\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.fill(32, 148, 156)
  header.write(type, 156, 'ascii')
  header.write(linkname, 157, 100, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return gzipSync(Buffer.concat([archive.subarray(0, offset), header, Buffer.alloc(1024)]))
}

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

test('uses protected Windows ACL semantics without weakening POSIX private-key checks', () => {
  const f = fixture()
  assert.doesNotThrow(() => assertPrivateSigningKey(f.privateKeyPath, { platform: 'win32', windowsAclCheck: () => true }))
  assert.throws(() => assertPrivateSigningKey(f.privateKeyPath, { platform: 'win32', windowsAclCheck: () => false }), /protected current-user-only Windows ACL/u)
  assert.throws(() => assertPrivateSigningKey(f.privateKeyPath, { platform: 'darwin', effectiveUid: -1 }), /0600\/0400/u)
  const permissive = join(f.root, 'permissive-windows-test.pem')
  writeFileSync(permissive, 'test', { mode: 0o644 })
  assert.throws(() => assertPrivateSigningKey(permissive, { platform: 'linux', effectiveUid: process.geteuid() }), /0600\/0400/u)
  const link = join(f.root, 'windows-key-link.pem')
  symlinkSync(f.privateKeyPath, link)
  assert.throws(() => assertPrivateSigningKey(link, { platform: 'win32', windowsAclCheck: () => true }), /regular non-symlink/u)
})

test('Windows ACL probe binds a literal path and fails closed on PowerShell error', () => {
  const path = 'C:\\private dir\\key;not-a-command.pem'
  let invocation
  const probe = (binary, args, options) => {
    invocation = { binary, args, options }
    return { status: 0 }
  }
  assert.equal(windowsSigningKeyAclProtected(path, probe), true)
  assert.equal(invocation.binary, 'powershell.exe')
  assert.equal(invocation.options.env.STORENOVA_SIGNING_KEY_PATH, path)
  assert.equal(invocation.args[3].includes(path), false)
  assert.match(invocation.args[3], /Get-Acl -LiteralPath/u)
  assert.match(invocation.args[3], /AreAccessRulesProtected/u)
  assert.match(invocation.args[3], /WindowsIdentity/u)
  assert.equal(windowsSigningKeyAclProtected(path, () => ({ status: 2 })), false)
  assert.equal(windowsSigningKeyAclProtected(path, () => ({ status: null, error: new Error('missing PowerShell') })), false)
})

test('refuses extra links, special files, duplicate entries and Windows-unsafe archive paths before signing', () => {
  const f = fixture()
  const original = readFileSync(f.packagePath)
  const rejected = [
    { name: 'extra-link', type: '2', linkname: '/etc/passwd', reason: /non-regular file/u },
    { name: 'extra-hardlink', type: '1', linkname: 'package.json', reason: /non-regular file/u },
    { name: 'extra-fifo', type: '6', reason: /non-regular file/u },
    { name: 'package.json', reason: /duplicate path/u },
    { name: 'PACKAGE.JSON', reason: /duplicate path/u },
    { name: 'package.json/child', reason: /shadows a directory/u },
    { name: 'C:\\evil', reason: /unsafe path/u },
    { name: 'nested\\evil', reason: /unsafe path/u },
    { name: 'nested/file:stream', reason: /unsafe path/u },
    { name: 'nested/file?.js', reason: /unsafe path/u },
    { name: 'CON.txt', reason: /unsafe path/u },
    { name: 'nested/../evil', reason: /unsafe path/u },
    { name: 'nested//evil', reason: /unsafe path/u },
  ]
  for (const item of rejected) {
    writeFileSync(f.packagePath, appendTarMember(original, item.name, item.type, item.linkname))
    assert.throws(() => signPluginReleaseDescriptor(f.options), item.reason, item.name)
  }
})
