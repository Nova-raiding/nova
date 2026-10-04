import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateLocalPluginReleaseEvidence, PLUGIN_CONTRACT_TESTS, verifyLocalPluginTestAttestation } from '../scripts/local-plugin-test-attestation.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

function fixture() {
  const pair = generateKeyPairSync('ed25519')
  const now = Date.now()
  const payload = {
    schema_version: 'local-plugin-tests/2', release_id: 'release-1', git_sha: 'a'.repeat(40),
    platform: 'darwin-arm64', descriptor_sha256: 'b'.repeat(64),
    suite_sha256: sha(JSON.stringify(PLUGIN_CONTRACT_TESTS)), status: 'pass',
    generated_at: new Date(now).toISOString(), expires_at: new Date(now + 86_400_000).toISOString(),
    key_id: 'plugin-test-key',
  }
  const record = { ...payload, signature_base64: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64') }
  const options = { publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }), keyId: payload.key_id,
    releaseId: payload.release_id, gitSha: payload.git_sha, platform: payload.platform,
    descriptorSha256: payload.descriptor_sha256, now }
  return { record, options }
}

test('verifies exact signed local test suite, candidate and freshness', () => {
  const f = fixture()
  assert.equal(verifyLocalPluginTestAttestation(f.record, f.options), f.record)
  assert.ok(PLUGIN_CONTRACT_TESTS.includes('tests/mcp-surface-contract.test.ts'))
})

test('rejects substituted suite, descriptor, platform, trust anchor and stale result', () => {
  const f = fixture()
  assert.throws(() => verifyLocalPluginTestAttestation({ ...f.record, suite_sha256: '0'.repeat(64) }, f.options), /schema or suite is invalid/u)
  assert.throws(() => verifyLocalPluginTestAttestation(f.record, { ...f.options, descriptorSha256: '0'.repeat(64) }), /descriptor_sha256 does not match/u)
  assert.throws(() => verifyLocalPluginTestAttestation(f.record, { ...f.options, platform: 'win32-x64' }), /platform does not match/u)
  assert.throws(() => verifyLocalPluginTestAttestation(f.record, { ...f.options, now: f.options.now + 86_400_001 }), /stale/u)
  const other = generateKeyPairSync('ed25519')
  assert.throws(() => verifyLocalPluginTestAttestation(f.record, { ...f.options, publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) }), /signature is invalid/u)
})

test('generates descriptor and local test attestation atomically from one candidate identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-plugin-evidence-'))
  const packagePath = join(root, 'plugin.tar.gz'); const packageBytes = Buffer.from('candidate-package')
  writeFileSync(packagePath, packageBytes)
  const publicKeyPath = join(root, 'plugin-public.pem')
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }))
  const releaseId = 'release-1'; const gitSha = 'a'.repeat(40); const keyId = 'plugin-test-key'; const platform = `${process.platform}-${process.arch}`
  const candidateIdentityPath = join(root, 'candidate-identity.txt')
  writeFileSync(candidateIdentityPath, `schema_version=candidate-identity/2\nrelease_id=${releaseId}\ngit_sha=${gitSha}\n`)
  const descriptorPayload = {
    schema_version: 'plugin-release/2', release_id: releaseId, git_sha: gitSha, plugin_id: 'merchant-marketing', plugin_version: '0.1.0',
    platform, package_sha256: sha(packageBytes), package_bytes: packageBytes.length, bridge_sha256: '1'.repeat(64),
    manifest_sha256: '2'.repeat(64), skill_sha256: '3'.repeat(64), mcp_methods_sha256: '4'.repeat(64), release_readiness: 'signed_installable', key_id: keyId,
  }
  const descriptor = { ...descriptorPayload, signature_base64: sign(null, Buffer.from(JSON.stringify(descriptorPayload)), pair.privateKey).toString('base64') }
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
  const now = new Date().toISOString(); const payload = {
    schema_version: 'local-plugin-tests/2', release_id: releaseId, git_sha: gitSha, platform,
    descriptor_sha256: sha(descriptorBytes), suite_sha256: sha(JSON.stringify(PLUGIN_CONTRACT_TESTS)), status: 'pass',
    generated_at: now, expires_at: new Date(Date.parse(now) + 86_400_000).toISOString(), key_id: keyId,
  }
  const attestation = { ...payload, signature_base64: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64') }
  const descriptorPath = join(root, 'descriptor.json'); const attestationPath = join(root, 'attestation.json')
  let observedDescriptorPath
  const result = generateLocalPluginReleaseEvidence({ root, pluginRoot: root, packagePath, platform, candidateIdentityPath, publicKeyPath,
    privateKeyPath: join(root, 'unused-private-key'), keyId, releaseId, gitSha, mcpMethodsSha256: descriptorPayload.mcp_methods_sha256,
    descriptorPath, attestationPath, buildAttestation: {}, buildAttestationPublicKeyPem: '', buildAttestationKeyId: 'build-key' }, {
    signDescriptor: () => descriptor,
    runTests: options => { observedDescriptorPath = options.descriptorPath; assert.deepEqual(readFileSync(options.descriptorPath), descriptorBytes); return attestation },
  })
  assert.equal(result.descriptorPath, descriptorPath); assert.equal(result.attestationPath, attestationPath)
  assert.equal(observedDescriptorPath.startsWith(join(root, '.local-plugin-evidence-')), true)
  assert.deepEqual(readFileSync(descriptorPath), descriptorBytes)
  assert.deepEqual(JSON.parse(readFileSync(attestationPath, 'utf8')), attestation)
})

test('does not replace an existing evidence file', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-plugin-evidence-fail-')); const descriptorPath = join(root, 'descriptor.json'); const attestationPath = join(root, 'attestation.json')
  writeFileSync(descriptorPath, 'existing')
  assert.throws(() => generateLocalPluginReleaseEvidence({ descriptorPath, attestationPath, platform: `${process.platform}-${process.arch}` }), /descriptor output already exists/u)
  assert.equal(existsSync(attestationPath), false)
})
