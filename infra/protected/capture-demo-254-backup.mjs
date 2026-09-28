// Protected 254 backup orchestration. An installed, root-owned collector must
// supply independent topology and database observations; caller JSON is never
// accepted as evidence. No production credentials or Docker access live here.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { produceBackup } from './attest-postgres-backup.mjs'
import { reviewDemo254BackupSource } from './review-demo-254-backup-source.mjs'

const SHA = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`DEMO_254_CAPTURE_${message}`) }
const check = (value, message) => { if (!value) fail(message) }
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)

export function verifyFrozenDemo254Plan(signedPlan, publicPem) {
  check(signedPlan && Object.getPrototypeOf(signedPlan) === Object.prototype
    && Object.keys(signedPlan).sort().join(',') === 'freeze,key_id,signature_base64', 'PLAN_SHAPE_INVALID')
  check(typeof signedPlan.key_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(signedPlan.key_id), 'PLAN_KEY_ID_INVALID')
  check(typeof signedPlan.signature_base64 === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(signedPlan.signature_base64), 'PLAN_SIGNATURE_INVALID')
  const publicKey = createPublicKey(publicPem)
  check(publicKey.asymmetricKeyType === 'ed25519'
    && verify(null, Buffer.from(canonical(signedPlan)), publicKey, Buffer.from(signedPlan.signature_base64, 'base64')), 'PLAN_SIGNATURE_INVALID')
  return signedPlan.freeze
}

export function signFrozenDemo254Plan(freeze, { privatePem, publicPem, keyId }) {
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  check(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'PLAN_SIGNING_KEY_MISMATCH')
  const plan = { freeze, key_id: keyId }
  plan.signature_base64 = sign(null, Buffer.from(canonical(plan)), privateKey).toString('base64')
  verifyFrozenDemo254Plan(plan, publicPem)
  return plan
}

export function signDemo254CaptureManifest({ review, attestation, signedPlan, privatePem, publicPem, keyId }) {
  check(review?.status === 'review_only_match' && SHA.test(review.migration_history_sha256)
    && SHA.test(review.frozen_sha256) && SHA.test(review.observation_sha256), 'SOURCE_REVIEW_MISSING')
  check(attestation?.schema_version === '2' && attestation.migration_version === 254
    && attestation.source_database_id_sha256 === review.source_database_id_sha256
    && SHA.test(attestation.backup_sha256) && SHA.test(attestation.snapshot_id_sha256), 'ATTESTATION_SOURCE_MISMATCH')
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  check(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'KEY_PAIR_MISMATCH')
  check(keyId === attestation.key_id, 'ATTESTATION_KEY_ID_MISMATCH')
  const manifest = {
    schema_version: 'demo-254-protected-backup-capture/1', environment: 'production', simulated: false,
    backup_file_name: attestation.backup_file_name, backup_sha256: attestation.backup_sha256,
    attestation_sha256: digest(JSON.stringify(attestation)), snapshot_id_sha256: attestation.snapshot_id_sha256,
    source_database_id_sha256: review.source_database_id_sha256,
    migration_version: 254, migration_history_sha256: review.migration_history_sha256,
    frozen_source_sha256: review.frozen_sha256, fresh_observation_sha256: review.observation_sha256,
    signed_plan_sha256: digest(canonical(signedPlan)), key_id: keyId,
  }
  manifest.signature_base64 = sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64')
  check(verify(null, Buffer.from(canonical(manifest)), publicKey, Buffer.from(manifest.signature_base64, 'base64')), 'MANIFEST_SELF_VERIFY_FAILED')
  return manifest
}

export function verifyDemo254CaptureManifest(manifest, { attestation, signedPlan, publicPem }) {
  const publicKey = createPublicKey(publicPem)
  check(manifest?.schema_version === 'demo-254-protected-backup-capture/1'
    && manifest.environment === 'production' && manifest.simulated === false
    && manifest.migration_version === 254 && manifest.backup_sha256 === attestation?.backup_sha256
    && manifest.backup_file_name === attestation?.backup_file_name
    && manifest.snapshot_id_sha256 === attestation?.snapshot_id_sha256
    && manifest.source_database_id_sha256 === attestation?.source_database_id_sha256
    && manifest.attestation_sha256 === digest(JSON.stringify(attestation))
    && manifest.signed_plan_sha256 === digest(canonical(signedPlan))
    && manifest.key_id === attestation?.key_id
    && SHA.test(manifest.migration_history_sha256), 'MANIFEST_BINDING_INVALID')
  check(publicKey.asymmetricKeyType === 'ed25519'
    && verify(null, Buffer.from(canonical(manifest)), publicKey, Buffer.from(manifest.signature_base64 ?? '', 'base64')), 'MANIFEST_SIGNATURE_INVALID')
  return true
}

// All adapter methods must be backed by an independently installed collector.
// The migration query must import the provided PostgreSQL snapshot before its
// first SELECT. The collector must verify Docker/public routing immediately
// before capture and hold the source identity stable through dump completion.
export async function captureDemo254Backup({ signedPlan, planPublicPem, privatePem, publicPem, keyId,
  backupPath, attestationPath, checksumPath, manifestPath, clock = () => new Date() }, collector) {
  check(collector && ['observeTopology', 'snapshot', 'dump', 'observeMigrations'].every(name => typeof collector[name] === 'function'), 'COLLECTOR_INCOMPLETE')
  check(typeof manifestPath === 'string' && manifestPath !== backupPath && manifestPath !== attestationPath
    && manifestPath !== checksumPath, 'MANIFEST_PATH_INVALID')
  const frozen = verifyFrozenDemo254Plan(signedPlan, planPublicPem)
  check(signedPlan.key_id === keyId, 'PLAN_KEY_ID_MISMATCH')
  let boundReview, boundManifest
  const sourcePolicy = { system_identifier_sha256: frozen.database.system_identifier_sha256,
    database_oid: frozen.database.oid, database_name: frozen.database.name }
  // Bookend the dump with independent routing/container observations. The
  // exported snapshot protects database consistency, not gateway topology.
  const before = await collector.observeTopology()
  const attestation = await produceBackup({ backupPath, attestationPath, checksumPath, privatePem, publicPem,
    keyId, sourcePolicy, clock }, {
    snapshot: collector.snapshot,
    dump: collector.dump,
    reviewOnlyObserveSnapshot: async (snapshot, held) => {
      check(held.migrationVersion === 254, 'MIGRATION_VERSION_NOT_254')
      const database = await collector.observeMigrations(snapshot)
      check(database?.name === held.databaseName && database?.oid === held.databaseOid
        && database?.system_identifier === held.systemIdentifier, 'SNAPSHOT_DATABASE_DRIFT')
      const after = await collector.observeTopology()
      check(canonical({ ...before, observed_at: undefined }) === canonical({ ...after, observed_at: undefined }), 'TOPOLOGY_CHANGED_DURING_DUMP')
      const observed = { ...after, database }
      boundReview = reviewDemo254BackupSource({ frozen, observed, now: clock() })
      return boundReview
    },
    reviewOnlyBindBackup: async (review, document) => {
      check(review === boundReview, 'REVIEW_BINDING_INVALID')
      boundManifest = signDemo254CaptureManifest({ review, attestation: document,
        signedPlan, privatePem, publicPem, keyId })
    },
  })
  check(attestation.backup_file_name === basename(backupPath), 'BACKUP_NAME_INVALID')
  verifyDemo254CaptureManifest(boundManifest, { attestation, signedPlan, publicPem })
  writeFileSync(manifestPath, `${JSON.stringify(boundManifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { attestation, manifest: boundManifest }
}
