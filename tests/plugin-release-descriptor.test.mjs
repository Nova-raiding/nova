import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync, deflateRawSync } from 'node:zlib'
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
    releaseId: 'release-1', gitSha, platform: 'darwin-arm64', mcpMethodsSha256: 'b'.repeat(64),
  }
  const verifyOptions = {
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), packagePath,
    keyId: options.keyId, releaseId: options.releaseId, gitSha: options.gitSha,
    platform: options.platform, mcpMethodsSha256: options.mcpMethodsSha256,
  }
  return { root, pluginRoot, packagePath, privateKeyPath, options, verifyOptions }
}

function zipBytes(entries, dataDescriptor = false) {
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    return value >>> 0
  })
  const crc = bytes => {
    let value = 0xffffffff
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
    return (value ^ 0xffffffff) >>> 0
  }
  const locals = [], centrals = []
  let offset = 0
  for (const { name, content, unixMode = 0o100644, advertisedSize } of entries) {
    const path = Buffer.from(name)
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const compressed = deflateRawSync(body)
    const checksum = crc(body)
    const size = advertisedSize ?? body.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(dataDescriptor ? 0x808 : 0x800, 6)
    local.writeUInt16LE(8, 8)
    if (!dataDescriptor) {
      local.writeUInt32LE(checksum, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(size, 22)
    }
    local.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(dataDescriptor ? 0x808 : 0x800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(path.length, 28)
    central.writeUInt32LE((unixMode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    const descriptor = Buffer.alloc(dataDescriptor ? 16 : 0)
    if (dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(checksum, 4)
      descriptor.writeUInt32LE(compressed.length, 8)
      descriptor.writeUInt32LE(size, 12)
    }
    locals.push(local, path, compressed, descriptor)
    centrals.push(central, path)
    offset += local.length + path.length + compressed.length + descriptor.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

function windowsZipFixture(extra = []) {
  const value = fixture()
  const entries = [
    '.codex-plugin/plugin.json', 'package.json', 'mcp/bridge.mjs', 'skills/merchant-marketing/SKILL.md',
  ].map(name => ({ name, content: readFileSync(join(value.pluginRoot, name)) }))
  writeFileSync(value.packagePath, zipBytes([...entries, ...extra]))
  value.options.platform = 'win32-x64'
  value.verifyOptions.platform = 'win32-x64'
  return { ...value, entries }
}

test('signs a real Windows ZIP while the old gzip-only verifier rejects its bytes', () => {
  const f = windowsZipFixture()
  assert.throws(() => gunzipSync(readFileSync(f.packagePath)), /incorrect header|unknown compression|Z_DATA_ERROR/u)
  const document = signPluginReleaseDescriptor(f.options)
  assert.equal(document.platform, 'win32-x64')
  assert.equal(verifyPluginReleaseDescriptor(document, f.verifyOptions), document)
  writeFileSync(f.packagePath, Buffer.concat([readFileSync(f.packagePath), Buffer.from('tampered')]))
  assert.throws(() => verifyPluginReleaseDescriptor(document, f.verifyOptions), /package digest or size mismatch/u)
})

test('accepts a standard ZIP tool archive with the same signed source bytes', t => {
  const f = windowsZipFixture()
  unlinkSync(f.packagePath)
  const zip = spawnSync('zip', ['-q', '-X', f.packagePath,
    '.codex-plugin/plugin.json', 'package.json', 'mcp/bridge.mjs', 'skills/merchant-marketing/SKILL.md'], { cwd: f.pluginRoot })
  if (zip.error?.code === 'ENOENT') return t.skip('zip CLI unavailable on this test host')
  assert.equal(zip.status, 0, zip.stderr?.toString())
  assert.equal(signPluginReleaseDescriptor(f.options).platform, 'win32-x64')
})

test('accepts Windows-style ZIP data descriptors while retaining exact byte binding', () => {
  const f = windowsZipFixture()
  writeFileSync(f.packagePath, zipBytes(f.entries, true))
  const document = signPluginReleaseDescriptor(f.options)
  assert.equal(verifyPluginReleaseDescriptor(document, f.verifyOptions), document)
})

test('rejects unsafe Windows ZIP traversal, symlink, duplicate, and oversized members before signing', () => {
  for (const [entry, reason] of [
    [{ name: '../escape.js', content: 'x' }, /unsafe path/u],
    [{ name: 'nested\\escape.js', content: 'x' }, /unsafe path/u],
    [{ name: 'PACKAGE.JSON', content: 'x' }, /duplicate path/u],
    [{ name: 'extra-link', content: 'target', unixMode: 0o120777 }, /non-regular file/u],
    [{ name: 'oversized.bin', content: 'x', advertisedSize: 33 * 1024 * 1024 }, /exceeds limit/u],
  ]) {
    const f = windowsZipFixture([entry])
    assert.throws(() => signPluginReleaseDescriptor(f.options), reason, entry.name)
  }
})

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
  assert.throws(() => verifyPluginReleaseDescriptor(document, { ...f.verifyOptions, platform: 'win32-x64' }), /platform does not match/u)
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
