// Read-only 254→255 transition review. This module has no Docker, database,
// lock, nonce-consumer, signing-key or network access. A matching document is
// never an authorization to run a production migration or cutover.
import { createHash, createPublicKey, verify } from 'node:crypto'

const HEX = /^[0-9a-f]{64}$/u
const IMAGE = /^sha256:[0-9a-f]{64}$/u
const GIT = /^[0-9a-f]{40}$/u
const ATTEMPT = /^[A-Za-z0-9_-]{16,128}$/u
const LOCK = '/var/lib/merchant-release-security/production-deploy.lock'
const PROJECT = 'merchant-demo-85575f9c'
const ALLOWED_SERVICES = Object.freeze(['api', 'api-replica', 'ui', 'ops-ui', 'payment-gateway',
  'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile',
  'worker-automation', 'worker-scan', 'postgres', 'redis', 'pilot-gateway'])
const REQUIRED_SERVICES = Object.freeze(['api', 'api-replica', 'postgres', 'redis', 'pilot-gateway'])
const validServices = value => Array.isArray(value)
  && value.length >= REQUIRED_SERVICES.length
  && new Set(value).size === value.length
  && value.every(name => ALLOWED_SERVICES.includes(name))
  && REQUIRED_SERVICES.every(name => value.includes(name))
  && value.some(name => name.startsWith('worker-'))
  && [...value].sort().join('\0') === value.join('\0')
const PHASES = Object.freeze(['captured_254', 'fenced_254', 'migrating_255', 'verified_255',
  'candidate_cutover', 'accepted_255'])
const requireValue = (ok, message) => { if (!ok) throw new Error(`BRIDGE_255_${message}`) }
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')

function identity(value) {
  return exactKeys(value, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'])
    && /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.release_id)
    && GIT.test(value.git_sha) && HEX.test(value.manifest_sha256) && IMAGE.test(value.image_set_digest)
}

function artifacts(value) {
  return exactKeys(value, ['identity', 'compose_sha256', 'env_sha256', 'image_digests_sha256'])
    && identity(value.identity) && HEX.test(value.compose_sha256) && HEX.test(value.env_sha256)
    && HEX.test(value.image_digests_sha256)
}

function prefix(value, version, hash) {
  return exactKeys(value, ['version', 'history_sha256', 'ops_version', 'ops_history_sha256'])
    && value.version === version && value.ops_version === version
    && value.history_sha256 === hash && value.ops_history_sha256 === hash
}

function inventory(value, project, services, expectedStatus) {
  requireValue(Array.isArray(value) && value.length === services.length, 'INVENTORY_INCOMPLETE')
  const actual = new Map(value.map(item => [item.service, item]))
  requireValue(actual.size === services.length && services.every(name => actual.has(name)), 'INVENTORY_SERVICE_MISMATCH')
  for (const service of services) {
    const item = actual.get(service)
    const status = expectedStatus[service]
    requireValue(exactKeys(item, ['service', 'name', 'project', 'compose_service', 'id', 'image_id', 'inspect_sha256', 'network_sha256', 'running'])
      && item.name === `${project}-${service}-1` && item.project === project && item.compose_service === service
      && HEX.test(item.id ?? '') && IMAGE.test(item.image_id ?? '')
      && HEX.test(item.inspect_sha256 ?? '') && HEX.test(item.network_sha256 ?? '')
      && item.running === status, `INVENTORY_${service.toUpperCase().replaceAll('-', '_')}_INVALID`)
  }
  requireValue(new Set(value.map(item => item.id)).size === services.length, 'INVENTORY_DUPLICATE_CONTAINER')
}

export function validateBridge255Plan(plan) {
  requireValue(exactKeys(plan, ['schema_version', 'attempt_id', 'project', 'lock_path', 'nonce_sha256', 'old_demo',
    'bridge_254_255', 'candidate_255', 'recovery_255', 'database', 'pg17_image_ref',
    'old_demo_services', 'recovery_255_services', 'candidate_255_services']), 'PLAN_SHAPE_INVALID')
  requireValue(plan.schema_version === 'ecs-bridge-255-plan/1' && ATTEMPT.test(plan.attempt_id ?? '')
    && plan.project === PROJECT && plan.lock_path === LOCK && HEX.test(plan.nonce_sha256 ?? ''), 'PLAN_IDENTITY_INVALID')
  requireValue(artifacts(plan.old_demo) && artifacts(plan.bridge_254_255)
    && artifacts(plan.candidate_255) && artifacts(plan.recovery_255)
    && IMAGE.test(plan.pg17_image_ref ?? ''), 'ARTIFACTS_INVALID')
  requireValue(validServices(plan.old_demo_services)
    && validServices(plan.recovery_255_services)
    && validServices(plan.candidate_255_services), 'SERVICE_PLAN_INVALID')
  requireValue(exactKeys(plan.database, ['strategy', 'schema_downgrade', 'preserve_volumes', 'prefix_254_sha256', 'prefix_255_sha256'])
    && plan.database.strategy === 'forward_only' && plan.database.schema_downgrade === false
    && plan.database.preserve_volumes === true && HEX.test(plan.database.prefix_254_sha256)
    && HEX.test(plan.database.prefix_255_sha256)
    && plan.database.prefix_254_sha256 !== plan.database.prefix_255_sha256, 'DATABASE_PLAN_INVALID')
  requireValue(plan.old_demo.identity.release_id !== plan.bridge_254_255.identity.release_id
    && plan.bridge_254_255.identity.release_id !== plan.candidate_255.identity.release_id,
  'RELEASE_IDENTITIES_NOT_DISTINCT')
  return digest(plan)
}

function signedJournal(journal, publicKeyPem, plan, planSha, now) {
  requireValue(exactKeys(journal, ['schema_version', 'attempt_id', 'plan_sha256', 'phase', 'previous_journal_sha256',
    'nonce_sha256', 'created_at', 'expires_at', 'signature_base64']), 'JOURNAL_SHAPE_INVALID')
  const created = Date.parse(journal.created_at), expires = Date.parse(journal.expires_at)
  requireValue(journal.schema_version === 'ecs-bridge-255-journal/1' && journal.attempt_id === plan.attempt_id
    && journal.plan_sha256 === planSha && journal.nonce_sha256 === plan.nonce_sha256
    && PHASES.includes(journal.phase) && (journal.phase === 'captured_254'
      ? journal.previous_journal_sha256 === null : HEX.test(journal.previous_journal_sha256 ?? ''))
    && Number.isFinite(created) && Number.isFinite(expires)
    && journal.created_at === new Date(created).toISOString()
    && journal.expires_at === new Date(expires).toISOString()
    && created <= now.getTime() + 300_000 && expires > now.getTime()
    && expires - created <= 86_400_000, 'JOURNAL_IDENTITY_OR_TIME_INVALID')
  let valid = false
  try {
    const key = createPublicKey(publicKeyPem)
    const signature = Buffer.from(journal.signature_base64, 'base64')
    valid = key.asymmetricKeyType === 'ed25519' && signature.length === 64
      && signature.toString('base64') === journal.signature_base64
      && verify(null, Buffer.from(canonical(journal)), key, signature)
  } catch { /* malformed key or signature */ }
  requireValue(valid, 'JOURNAL_SIGNATURE_INVALID')
}

/** Validate a caller-supplied phase observation, but never grant production authority. */
export function reviewBridge255Phase({ plan, journal, publicKeyPem, capture, observation, now = new Date() }) {
  const planSha = validateBridge255Plan(plan)
  signedJournal(journal, publicKeyPem, plan, planSha, now)
  requireValue(exactKeys(capture, ['project', 'public_release', 'database', 'containers',
    'compose_services', 'compose_sha256', 'gateway_ports', 'capture_sha256'])
    && capture.project === PROJECT && identity(capture.public_release)
    // The 254/255 bridge must already be the serving public release before
    // this transition can enter captured_254. The prior demo release is only
    // an independently frozen ancestry/recovery reference.
    && canonical(capture.public_release) === canonical(plan.bridge_254_255.identity)
    && Array.isArray(capture.compose_services)
    && capture.compose_services.join('\0') === plan.old_demo_services.join('\0')
    && capture.compose_sha256 === plan.bridge_254_255.compose_sha256
    && prefix(capture.database, 254, plan.database.prefix_254_sha256)
    && exactKeys(capture.gateway_ports, ['http', 'https'])
    && capture.gateway_ports.http === 80 && capture.gateway_ports.https === 443,
  'CAPTURE_INVALID')
  inventory(capture.containers, PROJECT, plan.old_demo_services,
    Object.fromEntries(plan.old_demo_services.map(name => [name, true])))
  const { capture_sha256: capturedDigest, ...captureBody } = capture
  requireValue(capturedDigest === digest(captureBody), 'CAPTURE_DIGEST_INVALID')
  requireValue(exactKeys(observation, ['phase', 'database', 'ingress_fenced', 'callbacks_fenced', 'in_flight_requests',
    'active_worker_cycles', 'active_outbox_leases', 'provider_started_unresolved', 'stopped_services',
    'backup', 'runtime', 'gateway']) && observation.phase === journal.phase, 'OBSERVATION_SHAPE_INVALID')
  const migrated = PHASES.indexOf(journal.phase) >= PHASES.indexOf('verified_255')
  if (journal.phase === 'migrating_255') {
    requireValue([254, 255].includes(observation.database?.version)
      && prefix(observation.database, observation.database.version,
        observation.database.version === 254 ? plan.database.prefix_254_sha256 : plan.database.prefix_255_sha256),
    'MIGRATION_PREFIX_INVALID')
  } else {
    requireValue(prefix(observation.database, migrated ? 255 : 254,
      migrated ? plan.database.prefix_255_sha256 : plan.database.prefix_254_sha256), 'PHASE_PREFIX_INVALID')
  }
  if (journal.phase !== 'captured_254') {
    const runtimeServices = plan.old_demo_services.filter(name => name === 'api' || name === 'api-replica' || name.startsWith('worker-'))
    if (journal.phase === 'accepted_255') {
      requireValue(observation.ingress_fenced === false && observation.callbacks_fenced === false
        && Array.isArray(observation.stopped_services) && observation.stopped_services.length === 0,
      'ACCEPTED_TRAFFIC_NOT_OPEN')
    } else {
      requireValue(observation.ingress_fenced === true && observation.callbacks_fenced === true
        && observation.in_flight_requests === 0 && observation.active_worker_cycles === 0
        && observation.active_outbox_leases === 0 && observation.provider_started_unresolved === 0
        && Array.isArray(observation.stopped_services) && runtimeServices.every(name => observation.stopped_services.includes(name))
        && observation.gateway?.ingress_fence_verified === true,
      'FENCE_OR_DRAIN_INCOMPLETE')
    }
    requireValue(observation.backup?.signed === true && IMAGE.test(observation.backup.pg17_image_ref ?? '')
      && observation.backup.pg17_image_ref === plan.pg17_image_ref
      && HEX.test(observation.backup.archive_sha256 ?? '')
      && observation.backup.restored_prefix_version === 254
      && observation.backup.restored_prefix_sha256 === plan.database.prefix_254_sha256,
    'PG17_BACKUP_RESTORE_UNVERIFIED')
  }
  if (migrated) {
    const targetServices = journal.phase === 'verified_255'
      ? plan.recovery_255_services : plan.candidate_255_services
    requireValue(observation.runtime?.identity && canonical(observation.runtime.identity)
      === canonical(journal.phase === 'candidate_cutover' || journal.phase === 'accepted_255'
        ? plan.candidate_255.identity : plan.recovery_255.identity)
      && observation.runtime.api_ready === true && observation.runtime.api_replica_ready === true
      && Array.isArray(observation.runtime.services)
      && observation.runtime.services.join('\0') === targetServices.join('\0')
      && observation.runtime.workers_ready === targetServices.filter(name => name.startsWith('worker-')).length
      && observation.runtime.business_canary_passed === true
      && observation.gateway?.release_identity_verified === true && observation.gateway?.https_ready === true,
    'RUNTIME_255_NOT_VERIFIED')
    if (journal.phase === 'accepted_255') {
      requireValue(observation.runtime.ops_canary_passed === true
        && observation.runtime.model_relay_passed === true
        && observation.runtime.codex_stdio_host_passed === true,
      'POST_CUTOVER_EVIDENCE_INCOMPLETE')
    }
  }
  return Object.freeze({ schema_version: 'ecs-bridge-255-phase-review/1', status: 'review_only',
    phase: journal.phase, plan_sha256: planSha, journal_sha256: digest(journal),
    production_authorized: false, deployable: false,
    blockers: ['NO_TRUSTED_HOST_LOCK_OBSERVATION', 'NO_PROTECTED_TRUST_ROOT',
      'NO_PROTECTED_NONCE_LEDGER_CONSUMER',
      'NO_DEMO_254_SIGNED_BACKUP_RESTORE_CONTROL',
      'NO_DURABLE_SIGNED_JOURNAL_STATE_MACHINE', 'NO_INDEPENDENT_DOCKER_DATABASE_GATEWAY_OBSERVATION',
      'NO_EXECUTION_OR_FORWARD_RECOVERY_CONTROLLER'],
  })
}
