import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { PLUGIN_CONTRACT_TESTS, verifyLocalPluginTestAttestation } from '../scripts/local-plugin-test-attestation.mjs'

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
