// Verification boundary for a future independently installed 254→255 host
// runner. This module reads no production state and grants no mutation right.
// In particular, a caller-supplied restore report is never execution proof.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { hashRegularFile } from './attest-postgres-backup.mjs'
import { verifyDemo254CaptureManifest, verifyFrozenDemo254Plan } from './capture-demo-254-backup.mjs'
import { validateBridge255Plan } from './ecs-bridge-255-review.mjs'

const HEX = /^[a-f0-9]{64}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const fail = reason => { throw new Error(`BRIDGE_255_HOST_${reason}`) }
const check = (ok, reason) => { if (!ok) fail(reason) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
const strictTime = value => UTC.test(value ?? '') && Number.isFinite(Date.parse(value))

function signature(document, publicPem, reason) {
  let valid = false
  try {
    const key = createPublicKey(publicPem)
    const bytes = Buffer.from(document.signature_base64, 'base64')
    valid = key.asymmetricKeyType === 'ed25519' && bytes.length === 64
      && bytes.toString('base64') === document.signature_base64
      && verify(null, Buffer.from(canonical(document)), key, bytes)
  } catch { /* reject malformed trust material */ }
  check(valid, reason)
}

function verifyAttestation(attestation, publicPem, keyId, now) {
  check(exact(attestation, ['schema_version', 'kind', 'environment', 'simulated',
    'backup_file_name', 'backup_sha256', 'source_database_id_sha256',
    'source_database_oid', 'source_database_name', 'migration_version',
    'snapshot_id_sha256', 'backup_started_at', 'snapshot_export_observed_at',
    'dump_completed_at', 'created_at', 'expires_at', 'key_id', 'signature_base64'])
    && attestation.schema_version === '2' && attestation.kind === 'postgres_backup'
    && attestation.environment === 'production' && attestation.simulated === false
    && attestation.migration_version === 254 && attestation.key_id === keyId
    && HEX.test(attestation.backup_sha256) && HEX.test(attestation.source_database_id_sha256)
    && HEX.test(attestation.snapshot_id_sha256)
    && Number.isInteger(attestation.source_database_oid) && attestation.source_database_oid > 0
    && attestation.source_database_name === 'merchant'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(attestation.backup_file_name ?? ''),
  'ATTESTATION_IDENTITY_INVALID')
  check(['backup_started_at', 'snapshot_export_observed_at', 'dump_completed_at',
    'created_at', 'expires_at'].every(field => strictTime(attestation[field]))
    && attestation.created_at === attestation.backup_started_at
    && Date.parse(attestation.backup_started_at) <= Date.parse(attestation.snapshot_export_observed_at)
    && Date.parse(attestation.snapshot_export_observed_at) <= Date.parse(attestation.dump_completed_at)
    && Date.parse(attestation.dump_completed_at) <= now.getTime() + 300_000
    && Date.parse(attestation.expires_at) > now.getTime()
    && Date.parse(attestation.expires_at) <= Date.parse(attestation.dump_completed_at) + 86_400_000,
  'ATTESTATION_EXPIRED_OR_CHRONOLOGY_INVALID')
  signature(attestation, publicPem, 'ATTESTATION_SIGNATURE_INVALID')
}

function verifyRestore(restore, { plan, attestation, publicPem, keyId, now }) {
  check(exact(restore, ['schema_version', 'status', 'simulated', 'attempt_id', 'plan_sha256',
    'backup_sha256', 'source_database_id_sha256', 'source_prefix_254_sha256',
    'migrated_prefix_255_sha256', 'restored_prefix_version', 'migrated_version',
    'postgres_image_ref', 'postgres_image_id', 'container_id', 'network_id', 'network_internal',
    'published_ports', 'volume_name', 'target_database_id_sha256', 'migration_255_sql_sha256',
    'recovery_image_set_digest', 'captured_at', 'expires_at', 'key_id', 'signature_base64'])
    && restore.schema_version === 'ecs-bridge-255-pg17-restore/1'
    && restore.status === 'pass' && restore.simulated === false
    && restore.attempt_id === plan.attempt_id
    && restore.plan_sha256 === validateBridge255Plan(plan)
    && restore.backup_sha256 === attestation.backup_sha256
    && restore.source_database_id_sha256 === attestation.source_database_id_sha256
    && restore.source_prefix_254_sha256 === plan.database.prefix_254_sha256
    && restore.migrated_prefix_255_sha256 === plan.database.prefix_255_sha256
    && restore.restored_prefix_version === 254 && restore.migrated_version === 255
    && restore.postgres_image_ref === plan.pg17_image_ref && IMAGE.test(restore.postgres_image_id)
    && HEX.test(restore.container_id)
    && HEX.test(restore.network_id) && restore.network_internal === true
    && Array.isArray(restore.published_ports) && restore.published_ports.length === 0
    && /^merchant_restore_data_[A-Za-z0-9_-]{12,64}$/u.test(restore.volume_name ?? '')
    && HEX.test(restore.target_database_id_sha256)
    && restore.target_database_id_sha256 !== attestation.source_database_id_sha256
    && HEX.test(restore.migration_255_sql_sha256)
    && restore.recovery_image_set_digest === plan.recovery_255.identity.image_set_digest
    && restore.key_id === keyId, 'RESTORE_BINDING_INVALID')
  check(strictTime(restore.captured_at) && strictTime(restore.expires_at)
    && Date.parse(restore.captured_at) <= now.getTime() + 300_000
    && Date.parse(restore.expires_at) > now.getTime()
    && Date.parse(restore.expires_at) <= Date.parse(restore.captured_at) + 86_400_000,
  'RESTORE_EXPIRED_OR_CHRONOLOGY_INVALID')
  signature(restore, publicPem, 'RESTORE_SIGNATURE_INVALID')
}

/** Verify the source before any isolated Docker resource is created. */
export function reviewBridge255BackupSource({ plan, signedSourcePlan, manifest, attestation,
  backupPath, publicPem, keyId, now = new Date() }) {
  validateBridge255Plan(plan)
  check(typeof publicPem === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(keyId ?? ''), 'TRUST_ANCHOR_INVALID')
  const frozen = verifyFrozenDemo254Plan(signedSourcePlan, publicPem)
  check(signedSourcePlan.key_id === keyId
    && frozen.database.history_sha256 === plan.database.prefix_254_sha256
    && frozen.public_route.release_id === plan.bridge_254_255.identity.release_id
    && frozen.public_route.git_sha === plan.bridge_254_255.identity.git_sha
    && frozen.postgres.compose_project === plan.project,
  'SOURCE_PLAN_BRIDGE_MISMATCH')
  verifyAttestation(attestation, publicPem, keyId, now)
  check(attestation.source_database_id_sha256 === frozen.database.system_identifier_sha256
    && attestation.source_database_oid === frozen.database.oid
    && attestation.source_database_name === frozen.database.name,
  'SOURCE_DATABASE_MISMATCH')
  verifyDemo254CaptureManifest(manifest, { attestation, signedPlan: signedSourcePlan, publicPem })
  check(manifest.migration_history_sha256 === plan.database.prefix_254_sha256,
    'CAPTURE_PREFIX_MISMATCH')
  check(typeof backupPath === 'string' && backupPath.endsWith(`/${attestation.backup_file_name}`)
    && hashRegularFile(backupPath).sha256 === attestation.backup_sha256,
  'BACKUP_BYTES_MISMATCH')
  return Object.freeze({ plan_sha256: validateBridge255Plan(plan),
    backup_sha256: attestation.backup_sha256,
    source_database_id_sha256: attestation.source_database_id_sha256 })
}

/** Validate a backup/restore handoff supplied by an independently installed collector. */
export function reviewBridge255HostHandoff({ plan, signedSourcePlan, manifest, attestation,
  restore, backupPath, publicPem, keyId, now = new Date() }) {
  reviewBridge255BackupSource({ plan, signedSourcePlan, manifest, attestation,
    backupPath, publicPem, keyId, now })
  verifyRestore(restore, { plan, attestation, publicPem, keyId, now })
  return Object.freeze({ status: 'review_only', deployable: false, migration_authorized: false,
    production_cutover_authorized: false, plan_sha256: validateBridge255Plan(plan),
    backup_sha256: attestation.backup_sha256,
    blockers: ['NO_FIXED_INSTALLED_DEMO_254_COLLECTOR', 'NO_FIXED_INSTALLED_254_TO_255_PG17_RESTORE',
      'NO_INDEPENDENT_LIVE_TOPOLOGY_OBSERVATION', 'NO_PROTECTED_HOST_PORTS_AND_FAULT_REHEARSAL'] })
}
