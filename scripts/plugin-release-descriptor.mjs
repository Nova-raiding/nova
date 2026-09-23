#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const gitSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
const safeVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(value)
const payloadKeys = [
  'schema_version', 'release_id', 'git_sha', 'plugin_id', 'plugin_version',
  'platform', 'package_sha256', 'package_bytes', 'bridge_sha256',
  'manifest_sha256', 'skill_sha256', 'mcp_methods_sha256', 'key_id',
]
// Extracted from the SHA-256-pinned node-v22.16.0-win-x64.zip used by the
// local package builder. No other ZIP member receives the large-file limit.
const WINDOWS_NODE_EXE = Object.freeze({
  path: 'runtime/node.exe', bytes: 85_119_640,
  sha256: 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19',
})
const MAC_NODE = Object.freeze({
  'darwin-arm64': { bytes: 110_503_408, sha256: 'a45751fbfe88440bebff63cd44814e4ed6deb642bc3e3c4a14c4f8ae0ed9e019' },
  'darwin-x64': { bytes: 113_613_056, sha256: '2e95af03362db552f1fa606cc20f95ec47cf6e8e564674a5262633933af1de66' },
})

function regularBytes(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return readFileSync(path)
}

const windowsSigningKeyAclScript = `
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:STORENOVA_SIGNING_KEY_PATH -Force
if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 2 }
$acl = Get-Acl -LiteralPath $env:STORENOVA_SIGNING_KEY_PATH
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($null -eq $current -or $owner.Value -ne $current.Value -or -not $acl.AreAccessRulesProtected) { exit 2 }
$selfAllowed = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne 'Allow') { continue }
  $sid = $rule.IdentityReference.Value
  if ($sid -eq $current.Value) { $selfAllowed = $true; continue }
  if ($sid -ne 'S-1-5-18') { exit 2 }
}
if (-not $selfAllowed) { exit 2 }
`

export function windowsSigningKeyAclProtected(path, run = spawnSync) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsSigningKeyAclScript], {
    env: { ...process.env, STORENOVA_SIGNING_KEY_PATH: path }, windowsHide: true,
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024,
  })
  return result.status === 0 && !result.error
}

export function assertPrivateSigningKey(path, options = {}) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('plugin signing key must be a regular non-symlink file')
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (!(options.windowsAclCheck ?? windowsSigningKeyAclProtected)(path)) {
      throw new Error('plugin signing key requires a protected current-user-only Windows ACL')
    }
    return
  }
  const effectiveUid = options.effectiveUid ?? (typeof process.geteuid === 'function' ? process.geteuid() : undefined)
  if (!Number.isSafeInteger(effectiveUid) || stat.uid !== effectiveUid || (stat.mode & 0o077) !== 0) {
    throw new Error('plugin signing key must be owner-owned regular 0600/0400 file')
  }
}

function tarField(header, start, length) {
  const field = header.subarray(start, start + length)
  const end = field.indexOf(0)
  if (end >= 0 && field.subarray(end).some(byte => byte !== 0)) throw new Error('plugin package has malformed tar metadata')
  if (field.subarray(0, end < 0 ? field.length : end).some(byte => byte < 33 || byte > 126)) {
    throw new Error('plugin package has non-ASCII tar path metadata')
  }
  return field.subarray(0, end < 0 ? field.length : end).toString('ascii')
}

function tarOctal(header, start, length) {
  const field = header.subarray(start, start + length)
  if (field.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) {
    throw new Error('plugin package has unsupported tar number encoding')
  }
  const value = field.toString('ascii')
  if (!/^[ ]*[0-7]+[ ]*\0*[ ]*$/u.test(value)) throw new Error('plugin package has unsupported tar number encoding')
  const number = Number.parseInt(value.match(/[0-7]+/u)[0], 8)
  if (!Number.isSafeInteger(number)) throw new Error('plugin package tar number is unsafe')
  return number
}

function safePackagePath(name) {
  if (!name || name.startsWith('/') || /[^\x21-\x7e]/u.test(name) || /[\\:<>"?*|]/u.test(name)) return false
  const parts = name.split('/')
  return parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

function verifyTarPackageContents(packageBytes, expected, platform) {
  let archive
  try { archive = gunzipSync(packageBytes, { maxOutputLength: 256 * 1024 * 1024 }) }
  catch { throw new Error('plugin package is not a bounded readable tar.gz archive') }
  if (archive.length % 512 !== 0) throw new Error('plugin package tar block size is invalid')
  const entries = new Map()
  const foldedNames = new Set()
  let offset = 0
  let terminated = false
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > archive.length || archive.subarray(offset).some(byte => byte !== 0)) {
        throw new Error('plugin package has nonzero data after tar terminator')
      }
      terminated = true
      break
    }
    if (foldedNames.size >= 10_000) throw new Error('plugin package contains too many files')
    const checksum = tarOctal(header, 148, 8)
    let actualChecksum = 0
    for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== actualChecksum) throw new Error('plugin package tar header checksum is invalid')
    if (header.subarray(257, 262).toString('ascii') !== 'ustar') throw new Error('plugin package requires unambiguous USTAR headers')
    const name = tarField(header, 0, 100)
    const prefix = tarField(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const type = header[156]
    const directory = type === 53
    const normalizedPath = directory && path.endsWith('/') ? path.slice(0, -1) : path
    if (!safePackagePath(normalizedPath)) throw new Error(`plugin package contains an unsafe path: ${path}`)
    const folded = normalizedPath.toLowerCase()
    if (foldedNames.has(folded)) throw new Error(`plugin package contains a duplicate path: ${path}`)
    foldedNames.add(folded)
    if (type !== 0 && type !== 48 && !directory) throw new Error(`plugin package contains a non-regular file: ${path}`)
    if (header.subarray(157, 257).some(byte => byte !== 0)) throw new Error(`plugin package file has a link target: ${path}`)
    if ((tarOctal(header, 100, 8) & 0o7000) !== 0) throw new Error(`plugin package contains a privileged file mode: ${path}`)
    const size = tarOctal(header, 124, 12)
    const end = offset + 512 + size
    const pinnedRuntime = path === 'runtime/node' ? MAC_NODE[platform] : undefined
    const limit = pinnedRuntime?.bytes ?? 32 * 1024 * 1024
    if (end > archive.length || size > limit || (directory && size !== 0)) throw new Error(`plugin package file size is unsafe: ${path}`)
    if (!directory) {
      const contents = archive.subarray(offset + 512, end)
      if (pinnedRuntime && (size !== pinnedRuntime.bytes || digest(contents) !== pinnedRuntime.sha256)) {
        throw new Error('plugin package runtime/node differs from the pinned macOS Node executable')
      }
      entries.set(path, contents)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!terminated || entries.size === 0) throw new Error('plugin package tar terminator or files are missing')
  const fileFoldedNames = new Set([...entries.keys()].map(path => path.toLowerCase()))
  for (const path of entries.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (fileFoldedNames.has(parts.slice(0, i).join('/').toLowerCase())) throw new Error(`plugin package file shadows a directory: ${path}`)
    }
  }
  for (const [entry, bytes] of Object.entries(expected)) {
    const actual = entries.get(entry)
    if (!actual) throw new Error(`plugin package must contain exactly one ${entry}`)
    if (!actual.equals(bytes)) throw new Error(`plugin package ${entry} differs from signed source`)
  }
  return entries
}

const ZIP_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})
function zipCrc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = ZIP_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function verifyZipPackageContents(bytes, expected) {
  // The Windows publisher emits a ZIP, not a tar.gz. Parse only bounded,
  // single-disk ZIP32 store/deflate entries; do not trust an external unzip
  // tool's path normalization or silently accept ZIP64/overlapping members.
  const fail = message => { throw new Error(`plugin ZIP ${message}`) }
  const number = (offset, width) => {
    if (offset < 0 || offset + width > bytes.length) fail('is truncated')
    return width === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset)
  }
  const safeExtras = (start, length) => {
    const end = start + length
    if (end > bytes.length) fail('extra field is truncated')
    for (let at = start; at < end;) {
      if (at + 4 > end) fail('extra field is malformed')
      const kind = number(at, 2), size = number(at + 2, 2)
      if (kind === 0x0001 || kind === 0x7075 || at + 4 + size > end) fail('ZIP64 or alternate path metadata is forbidden')
      at += 4 + size
    }
  }
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (number(offset, 4) === 0x06054b50 && offset + 22 + number(offset + 20, 2) === bytes.length) { eocd = offset; break }
  }
  if (eocd < 0 || number(eocd + 4, 2) !== 0 || number(eocd + 6, 2) !== 0
    || number(eocd + 8, 2) !== number(eocd + 10, 2)) fail('requires one complete disk')
  const count = number(eocd + 10, 2), centralSize = number(eocd + 12, 4), centralStart = number(eocd + 16, 4)
  if (!count || count > 10000 || count === 0xffff || centralStart === 0xffffffff || centralSize === 0xffffffff
    || centralStart + centralSize !== eocd) fail('central directory is invalid or ZIP64')
  const entries = new Map(), foldedNames = new Set(), segments = []
  let cursor = centralStart, totalUncompressed = 0
  for (let index = 0; index < count; index++) {
    if (number(cursor, 4) !== 0x02014b50 || cursor + 46 > eocd) fail('central entry is malformed')
    const madeBy = number(cursor + 4, 2), flags = number(cursor + 8, 2), method = number(cursor + 10, 2)
    const crc = number(cursor + 16, 4), compressed = number(cursor + 20, 4), uncompressed = number(cursor + 24, 4)
    const nameLength = number(cursor + 28, 2), extraLength = number(cursor + 30, 2), commentLength = number(cursor + 32, 2)
    const disk = number(cursor + 34, 2), external = number(cursor + 38, 4), localOffset = number(cursor + 42, 4)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > eocd || disk !== 0 || !nameLength || compressed === 0xffffffff || uncompressed === 0xffffffff
      || localOffset === 0xffffffff || flags & ~(0x800 | 0x8) || ![0, 8].includes(method)) fail('entry uses unsupported ZIP features')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) fail('entry name is not valid UTF-8')
    const directory = name.endsWith('/')
    if (!safePackagePath(directory ? name.slice(0, -1) : name)) fail(`contains an unsafe path: ${name}`)
    const folded = name.toLowerCase().replace(/\/$/u, '')
    if (foldedNames.has(folded)) fail(`contains a duplicate path: ${name}`)
    foldedNames.add(folded)
    const unixType = (external >>> 16) & 0o170000
    const dosDirectory = (external & 0x10) !== 0
    if ((unixType && unixType !== (directory ? 0o040000 : 0o100000)) || (dosDirectory !== directory && dosDirectory)
      || (external & 0x400) !== 0) fail(`contains a non-regular file: ${name}`)
    if (directory && (compressed !== 0 || uncompressed !== 0)) fail(`directory has data: ${name}`)
    safeExtras(cursor + 46 + nameLength, extraLength)
    if (number(localOffset, 4) !== 0x04034b50 || localOffset + 30 > centralStart) fail('local entry is missing')
    const localFlags = number(localOffset + 6, 2), localMethod = number(localOffset + 8, 2)
    const localNameLength = number(localOffset + 26, 2), localExtraLength = number(localOffset + 28, 2)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength
      || dataEnd > centralStart || !bytes.subarray(localOffset + 30, localOffset + 30 + nameLength).equals(nameBytes)) fail(`local entry differs: ${name}`)
    safeExtras(localOffset + 30 + localNameLength, localExtraLength)
    if (!(flags & 0x8) && (number(localOffset + 14, 4) !== crc || number(localOffset + 18, 4) !== compressed
      || number(localOffset + 22, 4) !== uncompressed)) fail(`local size or CRC differs: ${name}`)
    const memberLimit = name === WINDOWS_NODE_EXE.path ? WINDOWS_NODE_EXE.bytes : 32 * 1024 * 1024
    if (uncompressed > memberLimit || (totalUncompressed += uncompressed) > 256 * 1024 * 1024) fail('expanded content exceeds limit')
    const raw = bytes.subarray(dataStart, dataEnd)
    let content
    try {
      if (method === 0) content = raw
      else {
        const inflated = inflateRawSync(raw, { maxOutputLength: memberLimit, info: true })
        if (inflated.engine.bytesWritten !== raw.length) fail(`compressed data has hidden trailing bytes: ${name}`)
        content = inflated.buffer
      }
    }
    catch { fail(`compressed data is invalid: ${name}`) }
    if (content.length !== uncompressed || zipCrc32(content) !== crc) fail(`size or CRC mismatch: ${name}`)
    if (name === WINDOWS_NODE_EXE.path && (content.length !== WINDOWS_NODE_EXE.bytes || digest(content) !== WINDOWS_NODE_EXE.sha256)) {
      fail('runtime/node.exe differs from the pinned Windows Node executable')
    }
    if (!directory) entries.set(name, content)
    segments.push({ start: localOffset, end: dataEnd, descriptor: Boolean(flags & 0x8), crc, compressed, uncompressed })
    cursor = next
  }
  if (cursor !== eocd) fail('central directory has trailing data')
  segments.sort((a, b) => a.start - b.start)
  if (segments[0]?.start !== 0) fail('contains an unreviewed prefix')
  for (let index = 0; index < segments.length; index++) {
    const item = segments[index], boundary = segments[index + 1]?.start ?? centralStart
    const gap = boundary - item.end
    if (!item.descriptor && gap !== 0) fail('contains overlapping or hidden entry data')
    if (item.descriptor) {
      const signed = gap === 16 && number(item.end, 4) === 0x08074b50
      if (gap !== 12 && !signed) fail('data descriptor is malformed')
      const at = item.end + (signed ? 4 : 0)
      if (number(at, 4) !== item.crc || number(at + 4, 4) !== item.compressed || number(at + 8, 4) !== item.uncompressed) fail('data descriptor differs')
    }
  }
  for (const path of entries.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) if (entries.has(parts.slice(0, index).join('/'))) fail(`file shadows a directory: ${path}`)
  }
  for (const [path, expectedBytes] of Object.entries(expected)) {
    const actual = entries.get(path)
    if (!actual || !actual.equals(expectedBytes)) fail(`${path} differs from signed source`)
  }
  return entries
}

function gitOutput(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error('plugin source must be in a readable Git checkout')
  return result.stdout.trim()
}

function verifyTrackedPackageSources(entries, pluginRoot, platform) {
  const result = spawnSync('git', ['-C', pluginRoot, 'ls-files', '-z', '--cached'], { maxBuffer: 1024 * 1024 })
  if (result.status !== 0 || result.error) throw new Error('plugin tracked source inventory is unavailable')
  const tracked = new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))
  if (entries.has('.mcp.json')) {
    const config = JSON.parse(regularBytes(resolve(pluginRoot, '.mcp.json'), 'plugin MCP config').toString('utf8'))
    config.mcpServers['merchant-marketing'].command = platform?.startsWith('win32-') ? './runtime/node.exe' : './runtime/node'
    const expected = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
    if (!entries.get('.mcp.json').equals(expected)) throw new Error('plugin package .mcp.json differs from clean Git-derived config')
  }
  const hasBuilder = tracked.has('scripts/package-local-plugin.mjs')
  if (hasBuilder) {
    const builder = regularBytes(resolve(pluginRoot, 'scripts/package-local-plugin.mjs'), 'plugin package builder').toString('utf8')
    const declaration = builder.match(/const required = \[([\s\S]*?)\]\nfor \(const relativePath of required\)/u)
    if (!declaration || declaration[1].replace(/'[^']+'|[\s,]/gu, '') !== '') {
      throw new Error('plugin package builder required-file list cannot be verified')
    }
    for (const match of declaration[1].matchAll(/'([^']+)'/gu)) {
      if (!entries.has(match[1])) throw new Error(`plugin package is missing required source: ${match[1]}`)
    }
  }
  for (const [path, bytes] of entries) {
    // The packager rewrites .mcp.json to use its bundled local Node runtime.
    if (path === '.mcp.json') continue
    if (!tracked.has(path)) {
      if (platform?.startsWith('win32-') && path === WINDOWS_NODE_EXE.path) continue // fixed upstream digest was checked by ZIP parser
      if (MAC_NODE[platform] && path === 'runtime/node') continue // fixed upstream digest was checked by tar parser
      if (hasBuilder) continue // every generated byte is compared with a fresh clean-source build below
      if (/(?:\.(?:mjs|js|cjs|sh|command|cmd|ps1|exe|dll|zip)|\/node|\/keychain-credential-helper)$/iu.test(path)) {
        throw new Error(`plugin package executable ${path} lacks an independently trusted build hash`)
      }
      throw new Error(`plugin package generated file ${path} lacks an independently trusted build hash`)
    }
    const source = regularBytes(resolve(pluginRoot, path), `plugin source ${path}`)
    if (!bytes.equals(source)) throw new Error(`plugin package ${path} differs from clean Git source`)
  }
  return hasBuilder
}

function verifyRebuiltPackage(entries, pluginRoot, platform, verifyContents) {
  if (process.platform !== platform.split('-')[0] || process.arch !== platform.split('-')[1]) {
    throw new Error('plugin package must be signed on its matching build platform and architecture')
  }
  const isolated = mkdtempSync(resolve(tmpdir(), 'storenova-plugin-rebuild-'))
  try {
    const output = resolve(isolated, platform.startsWith('win32-') ? 'rebuilt.zip' : 'rebuilt.tar.gz')
    const args = [resolve(pluginRoot, 'scripts/package-local-plugin.mjs'), output]
    if (platform.startsWith('win32-')) {
      const helper = resolve(isolated, 'signed-helper')
      mkdirSync(helper)
      for (const path of ['windows/StoreNovaCredentialHelper.exe', 'windows/StoreNovaCredentialHelper.exe.sha256']) {
        const bytes = entries.get(path)
        if (!bytes) throw new Error(`plugin package is missing signed Windows helper evidence: ${path}`)
        writeFileSync(resolve(helper, basename(path)), bytes, { mode: 0o600 })
      }
      args.push('--windows-helper-dir', helper)
    }
    const result = spawnSync(process.execPath, args, {
      cwd: resolve(pluginRoot, '..', '..'), encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024,
    })
    if (result.status !== 0 || result.error) {
      throw new Error(`plugin clean-source rebuild failed: ${result.stderr?.trim() || result.error?.message || result.status}`)
    }
    const rebuilt = verifyContents(regularBytes(output, 'plugin clean-source rebuild'), {}, platform)
    if (entries.size !== rebuilt.size) throw new Error('plugin package inventory differs from clean-source rebuild')
    for (const [path, bytes] of entries) {
      if (!rebuilt.get(path)?.equals(bytes)) throw new Error(`plugin package ${path} differs from clean-source rebuild`)
    }
  } finally { rmSync(isolated, { recursive: true, force: true }) }
}

function canonicalPayload(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('descriptor must be an object')
  const keys = Object.keys(document).sort()
  if (keys.join('\0') !== [...payloadKeys, 'signature_base64'].sort().join('\0')) throw new Error('descriptor fields are not exact')
  const payload = Object.fromEntries(payloadKeys.map(key => [key, document[key]]))
  if (payload.schema_version !== 'plugin-release/2') throw new Error('descriptor schema is not plugin-release/2')
  if (!safeId(payload.release_id) || !gitSha(payload.git_sha) || !safeId(payload.plugin_id)
    || !safeVersion(payload.plugin_version) || !safeId(payload.key_id)) throw new Error('descriptor identity is invalid')
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'].includes(payload.platform)) throw new Error('descriptor platform is invalid')
  for (const key of ['package_sha256', 'bridge_sha256', 'manifest_sha256', 'skill_sha256', 'mcp_methods_sha256']) {
    if (!hex(payload[key])) throw new Error(`${key} is invalid`)
  }
  if (!Number.isSafeInteger(payload.package_bytes) || payload.package_bytes <= 0) throw new Error('package_bytes is invalid')
  if (typeof document.signature_base64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(document.signature_base64)) throw new Error('signature_base64 is invalid')
  return Buffer.from(JSON.stringify(payload))
}

export function verifyPluginReleaseDescriptor(document, options) {
  const message = canonicalPayload(document)
  const key = createPublicKey(options.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('trusted plugin public key must be Ed25519')
  if (document.key_id !== options.keyId) throw new Error('plugin signing key ID mismatch')
  if (!verify(null, message, key, Buffer.from(document.signature_base64, 'base64'))) throw new Error('plugin descriptor signature is invalid')
  for (const [field, expected] of Object.entries({
    release_id: options.releaseId, git_sha: options.gitSha, platform: options.platform,
    mcp_methods_sha256: options.mcpMethodsSha256,
  })) if (expected !== undefined && document[field] !== expected) throw new Error(`${field} does not match candidate identity`)
  if (options.packagePath) {
    const bytes = regularBytes(options.packagePath, 'plugin package')
    if (bytes.length !== document.package_bytes || digest(bytes) !== document.package_sha256) throw new Error('plugin package digest or size mismatch')
  }
  return document
}

export function signPluginReleaseDescriptor(options) {
  const privatePath = resolve(options.privateKeyPath)
  assertPrivateSigningKey(privatePath)
  const privateKey = createPrivateKey(regularBytes(privatePath, 'plugin signing key'))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('plugin signing key must be Ed25519')
  const pluginRoot = resolve(options.pluginRoot)
  if (gitOutput(pluginRoot, ['rev-parse', 'HEAD']) !== options.gitSha) throw new Error('plugin source Git SHA differs from release identity')
  if (gitOutput(pluginRoot, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('plugin source must be clean and committed')
  const pluginManifest = regularBytes(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'plugin manifest')
  const pluginPackage = regularBytes(resolve(pluginRoot, 'package.json'), 'plugin package metadata')
  const manifest = JSON.parse(pluginManifest.toString('utf8'))
  const packageJson = JSON.parse(pluginPackage.toString('utf8'))
  if (manifest.version !== packageJson.version) throw new Error('plugin manifest and package versions differ')
  const packageBytes = regularBytes(options.packagePath, 'plugin package')
  if (packageBytes.length > 100 * 1024 * 1024) throw new Error('plugin package exceeds signing size limit')
  const bridge = regularBytes(resolve(pluginRoot, 'mcp/bridge.mjs'), 'plugin bridge')
  const skill = regularBytes(resolve(pluginRoot, 'skills/merchant-marketing/SKILL.md'), 'plugin skill')
  const verifyContents = options.platform?.startsWith('win32-') ? verifyZipPackageContents : verifyTarPackageContents
  const entries = verifyContents(packageBytes, {
    '.codex-plugin/plugin.json': pluginManifest,
    'package.json': pluginPackage,
    'mcp/bridge.mjs': bridge,
    'skills/merchant-marketing/SKILL.md': skill,
  }, options.platform)
  const hasBuilder = verifyTrackedPackageSources(entries, pluginRoot, options.platform)
  if (!hasBuilder && !options.testOnlySkipRebuild) throw new Error('plugin clean-source package builder is missing')
  if (hasBuilder) verifyRebuiltPackage(entries, pluginRoot, options.platform, verifyContents)
  const payload = {
    schema_version: 'plugin-release/2', release_id: options.releaseId, git_sha: options.gitSha,
    plugin_id: manifest.id, plugin_version: manifest.version, platform: options.platform,
    package_sha256: digest(packageBytes), package_bytes: packageBytes.length,
    bridge_sha256: digest(bridge),
    manifest_sha256: digest(pluginManifest),
    skill_sha256: digest(skill),
    mcp_methods_sha256: options.mcpMethodsSha256, key_id: options.keyId,
  }
  // Validate every field before signing. The temporary signature has the same
  // canonical shape, but is never emitted.
  canonicalPayload({ ...payload, signature_base64: Buffer.alloc(64).toString('base64') })
  const document = { ...payload, signature_base64: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') }
  verifyPluginReleaseDescriptor(document, {
    publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    keyId: options.keyId, releaseId: options.releaseId, gitSha: options.gitSha,
    platform: options.platform, mcpMethodsSha256: options.mcpMethodsSha256,
    packagePath: options.packagePath,
  })
  return document
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function writeNew(path, bytes) {
  if (existsSync(path)) throw new Error('descriptor output already exists')
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } catch (error) { closeSync(fd); unlinkSync(path); throw error }
  closeSync(fd)
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]
    const packagePath = arg('--package')
    const descriptorPath = arg('--descriptor')
    const publicKeyPath = arg('--public-key')
    const keyId = arg('--key-id')
    if (mode === 'sign') {
      const output = arg('--output')
      if (!packagePath || !output || !arg('--private-key') || !arg('--plugin-root')) throw new Error('sign requires --package, --output, --private-key and --plugin-root')
      const document = signPluginReleaseDescriptor({ packagePath, pluginRoot: arg('--plugin-root'), privateKeyPath: arg('--private-key'), keyId, releaseId: arg('--release-id'), gitSha: arg('--git-sha'), platform: arg('--platform'), mcpMethodsSha256: arg('--mcp-methods-sha256') })
      writeNew(resolve(output), `${JSON.stringify(document, null, 2)}\n`)
      console.log(`plugin descriptor signed: ${basename(output)} package_sha256=${document.package_sha256}`)
    } else if (mode === 'verify' || mode === 'verify-cloud') {
      if (!descriptorPath || !publicKeyPath || !keyId || (mode === 'verify' && !packagePath)) throw new Error('verify requires --descriptor, --public-key, --key-id and a package unless using verify-cloud')
      if (mode === 'verify-cloud' && (!arg('--release-id') || !arg('--git-sha'))) throw new Error('verify-cloud requires release and Git identity')
      const document = JSON.parse(regularBytes(descriptorPath, 'plugin descriptor').toString('utf8'))
      verifyPluginReleaseDescriptor(document, { publicKeyPem: regularBytes(publicKeyPath, 'trusted public key'), keyId, packagePath, releaseId: arg('--release-id'), gitSha: arg('--git-sha'), platform: arg('--platform'), mcpMethodsSha256: arg('--mcp-methods-sha256') })
      console.log(`plugin descriptor verified: ${basename(descriptorPath)}`)
    } else throw new Error('usage: plugin-release-descriptor.mjs sign|verify [options]')
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
