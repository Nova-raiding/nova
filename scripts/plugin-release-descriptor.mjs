#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function regularBytes(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return readFileSync(path)
}

function verifyPackageContents(path, expected) {
  const listed = spawnSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (listed.status !== 0) throw new Error('plugin package is not a readable tar.gz archive')
  const entries = listed.stdout.trimEnd().split('\n')
  if (entries.some(entry => !entry || entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('plugin package contains an unsafe path')
  for (const [entry, bytes] of Object.entries(expected)) {
    if (entries.filter(name => name === entry).length !== 1) throw new Error(`plugin package must contain exactly one ${entry}`)
    const extracted = spawnSync('tar', ['-xOzf', path, entry], { maxBuffer: 4 * 1024 * 1024 })
    if (extracted.status !== 0 || !extracted.stdout.equals(bytes)) throw new Error(`plugin package ${entry} differs from signed source`)
  }
}

function gitOutput(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error('plugin source must be in a readable Git checkout')
  return result.stdout.trim()
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
  const stat = lstatSync(privatePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('plugin signing key must be owner-owned regular 0600/0400 file')
  }
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
  verifyPackageContents(options.packagePath, {
    '.codex-plugin/plugin.json': pluginManifest,
    'package.json': pluginPackage,
    'mcp/bridge.mjs': bridge,
    'skills/merchant-marketing/SKILL.md': skill,
  })
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
    } else if (mode === 'verify') {
      if (!descriptorPath || !publicKeyPath || !keyId || !packagePath) throw new Error('verify requires --descriptor, --public-key, --key-id and --package')
      const document = JSON.parse(regularBytes(descriptorPath, 'plugin descriptor').toString('utf8'))
      verifyPluginReleaseDescriptor(document, { publicKeyPem: regularBytes(publicKeyPath, 'trusted public key'), keyId, packagePath, releaseId: arg('--release-id'), gitSha: arg('--git-sha'), platform: arg('--platform'), mcpMethodsSha256: arg('--mcp-methods-sha256') })
      console.log(`plugin descriptor verified: ${basename(descriptorPath)}`)
    } else throw new Error('usage: plugin-release-descriptor.mjs sign|verify [options]')
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
