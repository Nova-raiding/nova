#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPrivateSigningKey, signPluginReleaseDescriptor, verifyPluginReleaseDescriptor } from './plugin-release-descriptor.mjs'

export const PLUGIN_CONTRACT_TESTS = Object.freeze([
  'tests/mcp-integration-mode-release-gate.test.ts',
  'tests/env-example-read-gate.test.ts',
  'tests/quality-entrypoints.test.ts',
  'tests/release-metadata-gate.test.ts',
  'tests/release-manifest.test.ts',
  'tests/release-manifest-gate.test.ts',
  'tests/container-source-manifest.test.ts',
  'tests/operations-scripts.test.ts',
  'tests/source-artifact-hygiene.test.ts',
  'tests/plugin-manifest.test.ts',
  'tests/mcp-surface-contract.test.ts',
  'apps/plugin/install-smoke.test.ts',
  'tests/local-plugin-source-adapter.test.ts',
  'tests/local-plugin-cross-platform-package-contract.test.ts',
  'apps/plugin/mcp/windows-credential.test.ts',
  'apps/plugin/windows/windows-helper-contract.test.ts',
])

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const platform = () => `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'unsupported'}`
const fields = ['schema_version', 'release_id', 'git_sha', 'platform', 'descriptor_sha256', 'suite_sha256', 'status', 'generated_at', 'expires_at', 'key_id']
const suiteSha = sha(Buffer.from(JSON.stringify(PLUGIN_CONTRACT_TESTS)))

function regular(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return readFileSync(path)
}

function canonical(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('test attestation is not an object')
  if (Object.keys(record).sort().join('\0') !== [...fields, 'signature_base64'].sort().join('\0')) throw new Error('test attestation fields are not exact')
  const payload = Object.fromEntries(fields.map(field => [field, record[field]]))
  if (payload.schema_version !== 'local-plugin-tests/2' || payload.status !== 'pass' || payload.suite_sha256 !== suiteSha
    || !/^[0-9a-f]{64}$/u.test(payload.descriptor_sha256)
    || !/^[A-Za-z0-9+/]{86}==$/u.test(record.signature_base64)) throw new Error('test attestation schema or suite is invalid')
  return Buffer.from(JSON.stringify(payload))
}

export function verifyLocalPluginTestAttestation(record, options) {
  const bytes = canonical(record)
  const publicKey = createPublicKey(options.publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('plugin test trust key must be Ed25519')
  if (record.key_id !== options.keyId) throw new Error('plugin test signing key ID mismatch')
  if (!verify(null, bytes, publicKey, Buffer.from(record.signature_base64, 'base64'))) throw new Error('plugin test attestation signature is invalid')
  for (const [field, expected] of Object.entries({ release_id: options.releaseId, git_sha: options.gitSha,
    platform: options.platform, descriptor_sha256: options.descriptorSha256 })) {
    if (record[field] !== expected) throw new Error(`plugin test ${field} does not match candidate`)
  }
  const now = options.now ?? Date.now()
  const generated = Date.parse(record.generated_at)
  const expires = Date.parse(record.expires_at)
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || generated > now + 300_000
    || generated < now - 86_400_000 || expires <= now || expires > generated + 86_400_000) {
    throw new Error('plugin test attestation is stale, future-dated or has invalid expiry')
  }
  return record
}

export function runAndSignLocalPluginTests(options) {
  const descriptorBytes = regular(options.descriptorPath, 'plugin descriptor')
  const descriptor = JSON.parse(descriptorBytes.toString('utf8'))
  const publicKeyPem = regular(options.publicKeyPath, 'plugin public key')
  verifyPluginReleaseDescriptor(descriptor, { publicKeyPem, keyId: options.keyId, packagePath: options.packagePath,
    releaseId: options.releaseId, gitSha: options.gitSha, candidateIdentityPath: options.candidateIdentityPath, platform: platform() })
  assertPrivateSigningKey(options.privateKeyPath)
  const privateKey = createPrivateKey(regular(options.privateKeyPath, 'plugin test signing key'))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('plugin test signing key must be Ed25519')
  const currentGit = spawnSync('git', ['-C', options.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const dirty = spawnSync('git', ['-C', options.root, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' })
  if (currentGit.status !== 0 || dirty.status !== 0 || currentGit.stdout.trim() !== options.gitSha || dirty.stdout.trim()) {
    throw new Error('plugin test source must be clean and match descriptor Git SHA')
  }
  const runner = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-safe-tests.ts', '--no-file-parallelism', ...PLUGIN_CONTRACT_TESTS], {
    cwd: options.root, stdio: 'inherit', env: process.env,
  })
  if (runner.status !== 0) throw new Error(`local plugin contract tests did not pass: ${runner.status ?? runner.signal}`)
  const generatedAt = new Date().toISOString()
  const payload = {
    schema_version: 'local-plugin-tests/2', release_id: options.releaseId, git_sha: options.gitSha,
    platform: platform(), descriptor_sha256: sha(descriptorBytes), suite_sha256: suiteSha,
    status: 'pass', generated_at: generatedAt, expires_at: new Date(Date.parse(generatedAt) + 86_400_000).toISOString(),
    key_id: options.keyId,
  }
  const record = { ...payload, signature_base64: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') }
  verifyLocalPluginTestAttestation(record, { publicKeyPem, keyId: options.keyId, releaseId: options.releaseId,
    gitSha: options.gitSha, platform: platform(), descriptorSha256: sha(descriptorBytes) })
  return record
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}

/**
 * Build the two candidate-bound local plugin evidence files as one transaction.
 * The descriptor is signed first, then the exact descriptor bytes are bound into
 * local-plugin-tests/2. Neither output is created until both operations pass.
 */
export function generateLocalPluginReleaseEvidence(options, dependencies = {}) {
  const signDescriptor = dependencies.signDescriptor ?? signPluginReleaseDescriptor
  const runTests = dependencies.runTests ?? runAndSignLocalPluginTests
  const descriptorPath = resolve(options.descriptorPath)
  const attestationPath = resolve(options.attestationPath)
  if (descriptorPath === attestationPath) throw new Error('descriptor and test attestation outputs must differ')
  for (const [path, label] of [[descriptorPath, 'plugin descriptor output'], [attestationPath, 'plugin test attestation output']]) {
    try { if (lstatSync(path)) throw new Error(`${label} already exists`) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const expectedPlatform = platform()
  if (options.platform !== expectedPlatform) throw new Error(`plugin evidence platform must match the signing host (${expectedPlatform})`)
  const temporary = mkdtempSync(resolve(dirname(descriptorPath), '.local-plugin-evidence-'))
  const temporaryDescriptor = resolve(temporary, 'plugin-release-descriptor.json')
  try {
    const descriptor = signDescriptor({ ...options, packagePath: options.packagePath, pluginRoot: options.pluginRoot,
      privateKeyPath: options.privateKeyPath, releaseId: options.releaseId, gitSha: options.gitSha,
      platform: options.platform, mcpMethodsSha256: options.mcpMethodsSha256 })
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
    writeExclusive(temporaryDescriptor, descriptorBytes)
    const attestation = runTests({ root: options.root, descriptorPath: temporaryDescriptor, packagePath: options.packagePath,
      publicKeyPath: options.publicKeyPath, privateKeyPath: options.privateKeyPath, keyId: options.keyId,
      releaseId: options.releaseId, gitSha: options.gitSha, candidateIdentityPath: options.candidateIdentityPath })
    verifyPluginReleaseDescriptor(descriptor, { publicKeyPem: regular(options.publicKeyPath, 'plugin public key'),
      keyId: options.keyId, releaseId: options.releaseId, gitSha: options.gitSha, platform: options.platform,
      candidateIdentityPath: options.candidateIdentityPath, mcpMethodsSha256: options.mcpMethodsSha256, packagePath: options.packagePath })
    verifyLocalPluginTestAttestation(attestation, { publicKeyPem: regular(options.publicKeyPath, 'plugin public key'),
      keyId: options.keyId, releaseId: options.releaseId, gitSha: options.gitSha, platform: options.platform,
      descriptorSha256: sha(descriptorBytes) })
    writeExclusive(descriptorPath, descriptorBytes)
    try { writeExclusive(attestationPath, Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`)) } catch (error) {
      try { rmSync(descriptorPath, { force: true }) } catch {}
      throw error
    }
    return { descriptor, attestation, descriptorPath, attestationPath }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]
    if (mode === 'run-and-sign') {
      const required = ['--root', '--descriptor', '--package', '--public-key', '--private-key', '--key-id', '--release-id', '--git-sha', '--output']
      if (required.some(name => !arg(name))) throw new Error(`run-and-sign requires ${required.join(', ')}`)
      const record = runAndSignLocalPluginTests({ root: arg('--root'), descriptorPath: arg('--descriptor'), packagePath: arg('--package'),
        publicKeyPath: arg('--public-key'), privateKeyPath: arg('--private-key'), keyId: arg('--key-id'),
        releaseId: arg('--release-id'), gitSha: arg('--git-sha') })
      const fd = openSync(arg('--output'), 'wx', 0o600)
      try { writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
      console.log(`local plugin contract test attestation written: ${arg('--output')}`)
    } else if (mode === 'generate') {
      const required = ['--root', '--plugin-root', '--package', '--platform', '--candidate-identity', '--public-key', '--private-key', '--key-id', '--release-id', '--git-sha', '--mcp-methods-sha256', '--build-attestation', '--build-attestation-public-key', '--build-attestation-key-id', '--descriptor-output', '--attestation-output']
      if (required.some(name => !arg(name))) throw new Error(`generate requires ${required.join(', ')}`)
      const result = generateLocalPluginReleaseEvidence({
        root: arg('--root'), pluginRoot: arg('--plugin-root'), packagePath: arg('--package'), platform: arg('--platform'), candidateIdentityPath: arg('--candidate-identity'),
        publicKeyPath: arg('--public-key'), privateKeyPath: arg('--private-key'), keyId: arg('--key-id'), releaseId: arg('--release-id'),
        gitSha: arg('--git-sha'), mcpMethodsSha256: arg('--mcp-methods-sha256'), descriptorPath: arg('--descriptor-output'), attestationPath: arg('--attestation-output'),
        buildAttestation: JSON.parse(regular(arg('--build-attestation'), 'trusted build attestation').toString('utf8')),
        buildAttestationPublicKeyPem: regular(arg('--build-attestation-public-key'), 'trusted build attestation public key'),
        buildAttestationKeyId: arg('--build-attestation-key-id'),
      })
      console.log(`local plugin evidence written: ${result.descriptorPath}, ${result.attestationPath}`)
    } else if (mode === 'verify') {
      const required = ['--record', '--descriptor', '--public-key', '--key-id', '--release-id', '--git-sha', '--platform']
      if (required.some(name => !arg(name))) throw new Error(`verify requires ${required.join(', ')}`)
      verifyLocalPluginTestAttestation(JSON.parse(regular(arg('--record'), 'plugin test attestation').toString('utf8')),
        { publicKeyPem: regular(arg('--public-key'), 'plugin public key'), keyId: arg('--key-id'), releaseId: arg('--release-id'),
          gitSha: arg('--git-sha'), platform: arg('--platform'), descriptorSha256: sha(regular(arg('--descriptor'), 'plugin descriptor')) })
      console.log('local plugin contract test attestation verified')
    } else throw new Error('usage: local-plugin-test-attestation.mjs generate|run-and-sign|verify [options]')
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
