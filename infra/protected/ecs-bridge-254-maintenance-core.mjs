// 242→254 maintenance-window orchestration core. This module has no host CLI,
// credential access, or production mutation capability by itself. A protected
// installer must supply independently authenticated control and runtime ports.
import { createHash } from 'node:crypto'

const SERVICES = Object.freeze(['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'])
const OLD_ROLES = Object.freeze(['api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan', 'external-gateway'])
const SHA = /^[a-f0-9]{64}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const CONTAINER = /^[a-f0-9]{64}$/u
const required = (ok, reason) => { if (!ok) throw new Error(`BRIDGE_254_${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)

export const BRIDGE_254_MAINTENANCE_SERVICES = SERVICES

export function assertBridge254FrozenCapture(capture, expected) {
  required(capture?.schema_version === 'ecs-bridge-254-capture/1' && expected?.project === 'merchant-production', 'PROJECT_MISMATCH')
  required(capture?.database?.runtime?.version === 242 && capture.database.ops?.version === 242, 'BASELINE_PREFIX_INVALID')
  required(SHA.test(capture.database.runtime.history_sha256 ?? '') && capture.database.runtime.history_sha256 === capture.database.ops.history_sha256
    && capture.database.runtime.history_sha256 === expected.prefixes?.['242'], 'BASELINE_HISTORY_MISMATCH')
  required(Array.isArray(capture.containers) && capture.containers.length === OLD_ROLES.length, 'OLD_RUNTIME_INCOMPLETE')
  const names = new Set()
  for (const item of capture.containers) {
    required(OLD_ROLES.includes(item.role) && !names.has(item.role), 'OLD_RUNTIME_SERVICE_INVALID')
    names.add(item.role)
    required(CONTAINER.test(item.id ?? '') && IMAGE.test(item.image_id ?? '') && SHA.test(item.inspect_sha256 ?? '')
      && SHA.test(item.network_sha256 ?? '')
      && item.running === true, 'OLD_RUNTIME_IDENTITY_INVALID')
  }
  required(OLD_ROLES.every(name => names.has(name)) && new Set(capture.containers.map(item => item.id)).size === OLD_ROLES.length, 'OLD_RUNTIME_INCOMPLETE')
  required(capture.public_release && Object.keys(capture.public_release).sort().join() === 'git_sha,image_set_digest,manifest_sha256,release_id'
    && capture.public_release.release_id === expected.oldRuntime?.release_id
    && capture.public_release.git_sha === expected.oldRuntime?.git_sha
    && capture.public_release.manifest_sha256 === expected.oldRuntime?.manifest_sha256
    && capture.public_release.image_set_digest === expected.oldRuntime?.image_set_digest,
  'PUBLIC_OLD_IDENTITY_MISMATCH')
  required(capture.bridge_artifacts?.release_id === expected.bridge?.release_id && capture.bridge_artifacts?.git_sha === expected.bridge?.git_sha
    && capture.bridge_artifacts?.manifest_sha256 === expected.bridge?.manifest_sha256
    && capture.bridge_artifacts?.image_set_digest === expected.bridge?.image_set_digest, 'BRIDGE_IDENTITY_MISMATCH')
  required(Array.isArray(capture.bridge_artifacts?.services) && capture.bridge_artifacts.services.length === SERVICES.length
    && SERVICES.every(name => capture.bridge_artifacts.services.includes(name))
    && SHA.test(capture.bridge_artifacts.compose_sha256 ?? '') && SHA.test(capture.bridge_artifacts.env_sha256 ?? '')
    && SHA.test(capture.bridge_artifacts.image_digests_sha256 ?? '') && capture.old_recovery?.preserve_volumes === true
    && SHA.test(capture.old_recovery?.compose_sha256 ?? '') && SHA.test(capture.old_recovery?.env_sha256 ?? '')
    && SHA.test(capture.old_recovery?.image_digests_sha256 ?? ''),
  'BRIDGE_ARTIFACTS_INVALID')
  return sha(canonical(capture))
}

export function assertBridge254Drain(observation) {
  required(observation?.ingress_fenced === true && observation?.callbacks_fenced === true
    && observation?.fence_observed_from_gateway === true, 'INGRESS_NOT_FENCED')
  required(Number.isSafeInteger(observation.in_flight_requests) && observation.in_flight_requests === 0
    && Number.isSafeInteger(observation.active_worker_cycles) && observation.active_worker_cycles === 0
    && Number.isSafeInteger(observation.active_outbox_leases) && observation.active_outbox_leases === 0
    && Number.isSafeInteger(observation.provider_started_unresolved) && observation.provider_started_unresolved === 0,
  'TASKS_NOT_DRAINED')
  required(SHA.test(observation.observation_sha256 ?? ''), 'DRAIN_EVIDENCE_MISSING')
}

export function assertBridge254Prefix(observed, expectedPrefix, frozenPrefixes) {
  required(Number.isSafeInteger(expectedPrefix) && expectedPrefix >= 242 && expectedPrefix <= 254, 'TARGET_PREFIX_INVALID')
  required(observed?.version === expectedPrefix && SHA.test(observed.history_sha256 ?? '')
    && observed.history_sha256 === frozenPrefixes?.[String(expectedPrefix)]
    && observed.ops_version === expectedPrefix && observed.ops_history_sha256 === observed.history_sha256,
  `PREFIX_${expectedPrefix}_MISMATCH`)
}

/**
 * Ports must make their own observations and mutations under one protected host
 * lock. A true value supplied by a caller is never a substitute for that port's
 * signed/independent observation. The core never opens ingress on its own.
 */
export async function executeBridge254Maintenance({ control, runtime, attemptId, expected, deploymentNonce }) {
  required(typeof attemptId === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(attemptId), 'ATTEMPT_INVALID')
  required(typeof deploymentNonce === 'string' && /^[A-Za-z0-9_-]{22,128}$/u.test(deploymentNonce), 'NONCE_INVALID')
  required(control && runtime && expected && Object.keys(expected.prefixes ?? {}).length === 13, 'PORTS_OR_PREFIXES_MISSING')
  await runtime.assertProtectedLock()
  const capture = await runtime.captureExactOldRuntime()
  const captureSha = assertBridge254FrozenCapture(capture, expected)
  const journalBody = await runtime.buildCapturedJournalBody({ attemptId, capture, captureSha, expected, deploymentNonce })
  let journal = await control.capture({ attemptId, journalBody, frozenCapture: capture, expected })
  required(journal?.phase === 'captured' && journal.baseline_inventory_sha256 === captureSha, 'CAPTURE_NOT_SIGNED')
  required(Object.keys(journal.allowed_prefix_sha256 ?? {}).length === 13
    && Object.entries(expected.prefixes).every(([version, digest]) => journal.allowed_prefix_sha256[version] === digest),
  'SIGNED_PREFIXES_MISMATCH')
  let prefix = 242
  const advance = async (phase, observationDigest) => {
    const result = await control.advance({ attemptId, fromPhase: journal.phase, toPhase: phase,
      observedPrefix: await runtime.observePrefix(), observationDigest, expected, deploymentNonce })
    journal = result.journal ?? result
    required(journal?.phase === phase, 'JOURNAL_ADVANCE_FAILED')
    assertBridge254Prefix(journal.database_prefix && { ...journal.database_prefix, ops_version: journal.database_prefix.version, ops_history_sha256: journal.database_prefix.history_sha256 }, prefix, expected.prefixes)
  }
  let fenceAttempted = false
  try {
  fenceAttempted = true
  const fenced = await runtime.fenceIngressAndCallbacks()
  required(fenced?.ingress_fenced === true && fenced?.callbacks_fenced === true, 'FENCE_FAILED')
  const drained = await runtime.observeDrain()
  assertBridge254Drain(drained)
  const stopped = await runtime.stopOldRuntimeGracefully(capture)
  required(stopped?.all_eight_stopped === true && stopped?.gateway_fenced === true && stopped?.no_active_processes === true, 'OLD_RUNTIME_NOT_STOPPED')
  assertBridge254Drain(await runtime.observeDrain())
  const backup = await runtime.backupAndRestore242()
  required(backup?.restored_prefix?.version === 242 && backup?.restored_prefix?.history_sha256 === expected.prefixes['242']
    && SHA.test(backup?.archive_sha256 ?? '') && backup?.signed === true, 'BACKUP_RESTORE_NOT_ATTESTED')
  assertBridge254Prefix(await runtime.observePrefix(), 242, expected.prefixes)
  await advance('nonce_consumed', drained.observation_sha256)
  await advance('bridge_mutation_started', captureSha)
  const installed = await runtime.startBridgeAt242()
  required(installed?.all_eight_running === true && installed?.ingress_fenced === true, 'BRIDGE_242_START_FAILED')
  const verified242 = await runtime.verifyBridgeAt242()
  required(verified242?.identity_verified === true && verified242?.api_ready === true && verified242?.six_workers_ready === true, 'BRIDGE_242_VERIFY_FAILED')
  await advance('bridge_verified', verified242.observation_sha256)
  await runtime.stopBridgeForMigration()
  const stoppedForMigration = await runtime.observeStoppedTraffic()
  required(stoppedForMigration?.all_runtime_stopped === true && stoppedForMigration?.ingress_fenced === true
    && stoppedForMigration?.callbacks_fenced === true, 'RUNTIME_NOT_STOPPED_FOR_MIGRATION')
  await advance('migration_started', captureSha)
    for (prefix = 243; prefix <= 254; prefix += 1) {
      await runtime.assertProtectedLock()
      const stoppedAtPrefix = await runtime.observeStoppedTraffic()
      required(stoppedAtPrefix?.all_runtime_stopped === true && stoppedAtPrefix?.ingress_fenced === true
        && stoppedAtPrefix?.callbacks_fenced === true, 'RUNTIME_RESUMED_DURING_MIGRATION')
      const before = await runtime.observePrefix()
      assertBridge254Prefix(before, prefix - 1, expected.prefixes)
      await runtime.applySingleMigration(prefix)
      const after = await runtime.observePrefix()
      assertBridge254Prefix(after, prefix, expected.prefixes)
      if (prefix === 243) await advance('forward_recovery_started', after.history_sha256)
      else {
        const result = await control.recordPrefix({ attemptId, expectedVersion: prefix - 1, observedPrefix: after,
          observationDigest: after.history_sha256, expected })
        journal = result.journal ?? result
      }
      required(journal?.database_prefix?.version === prefix && journal.database_prefix.history_sha256 === after.history_sha256,
      'PREFIX_NOT_SIGNED')
    }
  prefix = 254
  await advance('migration_254_verified', expected.prefixes['254'])
  const started = await runtime.startBridgeAt254()
  required(started?.all_eight_running === true && started?.ingress_fenced === true, 'BRIDGE_254_START_FAILED')
  const verified254 = await runtime.verifyBridgeAt254()
  required(verified254?.identity_verified === true && verified254?.api_ready === true && verified254?.six_workers_ready === true
    && verified254?.public_release_verified === true, 'BRIDGE_254_VERIFY_FAILED')
  return { status: 'verified_fenced', migration_version: 254, ingress_fenced: true, release_authorized: false,
    journal_phase: journal.phase, runtime_observation_sha256: verified254.observation_sha256 }
  } catch (error) {
    if (fenceAttempted) {
      try { await runtime.keepIngressFencedForForwardRecovery() }
      catch (fenceError) { throw new AggregateError([error, fenceError], 'bridge maintenance failed and ingress fence requires incident review') }
    }
    throw error
  }
}

/** Resume only from a protected, already consumed journal. Never recapture or
 * consume a second nonce. A database one prefix ahead of its signed journal
 * is the one allowed crash point after SQL commit and before journal fsync. */
export async function resumeBridge254ForwardMaintenance({ control, runtime, attemptId, expected, deploymentNonce }) {
  required(typeof attemptId === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(attemptId), 'ATTEMPT_INVALID')
  required(typeof deploymentNonce === 'string' && /^[A-Za-z0-9_-]{22,128}$/u.test(deploymentNonce), 'NONCE_INVALID')
  await runtime.assertProtectedLock()
  const frozen = await control.read({ attemptId, expected })
  let journal = frozen?.journal
  required(journal && ['captured', 'nonce_consumed', 'bridge_mutation_started', 'bridge_verified', 'migration_started', 'forward_recovery_started', 'migration_254_verified'].includes(journal.phase),
  'RESUME_PHASE_INVALID')
  required(expected?.oldRuntime?.release_id === expected?.old_runtime?.release_id
    && expected.oldRuntime.git_sha === expected.old_runtime.git_sha
    && expected.oldRuntime.manifest_sha256 === expected.old_runtime.manifest_sha256
    && expected.oldRuntime.image_set_digest === expected.old_runtime.image_set_digest,
  'RESUME_OLD_IDENTITY_MISMATCH')
  required(assertBridge254FrozenCapture(frozen.capture, expected) === journal.baseline_inventory_sha256,
  'RESUME_CAPTURE_MISMATCH')
  required(Object.keys(journal.allowed_prefix_sha256 ?? {}).length === 13
    && Object.entries(expected.prefixes ?? {}).every(([version, digest]) => journal.allowed_prefix_sha256[version] === digest),
  'RESUME_PREFIX_PLAN_MISMATCH')
  const stopped = async () => {
    const state = await runtime.observeStoppedTraffic()
    required(state?.all_runtime_stopped === true && state?.ingress_fenced === true && state?.callbacks_fenced === true,
    'RESUME_TRAFFIC_NOT_STOPPED')
  }
  const fenced = async () => {
    const state = await runtime.observeStoppedTraffic()
    required(state?.ingress_fenced === true && state?.callbacks_fenced === true, 'RESUME_INGRESS_FENCE_LOST')
  }
  const advance = async (phase, observed) => {
    const observationDigest = phase === 'bridge_mutation_started' || phase === 'migration_started'
      ? journal.baseline_inventory_sha256 : observed.history_sha256
    const result = await control.advance({ attemptId, fromPhase: journal.phase, toPhase: phase,
      observedPrefix: observed, observationDigest, expected, deploymentNonce })
    journal = result.journal ?? result
    required(journal.phase === phase && journal.database_prefix.version === observed.version, 'RESUME_JOURNAL_ADVANCE_FAILED')
  }
  try {
    if (['captured', 'nonce_consumed', 'bridge_mutation_started'].includes(journal.phase)) {
      const observed242 = await runtime.observePrefix()
      assertBridge254Prefix(observed242, 242, expected.prefixes)
      const fence = await runtime.fenceIngressAndCallbacks()
      required(fence?.ingress_fenced === true && fence?.callbacks_fenced === true, 'RESUME_FENCE_FAILED')
      assertBridge254Drain(await runtime.observeDrain())
      const stoppedOld = await runtime.stopOldRuntimeGracefully(frozen.capture)
      required(stoppedOld?.all_eight_stopped === true && stoppedOld?.gateway_fenced === true
        && stoppedOld?.no_active_processes === true, 'RESUME_OLD_RUNTIME_NOT_STOPPED')
      assertBridge254Drain(await runtime.observeDrain())
      const backup = await runtime.backupAndRestore242()
      required(backup?.restored_prefix?.version === 242 && backup.restored_prefix.history_sha256 === expected.prefixes['242']
        && SHA.test(backup.archive_sha256 ?? '') && backup.signed === true, 'RESUME_BACKUP_RESTORE_NOT_ATTESTED')
      if (journal.phase === 'captured') await advance('nonce_consumed', observed242)
      if (journal.phase === 'nonce_consumed') await advance('bridge_mutation_started', observed242)
      const started242 = await runtime.startBridgeAt242()
      required(started242?.all_eight_running === true && started242?.ingress_fenced === true, 'RESUME_BRIDGE_242_START_FAILED')
      const verified242 = await runtime.verifyBridgeAt242()
      required(verified242?.identity_verified === true && verified242?.api_ready === true
        && verified242?.six_workers_ready === true, 'RESUME_BRIDGE_242_VERIFY_FAILED')
      await advance('bridge_verified', observed242)
    }
    if (journal.phase === 'bridge_verified') {
      const bridge = await runtime.verifyBridgeAt242()
      required(bridge?.identity_verified === true && bridge?.api_ready === true && bridge?.six_workers_ready === true,
      'RESUME_BRIDGE_242_INVALID')
      const observed = await runtime.observePrefix()
      assertBridge254Prefix(observed, 242, expected.prefixes)
      await runtime.stopBridgeForMigration()
      await stopped()
      await advance('migration_started', observed)
    }
    if (journal.phase === 'migration_254_verified') await fenced()
    else await stopped()
    while (journal.database_prefix.version < 254) {
      await runtime.assertProtectedLock()
      await stopped()
      const signedPrefix = journal.database_prefix.version
      const live = await runtime.observePrefix()
      required(live?.version === signedPrefix || live?.version === signedPrefix + 1,
      'RESUME_LIVE_PREFIX_DRIFT')
      if (live.version === signedPrefix) {
        assertBridge254Prefix(live, signedPrefix, expected.prefixes)
        await runtime.applySingleMigration(signedPrefix + 1)
      }
      const after = await runtime.observePrefix()
      assertBridge254Prefix(after, signedPrefix + 1, expected.prefixes)
      if (signedPrefix === 242) await advance('forward_recovery_started', after)
      else {
        const result = await control.recordPrefix({ attemptId, expectedVersion: signedPrefix,
          observedPrefix: after, observationDigest: after.history_sha256, expected })
        journal = result.journal ?? result
        required(journal.database_prefix.version === after.version && journal.database_prefix.history_sha256 === after.history_sha256,
        'RESUME_PREFIX_NOT_SIGNED')
      }
    }
    const live254 = await runtime.observePrefix()
    assertBridge254Prefix(live254, 254, expected.prefixes)
    if (journal.phase !== 'migration_254_verified') await advance('migration_254_verified', live254)
    if (journal.phase === 'migration_254_verified') await fenced()
    else await stopped()
    const started = await runtime.startBridgeAt254()
    required(started?.all_eight_running === true && started?.ingress_fenced === true, 'RESUME_BRIDGE_254_START_FAILED')
    const verified = await runtime.verifyBridgeAt254()
    required(verified?.identity_verified === true && verified?.api_ready === true && verified?.six_workers_ready === true
      && verified?.public_release_verified === true, 'RESUME_BRIDGE_254_VERIFY_FAILED')
    return { status: 'verified_fenced', migration_version: 254, ingress_fenced: true, release_authorized: false,
      journal_phase: journal.phase, runtime_observation_sha256: verified.observation_sha256 }
  } catch (error) {
    try { await runtime.keepIngressFencedForForwardRecovery() }
    catch (fenceError) { throw new AggregateError([error, fenceError], 'bridge resume failed and ingress fence requires incident review') }
    throw error
  }
}
