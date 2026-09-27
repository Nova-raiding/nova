import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildCanonicalSafeStateEvidence, candidateBinding, endpointDigest, validateSourcePolicy } from '../infra/protected/attest-canonical-safe-state.mjs'
import { summarizeCanonicalSafeState } from '../infra/protected/canonical-safe-state-snapshot.mjs'
import { validateCanonicalSafeStateAttestation } from '../infra/protected/canonical-safe-state-attestation.mjs'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const env = {
  RELEASE_ID: 'release-1', CANONICAL_EXPECTED_RELEASE_GIT_SHA: 'a'.repeat(40),
  CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256: 'b'.repeat(64),
  CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256: 'c'.repeat(64),
  CANONICAL_EXPECTED_IMAGE_SET_DIGEST: `sha256:${'d'.repeat(64)}`,
  DEPLOYMENT_NONCE: 'abcdefghijklmnopqrstuv',
}
const service = Buffer.from('[safe]\nhost=127.0.0.1\nport=5432\n')
const collectorDigest = 'e'.repeat(64)
const snapshot = {
  observed_at: '2026-09-27T01:00:00.000Z', database_name: 'merchant', database_oid: '16384',
  system_identifier: '1234567890123456789',
  workspaces: [{ id: 'ws-a', status: 'active' }, { id: 'ws-b', status: 'disabled' }],
  flags: [], targets: [],
}
const databaseIdentity = {
  system_identifier_sha256: sha(snapshot.system_identifier), database_oid: 16384,
  database_name_sha256: sha(snapshot.database_name), endpoint_sha256: endpointDigest(service, 'safe'),
}
const policyBytes = Buffer.from(JSON.stringify({ schema_version: 'canonical-safe-state-source-policy/1', collector_sha256: collectorDigest, database_identity: databaseIdentity }))
const policy = validateSourcePolicy(policyBytes, collectorDigest, databaseIdentity.endpoint_sha256)
const keys = generateKeyPairSync('ed25519')
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const args = () => ({ snapshot, summary: summarizeCanonicalSafeState(snapshot), binding: candidateBinding(env), policy,
  collectorDigest, privatePem, publicPem, keyId: 'canonical-source-key', now: new Date('2026-09-27T01:01:00.000Z') })

describe('protected canonical safe-state producer', () => {
  it('signs a live-shaped, pinned, legacy-shadow snapshot accepted by the actual release verifier', () => {
    const evidence = buildCanonicalSafeStateEvidence(args())
    expect(evidence.source).toBe('production_database')
    expect(evidence.simulated).toBe(false)
    expect(evidence.workspace_count).toBe(2)
    expect(validateCanonicalSafeStateAttestation(evidence, { expectedBinding: candidateBinding(env), expectedSourcePolicy: policy,
      trustedKeyId: 'canonical-source-key', publicKeyPem: publicPem, now: new Date('2026-09-27T01:02:00.000Z') })).toEqual([])
  })

  it('binds the protected service bytes and name to the reviewed endpoint', () => {
    expect(endpointDigest(service, 'safe')).not.toBe(endpointDigest(service, 'other'))
    expect(() => validateSourcePolicy(policyBytes, collectorDigest, endpointDigest(service, 'other'))).toThrow(/endpoint/u)
    expect(() => validateSourcePolicy(policyBytes, 'f'.repeat(64), databaseIdentity.endpoint_sha256)).toThrow(/collector/u)
    expect(() => candidateBinding({ ...env, DEPLOYMENT_NONCE: 'short' })).toThrow(/nonce/u)
  })

  it('refuses non-legacy state, incorrect cluster identity, stale collection and key mismatch', () => {
    const unsafe = { ...snapshot, flags: [{ flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string',
      value_json: 'canonical_read', enabled: true, emergency_disabled: false }] }
    expect(() => buildCanonicalSafeStateEvidence({ ...args(), snapshot: unsafe, summary: summarizeCanonicalSafeState(unsafe) })).toThrow(/legacy_shadow/u)
    expect(() => buildCanonicalSafeStateEvidence({ ...args(), policy: { ...policy, database_identity: { ...policy.database_identity, database_oid: 1 } } })).toThrow(/database identity/u)
    expect(() => buildCanonicalSafeStateEvidence({ ...args(), now: new Date('2026-09-27T02:00:00.000Z') })).toThrow(/chronology/u)
    expect(() => buildCanonicalSafeStateEvidence({ ...args(), privatePem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })).toThrow(/keypair/u)
  })
})
