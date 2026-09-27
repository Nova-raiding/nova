import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalSafeStateBindingFromEnvironment, canonicalSafeStateDatabaseIdentity, validateCanonicalSafeStateAttestation } from '../infra/protected/canonical-safe-state-attestation.mjs'
import { validateCanonicalProductCutoverEvidence } from './canonical-product-cutover-evidence-gate.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)

const now = new Date('2026-09-27T02:00:00.000Z')
const binding = {
  release_id: 'release-1', release_git_sha: 'a'.repeat(40), candidate_manifest_sha256: 'b'.repeat(64),
  release_manifest_sha256: 'c'.repeat(64), image_set_digest: `sha256:${'d'.repeat(64)}`, deployment_nonce_sha256: 'e'.repeat(64),
}
const sourcePolicy = {
  source_policy_sha256: 'f'.repeat(64), collector_sha256: '1'.repeat(64),
  database_identity: { system_identifier_sha256: '2'.repeat(64), database_oid: 16384, database_name_sha256: '3'.repeat(64), endpoint_sha256: '4'.repeat(64) },
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keyId = 'canonical-safe-state-test-key'

function signedEvidence(overrides: Record<string, unknown> = {}) {
  const databaseIdentity = { ...sourcePolicy.database_identity }
  const unsigned = {
    schema_version: 'canonical-safe-state-attestation/1', evidence_purpose: 'ordinary_release_safe_state',
    environment: 'production', source: 'production_database', simulated: false,
    release_id: binding.release_id, release_git_sha: binding.release_git_sha,
    candidate_manifest_sha256: binding.candidate_manifest_sha256, release_manifest_sha256: binding.release_manifest_sha256,
    image_set_digest: binding.image_set_digest, deployment_nonce_sha256: binding.deployment_nonce_sha256,
    source_policy_sha256: sourcePolicy.source_policy_sha256, collector_sha256: sourcePolicy.collector_sha256,
    database_identity: databaseIdentity, database_identity_sha256: canonicalSafeStateDatabaseIdentity(databaseIdentity),
    observed_at: '2026-09-27T01:00:00.000Z', generated_at: '2026-09-27T01:01:00.000Z', expires_at: '2026-09-27T12:00:00.000Z',
    read_only_transaction: true, transaction_isolation: 'repeatable read', all_workspaces_included: true,
    cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false,
    workspace_count: 2, workspace_id_set_sha256: hash('workspace-set'),
    mode_counts: { legacy_shadow: 2, dual_verify: 0, canonical_read: 0 }, key_id: keyId,
    ...overrides,
  }
  return { ...unsigned, signature_base64: sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') }
}

const options = { expectedBinding: binding, expectedSourcePolicy: sourcePolicy, publicKeyPem, trustedKeyId: keyId, now }

describe('ordinary canonical safe-state attestation contract', () => {
  it('requires complete candidate provenance and a nonempty random deployment nonce', () => {
    const env = {
      RELEASE_ID: binding.release_id,
      CANONICAL_EXPECTED_RELEASE_GIT_SHA: binding.release_git_sha,
      CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256: binding.candidate_manifest_sha256,
      CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256: binding.release_manifest_sha256,
      CANONICAL_EXPECTED_IMAGE_SET_DIGEST: binding.image_set_digest,
      DEPLOYMENT_NONCE: 'abcdefghijklmnopqrstuv',
    }
    expect(canonicalSafeStateBindingFromEnvironment(env)).toEqual({ ...binding, deployment_nonce_sha256: hash(env.DEPLOYMENT_NONCE) })
    for (const field of Object.keys(env) as Array<keyof typeof env>) {
      const missing = { ...env, [field]: '' }
      expect(() => canonicalSafeStateBindingFromEnvironment(missing)).toThrow(`${field} is required`)
    }
    for (const nonce of ['', 'short', 'contains spaces'.repeat(2)]) {
      expect(() => canonicalSafeStateBindingFromEnvironment({ ...env, DEPLOYMENT_NONCE: nonce })).toThrow('DEPLOYMENT_NONCE')
    }
    expect(() => canonicalSafeStateBindingFromEnvironment({ ...env, CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256: 'invalid' })).toThrow('SHA-256 digest')
  })

  it('accepts a source-signed legacy-shadow assertion only with protected candidate and DB identity pins', () => {
    expect(validateCanonicalSafeStateAttestation(signedEvidence(), options)).toEqual([])
  })

  it('fails closed if independent source policy, collector digest, public key, key id, or signature is missing', () => {
    const evidence = signedEvidence()
    expect(validateCanonicalSafeStateAttestation(evidence, { ...options, expectedSourcePolicy: undefined })).toContain('protected source identity policy is required')
    expect(validateCanonicalSafeStateAttestation(evidence, { ...options, publicKeyPem: undefined })).toContain('protected source-attestation public key is required')
    expect(validateCanonicalSafeStateAttestation({ ...evidence, signature_base64: undefined }, options)).toContain('signature_base64 must be a canonical Ed25519 signature')
    expect(validateCanonicalSafeStateAttestation(evidence, { ...options, trustedKeyId: 'other-key' })).toContain('key_id must match the protected source-attestation key')
  })

  it('rejects candidate or live database provenance mismatches even when the payload is validly signed', () => {
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ release_git_sha: '9'.repeat(40) }), options)).toContain('release_git_sha must match the trusted candidate binding')
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ database_identity_sha256: '8'.repeat(64) }), options)).toContain('database_identity_sha256 does not match the approved database identity')
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ collector_sha256: '7'.repeat(64) }), options)).toContain('collector_sha256 must match the protected collector digest')
  })

  it('rejects false legacy claims and cannot substitute for actual cutover evidence', () => {
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ mode_counts: { legacy_shadow: 1, dual_verify: 0, canonical_read: 1 } }), options)).toContain('every production workspace must resolve to legacy_shadow')
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ canonical_read_enabled: true, canonical_read_mode: 'canonical_read' }), options)).toContain('ordinary releases require canonical reads disabled in legacy_shadow')
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ evidence_purpose: 'production_cutover' }), options)).toContain('evidence_purpose must be ordinary_release_safe_state')
    expect(validateCanonicalSafeStateAttestation(signedEvidence({ expires_at: '2026-09-28T02:00:01.000Z' }), options)).toContain('safe-state evidence validity must be within 24 hours of observation')
  })

  it('separates ordinary safe-state from cutover and requires provenance before ordinary release passes', () => {
    const ordinary = signedEvidence()
    expect(validateCanonicalProductCutoverEvidence(ordinary, { expectedReleaseId: binding.release_id })).toEqual([
      'ordinary release requires protected source policy, candidate binding, and independent Ed25519 source attestation',
    ])
    expect(validateCanonicalProductCutoverEvidence(ordinary, { expectedReleaseId: binding.release_id, safeStateTrust: options })).toEqual([])

    const cutover = {
      schema_version: '1', release_id: binding.release_id, environment: 'production',
      generated_at: '2026-09-27T01:00:00.000Z', expires_at: '2026-09-27T12:00:00.000Z', simulated: false,
      source: 'production_database', database_identity_sha256: '5'.repeat(64), cutover_state: 'not_cut_over',
      canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false, workspace_count: 2, shadow_check_cycles: 2,
      shadow_cycles: [], status_counts: { verified: 0, backfilled: 0, legacy_only: 2, conflict: 0, blocked: 0 },
      evidence_ref: 'artifact://production/canonical/snapshot#' + '6'.repeat(64),
      rollback_evidence_ref: 'artifact://production/canonical/rollback#' + '7'.repeat(64),
    }
    expect(validateCanonicalProductCutoverEvidence(cutover, { expectedReleaseId: binding.release_id, safeStateTrust: options, now })).toContain('shadow cycles require protected read-only database collection and independent provenance verification')
  })
})
