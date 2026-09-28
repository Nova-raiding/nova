import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { executeBridge255ForwardMigration, resumeBridge255ForwardRecovery } from '../infra/protected/ecs-bridge-255-core.mjs'
import { validateBridge255Plan } from '../infra/protected/ecs-bridge-255-review.mjs'
import { createBridge255StateStore, productionLockProbeConflicts, verifySignedBridge255ExecutionPlan } from '../infra/protected/ecs-bridge-255-state-store.mjs'

const h = char => char.repeat(64)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => sha(canonical(value))
const signedDigest = value => sha(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))))

test('production lock probe passes the lock path to flock and accepts only real contention', () => {
  const calls = []
  const probe = (...args) => { calls.push(args); return { status: 1 } }
  assert.equal(productionLockProbeConflicts('/protected/deploy.lock', probe), true)
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/flock', ['-n', '/protected/deploy.lock', '/bin/true']])
  assert.equal(productionLockProbeConflicts('/protected/deploy.lock', () => ({ status: 0 })), false)
  assert.equal(productionLockProbeConflicts('/protected/deploy.lock', () => ({ status: 127 })), false)
})
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
    privateKeyPem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    control, runtime, state, now: new Date('2026-09-28T04:02:00.000Z') }
}

function commitNonce(ledgerPath, nonce, plan) {
  const identity = plan.bridge_254_255.identity
  const db = new DatabaseSync(ledgerPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('CREATE TABLE IF NOT EXISTS consumed_nonces (namespace TEXT,nonce TEXT,release_id TEXT,image_digest TEXT,manifest_sha256 TEXT,release_git_sha TEXT,PRIMARY KEY(namespace,nonce))')
    db.exec('CREATE TABLE IF NOT EXISTS nonce_owners (namespace TEXT,nonce TEXT,operation TEXT,attempt_id TEXT,PRIMARY KEY(namespace,nonce))')
    db.prepare('INSERT INTO consumed_nonces VALUES (?,?,?,?,?,?)').run('merchant-production-deploy', nonce,
      identity.release_id, identity.image_set_digest, identity.manifest_sha256, identity.git_sha)
    db.prepare('INSERT INTO nonce_owners VALUES (?,?,?,?)').run('merchant-production-deploy', nonce, 'bridge-255', plan.attempt_id)
    db.exec('COMMIT')
  } finally { db.close(); chmodSync(ledgerPath, 0o600) }
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

test('incomplete host adapters are rejected before lock, capture, journal or fence operations', async () => {
  const runtimeMissing = fixture()
  delete runtimeMissing.runtime.keepIngressFencedForForwardRecovery
  await assert.rejects(executeBridge255ForwardMigration({ plan: runtimeMissing.plan,
    deploymentNonce: runtimeMissing.nonce, publicKeyPem: runtimeMissing.publicKeyPem,
    control: runtimeMissing.control, runtime: runtimeMissing.runtime, now: runtimeMissing.now }),
  /BRIDGE_255_CORE_RUNTIME_PORTS_INCOMPLETE/u)
  assert.deepEqual(runtimeMissing.state.events, [])

  const controlMissing = fixture()
  delete controlMissing.control.consumeNonceOnce
  await assert.rejects(executeBridge255ForwardMigration({ plan: controlMissing.plan,
    deploymentNonce: controlMissing.nonce, publicKeyPem: controlMissing.publicKeyPem,
    control: controlMissing.control, runtime: controlMissing.runtime, now: controlMissing.now }),
  /BRIDGE_255_CORE_CONTROL_PORTS_INCOMPLETE/u)
  assert.deepEqual(controlMissing.state.events, [])

  const resumeMissing = fixture()
  delete resumeMissing.runtime.observeDatabasePrefix
  await assert.rejects(resumeBridge255ForwardRecovery({ plan: resumeMissing.plan,
    publicKeyPem: resumeMissing.publicKeyPem, control: resumeMissing.control,
    runtime: resumeMissing.runtime, now: resumeMissing.now }),
  /BRIDGE_255_CORE_RUNTIME_PORTS_INCOMPLETE/u)
  assert.deepEqual(resumeMissing.state.events, [])
})

test('protected journal store persists an approved attempt and resumes with the same nonce after SQL commit', async () => {
  const f = fixture()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'merchant-bridge-255-state-'))
  try {
    const ledgerPath = join(dir, 'nonces.sqlite3')
    const ledger = new DatabaseSync(ledgerPath)
    ledger.exec('CREATE TABLE consumed_nonces (namespace TEXT,nonce TEXT,release_id TEXT,image_digest TEXT,manifest_sha256 TEXT,release_git_sha TEXT,PRIMARY KEY(namespace,nonce))')
    ledger.exec('CREATE TABLE nonce_owners (namespace TEXT,nonce TEXT,operation TEXT,attempt_id TEXT,PRIMARY KEY(namespace,nonce))')
    ledger.close(); chmodSync(ledgerPath, 0o600)
    let ticks = 0
    const store = createBridge255StateStore({ directory: dir, ledgerPath,
      consumerPath: join(dir, 'unused-consumer'), privateKeyPem: f.privateKeyPem,
      publicKeyPem: f.publicKeyPem, trustedKeyId: 'isolated-key',
      approvedPlanSha256: validateBridge255Plan(f.plan), approvedPlan: f.plan,
      expectedUid: process.getuid(), requireProductionLock: false,
      now: () => new Date(f.now.getTime() + 1000 * ticks++),
      consume: nonce => commitNonce(ledgerPath, nonce, f.plan) })
    assert.throws(() => createBridge255StateStore({ directory: dir, ledgerPath,
      consumerPath: join(dir, 'unused-consumer'), privateKeyPem: f.privateKeyPem,
      publicKeyPem: f.publicKeyPem, trustedKeyId: 'isolated-key',
      approvedPlanSha256: h('0'), approvedPlan: f.plan,
      expectedUid: process.getuid(), requireProductionLock: false }), /APPROVED_PLAN_HASH_MISMATCH/u)
    f.state.crashAfterSql = true
    const args = { plan: f.plan, deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
      control: store, runtime: f.runtime, now: f.now }
    await assert.rejects(executeBridge255ForwardMigration(args), /crash after SQL COMMIT/u)
    assert.equal(f.state.version, 255)
    const recovered = await resumeBridge255ForwardRecovery(args)
    assert.equal(recovered.status, 'recovery_255_verified_fenced')
    assert.equal(f.state.sqlCount, 1, 'durable 255 prefix must prevent replaying SQL')
    assert.equal(f.state.nonceCount, 0, 'durable nonce receipt must not be consumed twice')
    assert.equal(f.state.fenced, true)
    const frozen = await store.readFrozenAttempt({ attemptId: f.plan.attempt_id })
    assert.equal(frozen.journal.phase, 'verified_255')
    assert.equal(frozen.journal.plan_sha256, validateBridge255Plan(f.plan))
    const statePath = join(dir, `${f.plan.attempt_id}.json`)
    const tampered = JSON.parse(readFileSync(statePath, 'utf8'))
    tampered.history.at(-1).observation.runtime.business_canary_passed = false
    chmodSync(statePath, 0o600)
    writeFileSync(statePath, `${JSON.stringify(tampered)}\n`)
    chmodSync(statePath, 0o400)
    await assert.rejects(store.readFrozenAttempt({ attemptId: f.plan.attempt_id }), /JOURNAL_OBSERVATION_BINDING_INVALID/u)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('production execution-plan trust requires a fresh 24-hour Ed25519 approval envelope', () => {
  const f = fixture()
  const body = { schema_version: 'ecs-bridge-255-execution-plan/1', key_id: 'isolated-key', plan: f.plan,
    created_at: f.now.toISOString(), expires_at: new Date(f.now.getTime() + 60_000).toISOString() }
  const envelope = { ...body, signature_base64: sign(null, Buffer.from(canonical(body)), f.privateKeyPem).toString('base64') }
  assert.equal(verifySignedBridge255ExecutionPlan(envelope, f.publicKeyPem, 'isolated-key', f.now).plan_sha256,
    validateBridge255Plan(f.plan))
  assert.throws(() => verifySignedBridge255ExecutionPlan({ ...envelope, plan: { ...f.plan, attempt_id: 'changed_attempt_123456' } },
    f.publicKeyPem, 'isolated-key', f.now), /APPROVED_PLAN_SIGNATURE_INVALID/u)
  assert.throws(() => verifySignedBridge255ExecutionPlan(envelope, f.publicKeyPem, 'isolated-key',
    new Date(f.now.getTime() + 61_000)), /APPROVED_PLAN_TIME_INVALID/u)
})

test('durable nonce survives a crash before the migrating journal and is never re-consumed', async () => {
  const f = fixture()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'merchant-bridge-255-state-'))
  try {
    const ledgerPath = join(dir, 'nonces.sqlite3')
    const ledger = new DatabaseSync(ledgerPath)
    ledger.exec('CREATE TABLE consumed_nonces (namespace TEXT,nonce TEXT,release_id TEXT,image_digest TEXT,manifest_sha256 TEXT,release_git_sha TEXT,PRIMARY KEY(namespace,nonce))')
    ledger.exec('CREATE TABLE nonce_owners (namespace TEXT,nonce TEXT,operation TEXT,attempt_id TEXT,PRIMARY KEY(namespace,nonce))')
    ledger.close(); chmodSync(ledgerPath, 0o600)
    let ticks = 0, consumeCalls = 0, crashAfterCommit = true
    const store = createBridge255StateStore({ directory: dir, ledgerPath,
      consumerPath: join(dir, 'unused-consumer'), privateKeyPem: f.privateKeyPem,
      publicKeyPem: f.publicKeyPem, trustedKeyId: 'isolated-key',
      approvedPlanSha256: validateBridge255Plan(f.plan), approvedPlan: f.plan,
      expectedUid: process.getuid(), requireProductionLock: false,
      now: () => new Date(f.now.getTime() + 1000 * ticks++),
      consume: (nonce, plan) => {
        consumeCalls += 1
        commitNonce(ledgerPath, nonce, plan)
        if (crashAfterCommit) { crashAfterCommit = false; throw new Error('simulated crash after durable nonce commit') }
      } })
    const args = { plan: f.plan, deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
      control: store, runtime: f.runtime, now: f.now }
    await assert.rejects(executeBridge255ForwardMigration(args), /simulated crash after durable nonce commit/u)
    assert.equal(f.state.version, 254)
    assert.equal(f.state.sqlCount, 0)
    assert.equal(f.state.fenced, true)
    assert.equal((await store.readFrozenAttempt({ attemptId: f.plan.attempt_id })).journal.phase, 'fenced_254')
    const recovered = await resumeBridge255ForwardRecovery(args)
    assert.equal(recovered.status, 'recovery_255_verified_fenced')
    assert.equal(f.state.version, 255)
    assert.equal(f.state.sqlCount, 1)
    assert.equal(consumeCalls, 1, 'recovery must read the committed owner row rather than consume again')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('duplicate nonce bindings fail closed without invoking the production consumer', async () => {
  const f = fixture()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'merchant-bridge-255-state-'))
  try {
    const ledgerPath = join(dir, 'nonces.sqlite3')
    const ledger = new DatabaseSync(ledgerPath)
    ledger.exec('CREATE TABLE consumed_nonces (namespace TEXT,nonce TEXT,release_id TEXT,image_digest TEXT,manifest_sha256 TEXT,release_git_sha TEXT)')
    ledger.exec('CREATE TABLE nonce_owners (namespace TEXT,nonce TEXT,operation TEXT,attempt_id TEXT)')
    const identity = f.plan.bridge_254_255.identity
    const row = ['merchant-production-deploy', f.nonce, identity.release_id, identity.image_set_digest,
      identity.manifest_sha256, identity.git_sha]
    ledger.prepare('INSERT INTO consumed_nonces VALUES (?,?,?,?,?,?)').run(...row)
    ledger.prepare('INSERT INTO consumed_nonces VALUES (?,?,?,?,?,?)').run(...row)
    ledger.prepare('INSERT INTO nonce_owners VALUES (?,?,?,?)').run('merchant-production-deploy', f.nonce,
      'bridge-255', f.plan.attempt_id)
    ledger.close(); chmodSync(ledgerPath, 0o600)
    let consumeCalls = 0
    const store = createBridge255StateStore({ directory: dir, ledgerPath,
      consumerPath: join(dir, 'unused-consumer'), privateKeyPem: f.privateKeyPem,
      publicKeyPem: f.publicKeyPem, trustedKeyId: 'isolated-key',
      approvedPlanSha256: validateBridge255Plan(f.plan), approvedPlan: f.plan,
      expectedUid: process.getuid(), requireProductionLock: false,
      consume: () => { consumeCalls += 1 } })
    await assert.rejects(store.consumeNonceOnce({ plan: f.plan, deploymentNonce: f.nonce,
      namespace: 'merchant-production-deploy', operation: 'bridge-255' }),
    /NONCE_LEDGER_BINDING_DUPLICATE/u)
    assert.equal(consumeCalls, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

test('invalid frozen journal during resume restores ingress fence without replaying SQL or nonce', async () => {
  const f = fixture(); f.state.crashNonceJournal = true
  await assert.rejects(executeBridge255ForwardMigration({ plan: f.plan,
    deploymentNonce: f.nonce, publicKeyPem: f.publicKeyPem,
    control: f.control, runtime: f.runtime, now: f.now }))
  f.state.crashNonceJournal = false
  const priorSql = f.state.sqlCount, priorNonce = f.state.nonceCount
  f.state.fenced = false
  f.state.events.splice(0)
  const readFrozenAttempt = f.control.readFrozenAttempt
  f.control.readFrozenAttempt = async input => {
    f.state.events.push('read-frozen')
    const frozen = await readFrozenAttempt(input)
    return { ...frozen, journal: { ...frozen.journal, signature_base64: 'invalid-signature' } }
  }

  await assert.rejects(resumeBridge255ForwardRecovery({ plan: f.plan,
    publicKeyPem: f.publicKeyPem, control: f.control, runtime: f.runtime, now: f.now }))

  assert.deepEqual(f.state.events, ['lock', 'read-frozen', 'keep-fenced'])
  assert.equal(f.state.sqlCount, priorSql)
  assert.equal(f.state.nonceCount, priorNonce)
  assert.equal(f.state.fenced, true)
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
