import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { executeBridge255ForwardMigration, resumeBridge255ForwardRecovery } from '../infra/protected/ecs-bridge-255-core.mjs'
import { validateBridge255Plan } from '../infra/protected/ecs-bridge-255-review.mjs'

const h = char => char.repeat(64)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => sha(canonical(value))
const signedDigest = value => sha(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))))
const services = ['api', 'api-replica', 'ui', 'ops-ui', 'payment-gateway', 'worker-sync',
  'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation',
  'postgres', 'redis', 'pilot-gateway'].sort()
const runtimeServices = services.filter(name => name === 'api' || name === 'api-replica' || name.startsWith('worker-'))

function fixture() {
  const nonce = 'nonce_abcdefghijklmnopqrstu'
  const key = generateKeyPairSync('ed25519')
  const identity = char => ({ release_id: `release-${char}`, git_sha: char.repeat(40),
    manifest_sha256: h(char), image_set_digest: `sha256:${h(char)}` })
  const artifacts = char => ({ identity: identity(char), compose_sha256: h(char),
    env_sha256: h(char), image_digests_sha256: h(char) })
  const plan = { schema_version: 'ecs-bridge-255-plan/1', attempt_id: 'attempt_abcdefghijklmnop',
    project: 'merchant-demo-85575f9c', lock_path: '/var/lib/merchant-release-security/production-deploy.lock',
    nonce_sha256: sha(nonce), old_demo: artifacts('b'), bridge_254_255: artifacts('c'),
    candidate_255: artifacts('d'), recovery_255: artifacts('e'),
    old_demo_services: services, recovery_255_services: services, candidate_255_services: services,
    database: { strategy: 'forward_only', schema_downgrade: false, preserve_volumes: true,
      prefix_254_sha256: h('1'), prefix_255_sha256: h('2') }, pg17_image_ref: `sha256:${h('f')}` }
  const prefix = version => ({ version, history_sha256: version === 254 ? h('1') : h('2'),
    ops_version: version, ops_history_sha256: version === 254 ? h('1') : h('2') })
  const captureBody = { project: plan.project, public_release: plan.bridge_254_255.identity,
    database: prefix(254), compose_services: services, compose_sha256: plan.bridge_254_255.compose_sha256,
    containers: services.map((service, index) => ({ service, name: `${plan.project}-${service}-1`,
      project: plan.project, compose_service: service, id: index.toString(16).padStart(64, '0'),
      image_id: `sha256:${(index + 16).toString(16).padStart(64, '0')}`,
      inspect_sha256: h('3'), network_sha256: h('4'), running: true })),
    gateway_ports: { http: 80, https: 443 } }
  const capture = { ...captureBody, capture_sha256: digest(captureBody) }
  const state = { version: 254, fenced: false, stopped: false, backup: null, recoveryReady: false,
    sqlCount: 0, nonceCount: 0, crashBeforeSql: false, crashAfterSql: false,
    crashNonceJournal: false, failBackup: false, badReceipt: false, badReadReceipt: false,
    loseFence: false, events: [], journal: null, journalObservation: null }
  const observation = phase => ({ phase, database: prefix(state.version),
    ingress_fenced: state.fenced, callbacks_fenced: state.fenced,
    in_flight_requests: 0, active_worker_cycles: 0, active_outbox_leases: 0,
    provider_started_unresolved: 0, stopped_services: state.stopped ? runtimeServices : [],
    backup: state.backup,
    runtime: state.recoveryReady ? { identity: plan.recovery_255.identity, services,
      api_ready: true, api_replica_ready: true, workers_ready: 5, business_canary_passed: true,
      ops_canary_passed: true, model_relay_passed: true, codex_stdio_host_passed: true } : null,
    gateway: state.fenced ? { ingress_fence_verified: true,
      release_identity_verified: state.recoveryReady, https_ready: state.recoveryReady } : null })
  const createJournal = (phase, previous = null) => {
    const body = { schema_version: 'ecs-bridge-255-journal/2', attempt_id: plan.attempt_id,
      plan_sha256: validateBridge255Plan(plan), phase,
      previous_journal_sha256: previous ? signedDigest(previous) : null,
      nonce_sha256: plan.nonce_sha256, capture_sha256: capture.capture_sha256,
      observation_sha256: digest(observation(phase)),
      created_at: new Date(Date.parse('2026-09-28T04:00:00.000Z') + (previous ?
        Date.parse(previous.created_at) - Date.parse('2026-09-28T04:00:00.000Z') + 1_000 : 0)).toISOString(),
      expires_at: '2026-09-28T05:00:00.000Z' }
    return { ...body, signature_base64: sign(null, Buffer.from(canonical(body)), key.privateKey).toString('base64') }
  }
  const control = {
    async captureSigned({ observation: observed }) {
      state.events.push('capture')
      state.journal = createJournal('captured_254')
      state.journalObservation = observed
      return state.journal
    },
    async advanceSigned({ previous, phase, observation: observed }) {
      state.events.push(`journal:${phase}`)
      if (phase === 'migrating_255' && state.crashNonceJournal) throw new Error('crash after nonce before journal')
      assert.equal(previous, state.journal)
      state.journal = createJournal(phase, previous)
      state.journalObservation = observed
      return state.journal
    },
    async consumeNonceOnce() {
      state.events.push('nonce')
      state.nonceCount += 1
      return { namespace: 'merchant-production-deploy', operation: 'bridge-255',
        attempt_id: plan.attempt_id, nonce_sha256: plan.nonce_sha256,
        ...plan.bridge_254_255.identity, ...(state.badReceipt ? { operation: 'other' } : {}) }
    },
    async readFrozenAttempt() { return { plan_sha256: validateBridge255Plan(plan), capture,
      journal: state.journal, observation: state.journalObservation } },
    async readConsumedNonce() { return { namespace: 'merchant-production-deploy', operation: state.badReadReceipt ? 'other' : 'bridge-255',
      attempt_id: plan.attempt_id, nonce_sha256: plan.nonce_sha256,
      ...plan.bridge_254_255.identity } },
  }
  const runtime = {
    async assertProtectedLock(path) { state.events.push('lock'); return { held: true, path, owner: 'protected-host' } },
    async captureExactBridgeAt254() { return capture },
    async observePhase(phase) { return observation(phase) },
    async fenceIngressAndCallbacks() { state.events.push('fence'); state.fenced = true },
    async stopExactOldRuntime() { state.events.push('stop-old'); state.stopped = true },
    async observeFenceAndDrain() { return { ingress_fenced: state.fenced && !state.loseFence,
      callbacks_fenced: state.fenced, gateway_fence_verified: state.fenced,
      in_flight_requests: 0, active_worker_cycles: 0, active_outbox_leases: 0,
      provider_started_unresolved: 0, stopped_services: state.stopped ? runtimeServices : [] } },
    async createSignedDemo254BackupAndVerifyPg17Restore() {
      state.events.push('backup')
      if (state.failBackup) throw new Error('backup failed')
      state.backup = { signed: true, pg17_image_ref: plan.pg17_image_ref,
        archive_sha256: h('6'), restored_prefix_version: 254,
        restored_prefix_sha256: plan.database.prefix_254_sha256 }
      return state.backup
    },
    async observeDatabasePrefix() { return prefix(state.version) },
    async applyOnlyMigration255() {
      state.events.push('sql255')
      if (state.crashBeforeSql) throw new Error('crash before SQL BEGIN')
      state.sqlCount += 1
      state.version = 255
      if (state.crashAfterSql) throw new Error('crash after SQL COMMIT')
    },
    async startPinnedRecovery255() { state.events.push('recovery255'); state.recoveryReady = true },
    async keepIngressFencedForForwardRecovery() { state.events.push('keep-fenced'); state.fenced = true },
  }
  return { plan, nonce, publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    control, runtime, state, now: new Date('2026-09-28T04:02:00.000Z') }
}

test('fence, drain, signed restore, nonce and journal precede the only SQL mutation', async () => {
  const f = fixture()
  const result = await executeBridge255ForwardMigration({ plan: f.plan, deploymentNonce: f.nonce,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now })
  assert.equal(result.status, 'recovery_255_verified_fenced')
  assert.equal(result.release_authorized, false)
  assert.equal(f.state.sqlCount, 1)
  assert.equal(f.state.nonceCount, 1)
  for (const event of ['fence', 'stop-old', 'backup', 'journal:fenced_254', 'nonce', 'journal:migrating_255']) {
    assert.ok(f.state.events.indexOf(event) < f.state.events.indexOf('sql255'), event)
  }
  assert.equal(f.state.fenced, true)
  assert.equal(f.state.events.includes('restart-old-254'), false)
})

test('backup or nonce failure keeps the database 254 and retains ingress fence', async () => {
  for (const field of ['failBackup', 'badReceipt']) {
    const f = fixture(); f.state[field] = true
    await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
      deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
      control: f.control, runtime: f.runtime, now: f.now }))
    assert.equal(f.state.version, 254)
    assert.equal(f.state.sqlCount, 0)
    assert.equal(f.state.fenced, true)
    assert.ok(f.state.events.includes('keep-fenced'))
  }
})

test('a lost fence immediately before SQL prevents migration', async () => {
  const f = fixture()
  f.state.loseFence = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }), /FENCE_OR_DRAIN_LOST/u)
  assert.equal(f.state.sqlCount, 0)
})

test('crash after SQL commit resumes same signed attempt without replaying SQL or nonce', async () => {
  const f = fixture(); f.state.crashAfterSql = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }), /crash after SQL COMMIT/u)
  assert.equal(f.state.version, 255)
  assert.equal(f.state.journal.phase, 'migrating_255')
  assert.equal(f.state.nonceCount, 1)
  f.state.crashAfterSql = false
  const recovered = await resumeBridge255ForwardRecovery({ plan: f.plan,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now })
  assert.equal(recovered.status, 'recovery_255_verified_fenced')
  assert.equal(f.state.sqlCount, 1)
  assert.equal(f.state.nonceCount, 1)
  assert.equal(f.state.fenced, true)
})

test('crash before SQL resumes the same nonce and applies migration once', async () => {
  const f = fixture(); f.state.crashBeforeSql = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }), /crash before SQL BEGIN/u)
  assert.equal(f.state.version, 254)
  assert.equal(f.state.journal.phase, 'migrating_255')
  f.state.crashBeforeSql = false
  const recovered = await resumeBridge255ForwardRecovery({ plan: f.plan,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now })
  assert.equal(recovered.database_version, 255)
  assert.equal(f.state.sqlCount, 1)
  assert.equal(f.state.nonceCount, 1)
})

test('crash after nonce commit but before migrating journal resumes the same fenced attempt', async () => {
  const f = fixture(); f.state.crashNonceJournal = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }), /crash after nonce before journal/u)
  assert.equal(f.state.version, 254)
  assert.equal(f.state.nonceCount, 1)
  assert.equal(f.state.journal.phase, 'fenced_254')
  f.state.crashNonceJournal = false
  const recovered = await resumeBridge255ForwardRecovery({ plan: f.plan,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now })
  assert.equal(recovered.status, 'recovery_255_verified_fenced')
  assert.equal(f.state.sqlCount, 1)
  assert.equal(f.state.nonceCount, 1)
  assert.equal(f.state.fenced, true)
  assert.equal(f.state.journal.phase, 'verified_255')
})

test('invalid consumed nonce receipt during resume keeps the ingress fence', async () => {
  const f = fixture(); f.state.crashNonceJournal = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }))
  f.state.crashNonceJournal = false
  f.state.badReadReceipt = true
  await assert.rejects(resumeBridge255ForwardRecovery({ plan: f.plan,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now }), /NONCE_OWNER_MISMATCH/u)
  assert.equal(f.state.version, 254)
  assert.equal(f.state.sqlCount, 0)
  assert.equal(f.state.fenced, true)
  assert.ok(f.state.events.includes('keep-fenced'))
})

test('resume refuses changed plan or database history without mutation', async () => {
  const f = fixture(); f.state.crashAfterSql = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }))
  const changed = structuredClone(f.plan); changed.candidate_255.compose_sha256 = h('7')
  await assert.rejects(resumeBridge255ForwardRecovery({ plan: changed,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now }), /RESUME_JOURNAL_INVALID/u)
  assert.equal(f.state.sqlCount, 1)
})
