// Verifies a source-signed ordinary-release safe-state assertion. This is a
// contract validator only; it does not collect data or make a report trusted
// unless callers supply the protected trust anchors and release binding.
import { createHash, createPublicKey, verify } from 'node:crypto'

const HEX = /^[a-f0-9]{64}$/u
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const MODES = ['legacy_shadow', 'dual_verify', 'canonical_read']
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const strictUtc = value => typeof value === 'string' && UTC.test(value) && Number.isFinite(Date.parse(value))

export function canonicalSafeStateBindingFromEnvironment(environment) {
  const required = [
    'RELEASE_ID', 'CANONICAL_EXPECTED_RELEASE_GIT_SHA', 'CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256',
    'CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256', 'CANONICAL_EXPECTED_IMAGE_SET_DIGEST', 'DEPLOYMENT_NONCE',
  ]
  for (const field of required) if (typeof environment?.[field] !== 'string' || !environment[field]) throw new Error(`${field} is required for canonical safe-state candidate binding`)
  const nonce = environment.DEPLOYMENT_NONCE
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) throw new Error('DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(environment.CANONICAL_EXPECTED_RELEASE_GIT_SHA)) throw new Error('candidate Git SHA is invalid')
  for (const field of ['CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256', 'CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256']) {
    if (!HEX.test(environment[field])) throw new Error(`${field} must be a SHA-256 digest`)
  }
  if (!IMAGE.test(environment.CANONICAL_EXPECTED_IMAGE_SET_DIGEST)) throw new Error('candidate image set digest is invalid')
  return {
    release_id: environment.RELEASE_ID,
    release_git_sha: environment.CANONICAL_EXPECTED_RELEASE_GIT_SHA,
    candidate_manifest_sha256: environment.CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256,
    release_manifest_sha256: environment.CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256,
    image_set_digest: environment.CANONICAL_EXPECTED_IMAGE_SET_DIGEST,
    deployment_nonce_sha256: sha256(nonce),
  }
}

export function canonicalSafeStateDatabaseIdentity(value) {
  return sha256(canonical({
    system_identifier_sha256: value?.system_identifier_sha256,
    database_oid: value?.database_oid,
    database_name_sha256: value?.database_name_sha256,
    endpoint_sha256: value?.endpoint_sha256,
  }))
}

/**
 * Validate one already-signed ordinary-release proof. `expectedSourcePolicy`
 * must be loaded by the caller from a protected, independently reviewed host
 * path; passing a policy from the mutable evidence directory defeats the
 * provenance check. Actual cutover remains subject to the separate two-cycle
 * gate.
 */
export function validateCanonicalSafeStateAttestation(document, options = {}) {
  const errors = []
  const fail = message => errors.push(message)
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document
  const now = (options.now ?? new Date()).getTime()
  const binding = options.expectedBinding
  const sourcePolicy = options.expectedSourcePolicy

  if (value.schema_version !== 'canonical-safe-state-attestation/1') fail('schema_version must be canonical-safe-state-attestation/1')
  if (value.evidence_purpose !== 'ordinary_release_safe_state') fail('evidence_purpose must be ordinary_release_safe_state')
  if (value.environment !== 'production') fail('environment must be production')
  if (value.source !== 'production_database' || value.simulated !== false) fail('source must be a non-simulated production_database')
  if (value.cutover_state !== 'not_cut_over') fail('ordinary safe-state evidence must state not_cut_over')
  if (value.canonical_read_mode !== 'legacy_shadow' || value.canonical_read_enabled !== false) fail('ordinary releases require canonical reads disabled in legacy_shadow')
  if (value.read_only_transaction !== true || value.transaction_isolation !== 'repeatable read') fail('source collection must use a repeatable-read read-only transaction')
  if (value.all_workspaces_included !== true) fail('source collection must attest the complete workspace set')

  if (!binding || typeof binding !== 'object') fail('trusted candidate binding is required')
  else {
    const expected = {
      release_id: binding.release_id,
      release_git_sha: binding.release_git_sha,
      candidate_manifest_sha256: binding.candidate_manifest_sha256,
      release_manifest_sha256: binding.release_manifest_sha256,
      image_set_digest: binding.image_set_digest,
      deployment_nonce_sha256: binding.deployment_nonce_sha256,
    }
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (typeof expectedValue !== 'string' || !expectedValue || value[field] !== expectedValue) fail(`${field} must match the trusted candidate binding`)
    }
    if (!GIT.test(String(value.release_git_sha ?? ''))) fail('release_git_sha is invalid')
    for (const field of ['candidate_manifest_sha256', 'release_manifest_sha256', 'deployment_nonce_sha256']) if (!HEX.test(String(value[field] ?? ''))) fail(`${field} must be a SHA-256 digest`)
    if (!IMAGE.test(String(value.image_set_digest ?? ''))) fail('image_set_digest must be immutable')
  }

  if (!sourcePolicy || typeof sourcePolicy !== 'object') fail('protected source identity policy is required')
  else {
    if (value.source_policy_sha256 !== sourcePolicy.source_policy_sha256) fail('source_policy_sha256 must match the protected source policy')
    if (value.collector_sha256 !== sourcePolicy.collector_sha256 || !HEX.test(String(value.collector_sha256 ?? ''))) fail('collector_sha256 must match the protected collector digest')
    if (!value.database_identity || typeof value.database_identity !== 'object') fail('database_identity is required')
    else {
      for (const field of ['system_identifier_sha256', 'database_oid', 'database_name_sha256', 'endpoint_sha256']) {
        if (value.database_identity[field] !== sourcePolicy.database_identity?.[field]) fail(`database_identity.${field} must match the protected source policy`)
      }
      if (!HEX.test(String(value.database_identity.system_identifier_sha256 ?? ''))
        || !HEX.test(String(value.database_identity.database_name_sha256 ?? ''))
        || !HEX.test(String(value.database_identity.endpoint_sha256 ?? ''))
        || !Number.isSafeInteger(value.database_identity.database_oid) || value.database_identity.database_oid < 1) fail('database_identity fields are invalid')
      if (value.database_identity_sha256 !== canonicalSafeStateDatabaseIdentity(value.database_identity)) fail('database_identity_sha256 does not match the approved database identity')
    }
    if (!HEX.test(String(sourcePolicy.source_policy_sha256 ?? ''))) fail('protected source_policy_sha256 is invalid')
    if (!HEX.test(String(sourcePolicy.collector_sha256 ?? ''))) fail('protected collector digest is invalid')
  }

  for (const field of ['observed_at', 'generated_at', 'expires_at']) if (!strictUtc(value[field])) fail(`${field} must be a strict UTC timestamp`)
  const observed = Date.parse(value.observed_at ?? '')
  const generated = Date.parse(value.generated_at ?? '')
  const expires = Date.parse(value.expires_at ?? '')
  if (Number.isFinite(observed) && observed > now + 300_000) fail('observed_at must not be in the future')
  if (Number.isFinite(observed) && now - observed > 24 * 3_600_000) fail('safe-state evidence is stale')
  if (Number.isFinite(generated) && generated < observed) fail('generated_at must not precede observed_at')
  if (Number.isFinite(generated) && generated > now + 300_000) fail('generated_at must not be in the future')
  if (Number.isFinite(expires) && expires <= now) fail('safe-state evidence has expired')
  if (Number.isFinite(expires) && Number.isFinite(observed) && (expires <= observed || expires - observed > 24 * 3_600_000)) fail('safe-state evidence validity must be within 24 hours of observation')

  const counts = value.mode_counts
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) || Object.keys(counts).sort().join(',') !== [...MODES].sort().join(',')) fail('mode_counts must contain exactly the three canonical modes')
  else {
    for (const mode of MODES) if (!Number.isSafeInteger(counts[mode]) || counts[mode] < 0) fail(`mode_counts.${mode} must be a non-negative integer`)
    if (Number.isSafeInteger(value.workspace_count) && MODES.reduce((sum, mode) => sum + Number(counts[mode]), 0) !== value.workspace_count) fail('mode_counts must sum to workspace_count')
    if (counts.legacy_shadow !== value.workspace_count || counts.dual_verify !== 0 || counts.canonical_read !== 0) fail('every production workspace must resolve to legacy_shadow')
  }
  if (!Number.isSafeInteger(value.workspace_count) || value.workspace_count < 1) fail('workspace_count must be a positive integer')
  if (!HEX.test(String(value.workspace_id_set_sha256 ?? ''))) fail('workspace_id_set_sha256 must be a SHA-256 digest')

  const keyId = options.trustedKeyId
  const publicPem = options.publicKeyPem
  if (typeof keyId !== 'string' || !keyId || value.key_id !== keyId) fail('key_id must match the protected source-attestation key')
  if (typeof publicPem !== 'string' || !publicPem) fail('protected source-attestation public key is required')
  const signature = value.signature_base64
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) fail('signature_base64 must be a canonical Ed25519 signature')
  else if (typeof publicPem === 'string' && publicPem) {
    try {
      const key = createPublicKey(publicPem)
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64'))) fail('source-attestation signature is invalid')
    } catch { fail('protected source-attestation trust anchor is invalid') }
  }
  return errors
}
