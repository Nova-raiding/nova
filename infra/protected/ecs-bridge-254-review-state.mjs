#!/usr/bin/env node
// Pure, review-only contract for a future independently installed 242→254
// bridge controller. It verifies a caller-supplied Ed25519 journal signature
// and monotonic phase shape, but does not establish protected-key provenance,
// inspect the nonce ledger or database, sign updates, or authorize mutations.
import { createHash, createPublicKey, verify } from 'node:crypto'

const SHA = /^[a-f0-9]{64}$/u
const GIT = /^[a-f0-9]{40}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const ATTEMPT = /^[A-Za-z0-9_-]{16,128}$/u
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const PHASES = Object.freeze({
  captured: ['nonce_consumed'],
  nonce_consumed: ['bridge_mutation_started'],
  bridge_mutation_started: ['bridge_verified', 'old_recovery_started'],
  bridge_verified: ['migration_started', 'old_recovery_started'],
  migration_started: ['migration_254_verified', 'forward_recovery_started', 'old_recovery_started'],
  forward_recovery_started: ['migration_254_verified'],
  migration_254_verified: [],
  old_recovery_started: ['old_recovery_verified'],
  old_recovery_verified: [],
})
const EXACT_JOURNAL_FIELDS = ['schema_version', 'purpose', 'phase', 'attempt_id', 'key_id', 'created_at', 'updated_at', 'expires_at',
  'compose_project', 'candidate', 'bridge', 'old_runtime', 'deployment_nonce_sha256', 'recovery_capsule_sha256',
  'baseline_inventory_sha256', 'allowed_prefix_sha256', 'database_prefix', 'nonce_owner', 'deployable', 'signature_base64']
const PROTECTED_JOURNAL_FIELDS = [...EXACT_JOURNAL_FIELDS, 'observation_sha256']
const EXACT_IDENTITY_FIELDS = ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest']
const EXACT_NONCE_OWNER_FIELDS = ['namespace', 'operation', 'attempt_id', 'release_id', 'git_sha', 'manifest_sha256', 'image_set_digest', 'nonce_sha256']
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
const sha = value => createHash('sha256').update(value).digest('hex')
const identity = value => exact(value, EXACT_IDENTITY_FIELDS) && ID.test(value.release_id) && GIT.test(value.git_sha)
  && SHA.test(value.manifest_sha256) && IMAGE.test(value.image_set_digest)
const same = (a, b, fields) => fields.every(field => a?.[field] === b?.[field])
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const failResult = errors => ({ status: 'review_only', structure_consistent: false, cryptographic_signature_valid: false,
  nonce_ledger_verified: false, database_observation_verified: false, deployable: false, errors })

export function reviewBridge254SignedJournal(document, expected, now = new Date()) {
  const errors = []
  const add = (ok, reason) => { if (!ok) errors.push(reason) }
  const protectedJournal = document?.schema_version === 'ecs-bridge-254-review-journal/2'
  if (!exact(document, protectedJournal ? PROTECTED_JOURNAL_FIELDS : EXACT_JOURNAL_FIELDS)) return failResult(['journal must contain exactly the reviewed fields'])
  add((protectedJournal && document.purpose === 'bridge_242_to_254_protected'
    || document.schema_version === 'ecs-bridge-254-review-journal/1' && document.purpose === 'bridge_242_to_254_review')
    && document.deployable === false, 'journal must remain review-only and non-deployable')
  if (protectedJournal) add(SHA.test(document.observation_sha256), 'protected journal must persist the independent observation digest')
  add(Object.hasOwn(PHASES, document.phase), 'journal phase is unknown')
  add(ATTEMPT.test(document.attempt_id) && ID.test(document.key_id) && document.compose_project === 'merchant-production', 'journal attempt, key, or project is invalid')
  const created = Date.parse(document.created_at), updated = Date.parse(document.updated_at), expires = Date.parse(document.expires_at)
  add(time(document.created_at) && time(document.updated_at) && time(document.expires_at)
    && created <= updated && updated <= now.getTime() + 300_000 && created <= now.getTime() + 300_000
    && expires > now.getTime() && expires - created <= 86_400_000, 'journal chronology or 24-hour lifetime is invalid')
  for (const field of ['candidate', 'bridge', 'old_runtime']) {
    add(identity(document[field]) && identity(expected?.[field]) && same(document[field], expected[field], EXACT_IDENTITY_FIELDS), `${field} identity must match an independent frozen expectation`)
  }
  add(document.candidate?.release_id !== document.bridge?.release_id && document.bridge?.release_id !== document.old_runtime?.release_id,
    'old, bridge, and candidate identities must be distinct')
  add(typeof expected?.deploymentNonce === 'string' && NONCE.test(expected.deploymentNonce)
    && document.deployment_nonce_sha256 === sha(expected.deploymentNonce), 'deployment nonce hash must match the independent expectation')
  for (const field of ['recovery_capsule_sha256', 'baseline_inventory_sha256']) add(SHA.test(document[field]), `${field} must be SHA-256`)
  add(SHA.test(expected?.recoveryCapsuleSha256 ?? '') && document.recovery_capsule_sha256 === expected.recoveryCapsuleSha256,
    'recovery capsule hash must match independently frozen bytes')
  const prefixes = document.allowed_prefix_sha256
  add(exact(prefixes, Array.from({ length: 13 }, (_, index) => String(index + 242)))
    && Object.values(prefixes).every(value => SHA.test(value)), 'journal must freeze exactly the 242–254 prefix hashes')
  add(exact(document.database_prefix, ['version', 'history_sha256']) && Number.isSafeInteger(document.database_prefix.version)
    && document.database_prefix.version >= 242 && document.database_prefix.version <= 254
    && document.database_prefix.history_sha256 === prefixes?.[document.database_prefix.version], 'journal database prefix is not in the frozen chain')
  const phaseVersion = document.database_prefix?.version
  if (['captured', 'nonce_consumed', 'bridge_mutation_started', 'bridge_verified', 'old_recovery_started', 'old_recovery_verified'].includes(document.phase)) {
    add(phaseVersion === 242, 'bridge installation and old-runtime recovery phases require schema 242')
  }
  if (document.phase === 'forward_recovery_started') add(phaseVersion >= 243 && phaseVersion <= 254, 'forward recovery phase requires schema 243–254')
  if (document.phase === 'migration_254_verified') add(phaseVersion === 254, 'verified migration phase requires schema 254')
  const owner = document.nonce_owner
  if (document.phase === 'captured') add(owner === null, 'captured journal must precede nonce consumption')
  else add(exact(owner, EXACT_NONCE_OWNER_FIELDS) && owner.namespace === 'merchant-production-deploy'
    && owner.operation === 'bridge-254' && owner.attempt_id === document.attempt_id
    && same(owner, document.bridge, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'])
    && owner.nonce_sha256 === document.deployment_nonce_sha256
    && exact(expected?.nonceOwner, EXACT_NONCE_OWNER_FIELDS) && same(owner, expected.nonceOwner, EXACT_NONCE_OWNER_FIELDS),
  'nonce ownership claim must match the independently supplied ledger observation')
  add(expected && ID.test(expected.trustedKeyId ?? '') && document.key_id === expected.trustedKeyId,
    'journal key ID must match the independently supplied trust anchor')
  const signature = document.signature_base64
  const signatureBytes = typeof signature === 'string' ? Buffer.from(signature, 'base64') : Buffer.alloc(0)
  add(typeof signature === 'string' && signatureBytes.length === 64 && signatureBytes.toString('base64') === signature,
    'journal signature must be canonical Ed25519 base64')
  let cryptographicSignatureValid = false
  if (typeof expected?.publicKeyPem === 'string' && signatureBytes.length === 64) {
    try {
      const key = createPublicKey(expected.publicKeyPem)
      cryptographicSignatureValid = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(document)), key, signatureBytes)
    } catch { /* A malformed caller-supplied key is a closed review. */ }
  }
  add(cryptographicSignatureValid, 'journal signature must verify under the supplied Ed25519 key')
  return { status: 'review_only', structure_consistent: errors.length === 0, cryptographic_signature_valid: cryptographicSignatureValid,
    nonce_ledger_verified: false, database_observation_verified: false, deployable: false, errors }
}

export function reviewBridge254NextPhase(document, nextPhase, observedPrefix, expected, now = new Date()) {
  const journal = reviewBridge254SignedJournal(document, expected, now)
  const errors = [...journal.errors]
  if (!journal.structure_consistent) return { ...journal, next_phase: null, errors }
  if (!PHASES[document.phase].includes(nextPhase)) errors.push('phase transition is not monotonic or is unsupported')
  if (!exact(observedPrefix, ['version', 'history_sha256']) || !Number.isSafeInteger(observedPrefix.version)
    || observedPrefix.version < 242 || observedPrefix.version > 254
    || observedPrefix.history_sha256 !== document.allowed_prefix_sha256[observedPrefix.version]) errors.push('observed database prefix must match the frozen 242–254 chain')
  const version = observedPrefix?.version
  if (Number.isSafeInteger(version) && version < document.database_prefix.version) errors.push('observed migration prefix must never move backward from the signed journal')
  if (nextPhase === 'bridge_mutation_started' || nextPhase === 'bridge_verified' || nextPhase === 'migration_started'
    || nextPhase === 'old_recovery_started' || nextPhase === 'old_recovery_verified') {
    if (version !== 242) errors.push('bridge mutation or old-runtime recovery requires exact schema 242')
  }
  if (nextPhase === 'forward_recovery_started' && !(version >= 243 && version <= 253)) errors.push('intermediate schema may only enter forward recovery toward 254')
  if (nextPhase === 'migration_254_verified' && version !== 254) errors.push('migration completion requires exact schema 254')
  if (version >= 243 && version <= 253 && nextPhase !== 'forward_recovery_started') errors.push('243–253 cannot serve traffic or recover the old 242 runtime')
  if (nextPhase === 'nonce_consumed') {
    if (document.phase !== 'captured') errors.push('nonce may only be consumed once from captured')
    const owner = expected?.nonceOwner
    if (!exact(owner, EXACT_NONCE_OWNER_FIELDS) || owner.namespace !== 'merchant-production-deploy' || owner.operation !== 'bridge-254'
      || owner.attempt_id !== document.attempt_id || !same(owner, document.bridge, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'])
      || owner.nonce_sha256 !== document.deployment_nonce_sha256) errors.push('nonce transition requires an exact external ledger ownership observation')
  }
  return { status: 'review_only', structure_consistent: errors.length === 0, cryptographic_signature_valid: journal.cryptographic_signature_valid,
    nonce_ledger_verified: false, database_observation_verified: false, deployable: false,
    next_phase: errors.length === 0 ? nextPhase : null, errors }
}

export { PHASES as BRIDGE_254_REVIEW_PHASES }
