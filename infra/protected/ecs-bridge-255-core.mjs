// 254→255 transition logic with injected protected host ports. There is no
// read-only status/verify-plan entrypoint exists, but no mutation adapter is
// implemented here. A caller must supply independently installed lock, nonce,
// signing, backup and runtime controls. Until those exist and pass real fault
// drills, production migration/cutover remains NO-GO.
import { createHash } from 'node:crypto'
import { reviewBridge255Phase, validateBridge255Plan } from './ecs-bridge-255-review.mjs'
import { reviewBridge255Transition, BRIDGE_255_HOST_CONTRACT } from './ecs-bridge-255-state.mjs'

const requireValue = (ok, reason) => { if (!ok) throw new Error(`BRIDGE_255_CORE_${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const identityFields = ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest']

// Check the complete adapter surface before even taking a capture or writing a
// signed phase. A partially installed host adapter must fail before it can
// fence traffic and then discover that it cannot observe, recover, or journal
// the transition. These are capability checks only; they do not prove that a
// supplied adapter is trustworthy or production-ready.
function requirePorts(value, methods, label) {
  requireValue(value && methods.every(method => typeof value[method] === 'function'),
    `${label}_PORTS_INCOMPLETE`)
}

function requireExecutionPorts(control, runtime) {
  requirePorts(control, ['captureSigned', 'advanceSigned', 'consumeNonceOnce'], 'CONTROL')
  requirePorts(runtime, ['assertProtectedLock', 'captureExactBridgeAt254', 'observePhase',
    'fenceIngressAndCallbacks', 'stopExactOldRuntime', 'observeFenceAndDrain',
    'createSignedDemo254BackupAndVerifyPg17Restore', 'observeDatabasePrefix',
    'applyOnlyMigration255', 'startPinnedRecovery255', 'keepIngressFencedForForwardRecovery'], 'RUNTIME')
}

function requireResumePorts(control, runtime) {
  requirePorts(control, ['readFrozenAttempt', 'readConsumedNonce', 'advanceSigned'], 'CONTROL')
  requirePorts(runtime, ['assertProtectedLock', 'observePhase', 'observeFenceAndDrain',
    'observeDatabasePrefix', 'applyOnlyMigration255', 'startPinnedRecovery255',
    'keepIngressFencedForForwardRecovery'], 'RUNTIME')
}

function assertNonceReceipt(receipt, plan) {
  requireValue(receipt && Object.keys(receipt).sort().join('\0') === [
    'namespace', 'operation', 'attempt_id', 'nonce_sha256', ...identityFields,
  ].sort().join('\0'), 'NONCE_RECEIPT_SHAPE_INVALID')
  requireValue(receipt.namespace === BRIDGE_255_HOST_CONTRACT.nonce_namespace
    && receipt.operation === BRIDGE_255_HOST_CONTRACT.nonce_operation
    && receipt.attempt_id === plan.attempt_id
    && receipt.nonce_sha256 === plan.nonce_sha256
    && identityFields.every(field => receipt[field] === plan.bridge_254_255.identity[field]),
  'NONCE_OWNER_MISMATCH')
}

async function assertLocked(runtime) {
  const lock = await runtime.assertProtectedLock(BRIDGE_255_HOST_CONTRACT.production_lock)
  requireValue(lock?.held === true && lock?.path === BRIDGE_255_HOST_CONTRACT.production_lock
    && lock?.owner === 'protected-host', 'PRODUCTION_LOCK_UNVERIFIED')
}

async function advance({ control, runtime, plan, capture, publicKeyPem, previous, previousObservation, phase, now }) {
  await assertLocked(runtime)
  const observation = await runtime.observePhase(phase)
  const next = await control.advanceSigned({ plan, capture, previous, phase, observation })
  reviewBridge255Transition({ plan, capture, previous, next, publicKeyPem,
    previousObservation, nextObservation: observation, now })
  return { journal: next, observation }
}

async function assertFenced(runtime, plan) {
  await assertLocked(runtime)
  const state = await runtime.observeFenceAndDrain()
  const stopped = plan.old_demo_services.filter(name => name === 'api' || name === 'api-replica'
    || name.startsWith('worker-'))
  requireValue(state?.ingress_fenced === true && state?.callbacks_fenced === true
    && state?.gateway_fence_verified === true && state?.in_flight_requests === 0
    && state?.active_worker_cycles === 0 && state?.active_outbox_leases === 0
    && state?.provider_started_unresolved === 0
    && Array.isArray(state?.stopped_services)
    && stopped.every(name => state.stopped_services.includes(name)), 'FENCE_OR_DRAIN_LOST')
}

/**
 * The database remains read-only until the signed migrating_255 journal and
 * the one-use nonce receipt have both been checked. On any later error ingress
 * stays fenced; forward recovery is a separate same-attempt operation.
 */
export async function executeBridge255ForwardMigration({ plan, deploymentNonce, publicKeyPem,
  control, runtime, now = new Date() }) {
  validateBridge255Plan(plan)
  requireValue(typeof deploymentNonce === 'string' && /^[A-Za-z0-9_-]{22,128}$/u.test(deploymentNonce)
    && sha(deploymentNonce) === plan.nonce_sha256, 'NONCE_INPUT_INVALID')
  requireValue(typeof publicKeyPem === 'string', 'PROTECTED_PORTS_MISSING')
  requireExecutionPorts(control, runtime)
  await assertLocked(runtime)
  const capture = await runtime.captureExactBridgeAt254()
  const capturedObservation = await runtime.observePhase('captured_254')
  const captured = await control.captureSigned({ plan, capture, observation: capturedObservation })
  reviewBridge255Phase({ plan, capture, journal: captured, publicKeyPem,
    observation: capturedObservation, now })

  let fenceAttempted = false
  try {
    fenceAttempted = true
    await runtime.fenceIngressAndCallbacks()
    await runtime.stopExactOldRuntime(capture)
    await assertFenced(runtime, plan)
    const backup = await runtime.createSignedDemo254BackupAndVerifyPg17Restore({ plan, capture })
    requireValue(backup?.signed === true && backup?.restored_prefix_version === 254
      && backup?.restored_prefix_sha256 === plan.database.prefix_254_sha256
      && backup?.pg17_image_ref === plan.pg17_image_ref, 'SIGNED_254_RESTORE_MISSING')
    let current = await advance({ control, runtime, plan, capture, publicKeyPem,
      previous: captured, previousObservation: capturedObservation, phase: 'fenced_254', now })
    await assertFenced(runtime, plan)
    const receipt = await control.consumeNonceOnce({ plan, deploymentNonce,
      namespace: BRIDGE_255_HOST_CONTRACT.nonce_namespace,
      operation: BRIDGE_255_HOST_CONTRACT.nonce_operation })
    assertNonceReceipt(receipt, plan)
    const migrating = await advance({ control, runtime, plan, capture, publicKeyPem,
      previous: current.journal, previousObservation: current.observation,
      phase: 'migrating_255', now })
    await assertFenced(runtime, plan)
    const before = await runtime.observeDatabasePrefix()
    requireValue(before?.version === 254 && before?.history_sha256 === plan.database.prefix_254_sha256
      && before?.ops_version === 254 && before?.ops_history_sha256 === before.history_sha256,
    'PRE_MIGRATION_PREFIX_CHANGED')
    await runtime.applyOnlyMigration255({ plan, capture, receipt })
    await assertFenced(runtime, plan)
    const after = await runtime.observeDatabasePrefix()
    requireValue(after?.version === 255 && after?.history_sha256 === plan.database.prefix_255_sha256
      && after?.ops_version === 255 && after?.ops_history_sha256 === after.history_sha256,
    'POST_MIGRATION_PREFIX_INVALID')
    await runtime.startPinnedRecovery255({ plan, capture })
    current = await advance({ control, runtime, plan, capture, publicKeyPem,
      previous: migrating.journal, previousObservation: migrating.observation,
      phase: 'verified_255', now })
    return Object.freeze({ status: 'recovery_255_verified_fenced', release_authorized: false,
      production_cutover_authorized: false, phase: current.journal.phase,
      database_version: 255, ingress_fenced: true })
  } catch (error) {
    if (fenceAttempted) {
      try { await runtime.keepIngressFencedForForwardRecovery() }
      catch (fenceError) { throw new AggregateError([error, fenceError], 'bridge 255 failed and ingress fence needs incident recovery') }
    }
    throw error
  }
}

/**
 * Crash recovery after a consumed nonce. Never recaptures, issues a new nonce,
 * or replays migration 255 when the signed database history already shows 255.
 * The caller may only supply the original protected captured bundle.
 */
export async function resumeBridge255ForwardRecovery({ plan, publicKeyPem, control, runtime,
  now = new Date() }) {
  validateBridge255Plan(plan)
  requireValue(typeof publicKeyPem === 'string', 'PROTECTED_PORTS_MISSING')
  requireResumePorts(control, runtime)
  await assertLocked(runtime)
  try {
    // Once the protected lock is held, every recovery failure must leave the
    // ingress fenced. Reading or verifying the frozen journal is itself part
    // of that recovery attempt and cannot sit outside the fence-on-error path.
    const frozen = await control.readFrozenAttempt({ attemptId: plan.attempt_id })
    requireValue(frozen?.plan_sha256 === validateBridge255Plan(plan)
      && ['fenced_254', 'migrating_255'].includes(frozen?.journal?.phase), 'RESUME_JOURNAL_INVALID')
    const { capture } = frozen
    let { journal, observation } = frozen
    reviewBridge255Phase({ plan, capture, journal, publicKeyPem, observation, now })
    const receipt = await control.readConsumedNonce({ attemptId: plan.attempt_id,
      nonce_sha256: plan.nonce_sha256 })
    assertNonceReceipt(receipt, plan)
    await assertFenced(runtime, plan)
    // A process can die after the durable one-use nonce commit but before the
    // migrating_255 journal rename. Resume that exact attempt by recording the
    // missing signed phase; never require or consume a replacement nonce.
    if (journal.phase === 'fenced_254') {
      const resumed = await advance({ control, runtime, plan, capture, publicKeyPem,
        previous: journal, previousObservation: observation, phase: 'migrating_255', now })
      journal = resumed.journal
      observation = resumed.observation
    }
    const current = await runtime.observeDatabasePrefix()
    requireValue([254, 255].includes(current?.version)
      && current.history_sha256 === plan.database[`prefix_${current.version}_sha256`]
      && current.ops_version === current.version
      && current.ops_history_sha256 === current.history_sha256,
    'RESUME_PREFIX_DRIFT')
    if (current.version === 254) {
      await runtime.applyOnlyMigration255({ plan, capture, receipt })
      await assertFenced(runtime, plan)
    }
    const after = await runtime.observeDatabasePrefix()
    requireValue(after?.version === 255 && after?.history_sha256 === plan.database.prefix_255_sha256
      && after?.ops_version === 255 && after?.ops_history_sha256 === after.history_sha256,
    'RESUME_255_UNVERIFIED')
    await runtime.startPinnedRecovery255({ plan, capture })
    const verified = await advance({ control, runtime, plan, capture, publicKeyPem,
      previous: journal, previousObservation: observation, phase: 'verified_255', now })
    return Object.freeze({ status: 'recovery_255_verified_fenced', release_authorized: false,
      production_cutover_authorized: false, phase: verified.journal.phase,
      database_version: 255, ingress_fenced: true })
  } catch (error) {
    try { await assertLocked(runtime) }
    catch (lockError) {
      throw new AggregateError([error, lockError], 'bridge 255 resume failed after production lock was lost; ingress state needs incident recovery')
    }
    try { await runtime.keepIngressFencedForForwardRecovery() }
    catch (fenceError) { throw new AggregateError([error, fenceError], 'bridge 255 resume failed and ingress fence needs incident recovery') }
    throw error
  }
}
