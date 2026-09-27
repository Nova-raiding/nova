import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { assertReviewOnlyMutationAllowed, createBridge254StateStore, invocationOwnsFlockRecord } from '../infra/protected/ecs-bridge-254-state-store.mjs'

const temp = mkdtempSync(join(realpathSync(tmpdir()), 'merchant-bridge-254-state-'))
after(() => rmSync(temp, { recursive: true, force: true }))
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const digit = c => c.repeat(64)
const nonce = 'bridge_254_nonce_12345678901234567890'
const attemptId = 'bridge_254_attempt_1234567890'
const identity = (name, git, a, b) => ({ release_id: name, git_sha: git.repeat(40), manifest_sha256: digit(a), image_set_digest: `sha256:${digit(b)}` })
const old_runtime = identity('old-242', 'a', '1', '2')
const bridge = identity('bridge-254', 'b', '3', '4')
const candidate = identity('candidate-c', 'c', '5', '6')
const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [String(242 + i), sha(`prefix-${242 + i}`)]))
const prefix = version => ({ version, history_sha256: prefixes[version] })
const observed = version => ({ ...prefix(version), ops_version: version, ops_history_sha256: prefixes[version] })
const roles = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync', 'external-gateway']
const snapshot = {
  schema_version: 'ecs-bridge-254-capture/1',
  containers: roles.map((role, index) => ({ role, id: sha(`id-${index}`), image_id: `sha256:${sha(`image-${index}`)}`,
    inspect_sha256: sha(`inspect-${index}`), network_sha256: sha(`network-${index}`), running: true })),
  database: { runtime: prefix(242), ops: prefix(242) }, public_release: old_runtime,
  bridge_artifacts: { image_set_digest: bridge.image_set_digest }, old_recovery: { capsule_sha256: digit('7') },
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const expected = { candidate, bridge, old_runtime, deploymentNonce: nonce, recoveryCapsuleSha256: digit('7'),
  trustedKeyId: 'isolated-key', publicKeyPem,
  nonceOwner: { namespace: 'merchant-production-deploy', operation: 'bridge-254', attempt_id: attemptId,
    ...bridge, nonce_sha256: sha(nonce) } }
function body() {
  const now = Date.now()
  return { schema_version: 'ecs-bridge-254-review-journal/2', purpose: 'bridge_242_to_254_protected',
    phase: 'captured', attempt_id: attemptId, key_id: 'isolated-key',
    created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(), compose_project: 'merchant-production',
    candidate, bridge, old_runtime, deployment_nonce_sha256: sha(nonce), recovery_capsule_sha256: digit('7'),
    baseline_inventory_sha256: sha(canonical(snapshot)), allowed_prefix_sha256: prefixes,
    database_prefix: prefix(242), observation_sha256: sha(canonical(snapshot)), nonce_owner: null, deployable: false }
}
function fixture(consume) {
  const dir = join(temp, `journal-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { mode: 0o700 })
  const ledgerPath = join(dir, 'nonce.sqlite3')
  const uid = process.getuid()
  const store = createBridge254StateStore({ directory: dir, ledgerPath, consumerPath: join(dir, 'unused'),
    privateKeyPem, publicKeyPem, trustedKeyId: 'isolated-key', expectedUid: uid, requireProductionLock: false, consume })
  return { store, ledgerPath, dir }
}
function commitNonce(ledgerPath, nonceValue, journal, operation = 'bridge-254') {
  const db = new DatabaseSync(ledgerPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('CREATE TABLE IF NOT EXISTS consumed_nonces (namespace TEXT,nonce TEXT,release_id TEXT,image_digest TEXT,manifest_sha256 TEXT,release_git_sha TEXT,PRIMARY KEY(namespace,nonce))')
    db.exec('CREATE TABLE IF NOT EXISTS nonce_owners (namespace TEXT,nonce TEXT,operation TEXT,attempt_id TEXT,PRIMARY KEY(namespace,nonce))')
    db.prepare('INSERT INTO consumed_nonces VALUES (?,?,?,?,?,?)').run('merchant-production-deploy', nonceValue,
      journal.bridge.release_id, journal.bridge.image_set_digest, journal.bridge.manifest_sha256, journal.bridge.git_sha)
    db.prepare('INSERT INTO nonce_owners VALUES (?,?,?,?)').run('merchant-production-deploy', nonceValue, operation, journal.attempt_id)
    db.exec('COMMIT')
  } finally { db.close(); chmodSync(ledgerPath, 0o600) }
}
const step = (store, fromPhase, toPhase, version, extra = {}) => store.advance({ attemptId, fromPhase, toPhase,
  observedPrefix: observed(version), observationDigest: sha(`observed-${version}-${toPhase}`), expected, deploymentNonce: nonce, ...extra })

test('production bridge-254 signer refuses caller-supplied identity and observation mutation', () => {
  assert.throws(() => assertReviewOnlyMutationAllowed(true), /independent trusted capture and identity verifier/u)
  assert.doesNotThrow(() => assertReviewOnlyMutationAllowed(false), 'isolated review fixtures may exercise journal mechanics')
})

test('FD9 flock proof requires an exclusive lock record owned by this invocation and exact inode', () => {
  const record = '7: FLOCK ADVISORY WRITE 1234 08:01:98765 0 EOF\n'
  assert.equal(invocationOwnsFlockRecord(record, '08:01:98765', [1234, 5678]), true)
  assert.equal(invocationOwnsFlockRecord(record, '08:01:98766', [1234, 5678]), false)
  assert.equal(invocationOwnsFlockRecord(record, '08:01:98765', [5678]), false, 'a different process holding the path is not inherited FD9 ownership')
  assert.equal(invocationOwnsFlockRecord('7: POSIX ADVISORY WRITE 1234 08:01:98765 0 EOF\n', '08:01:98765', [1234]), false)
  assert.equal(invocationOwnsFlockRecord('7: FLOCK ADVISORY READ 1234 08:01:98765 0 EOF\n', '08:01:98765', [1234]), false)
})

test('capture persists signed exact old topology and refuses tampering or duplicate capture', () => {
  const { store, dir } = fixture(() => {})
  store.capture({ attemptId, journalBody: body(), frozenCapture: snapshot, expected })
  assert.equal(store.read({ attemptId, expected }).journal.phase, 'captured')
  assert.throws(() => store.capture({ attemptId, journalBody: body(), frozenCapture: snapshot, expected }), /already exists/)
  assert.throws(() => store.capture({ attemptId: 'other_attempt_123456', journalBody: { ...body(), attempt_id: 'other_attempt_123456' },
    frozenCapture: { ...snapshot, containers: snapshot.containers.slice(1) }, expected }), /capture/)
  const capturePath = join(dir, `${attemptId}.capture.json`)
  chmodSync(capturePath, 0o600)
  writeFileSync(capturePath, `${JSON.stringify({ ...snapshot, public_release: bridge })}\n`)
  chmodSync(capturePath, 0o400)
  assert.throws(() => store.read({ attemptId, expected }), /capture digest differs/)
})

test('nonce commit crash retries only the exact attempt and advances the signed journal', () => {
  let crashes = true
  let calls = 0
  let ledgerPath
  const { store, ledgerPath: path } = fixture((nonceValue, journal) => {
    calls += 1
    commitNonce(ledgerPath, nonceValue, journal)
    if (crashes) throw new Error('simulated crash after SQLite COMMIT')
  })
  ledgerPath = path
  store.capture({ attemptId, journalBody: body(), frozenCapture: snapshot, expected })
  assert.throws(() => step(store, 'captured', 'nonce_consumed', 242), /simulated crash/)
  assert.equal(store.read({ attemptId, expected }).journal.phase, 'captured')
  crashes = false
  const resumed = step(store, 'captured', 'nonce_consumed', 242)
  assert.equal(resumed.journal.phase, 'nonce_consumed')
  assert.equal(calls, 1, 'recovery must observe existing exact ledger binding without re-consuming')
  assert.throws(() => step(store, 'captured', 'nonce_consumed', 242), /phase changed/)
  assert.equal(step(store, 'nonce_consumed', 'bridge_mutation_started', 242).journal.phase, 'bridge_mutation_started')
})

test('a foreign ledger owner cannot promote the captured journal', () => {
  let ledgerPath
  let calls = 0
  const { store, ledgerPath: path } = fixture((nonceValue, journal) => {
    calls += 1
    commitNonce(ledgerPath, nonceValue, journal, 'bridge-b')
  })
  ledgerPath = path
  store.capture({ attemptId, journalBody: body(), frozenCapture: snapshot, expected })
  assert.throws(() => step(store, 'captured', 'nonce_consumed', 242), /different operation/)
  assert.equal(store.read({ attemptId, expected }).journal.phase, 'captured')
  assert.throws(() => step(store, 'captured', 'nonce_consumed', 242), /different operation/)
  assert.equal(calls, 1, 'foreign owner must never trigger a second consume attempt')
})

test('intermediate prefixes persist monotonically, with 242-only old recovery', () => {
  let ledgerPath
  const { store, ledgerPath: path } = fixture((nonceValue, journal) => commitNonce(ledgerPath, nonceValue, journal))
  ledgerPath = path
  store.capture({ attemptId, journalBody: body(), frozenCapture: snapshot, expected })
  for (const [from, to] of [['captured', 'nonce_consumed'], ['nonce_consumed', 'bridge_mutation_started'],
    ['bridge_mutation_started', 'bridge_verified'], ['bridge_verified', 'migration_started']]) step(store, from, to, 242)
  assert.throws(() => step(store, 'migration_started', 'old_recovery_started', 243), /bridge phase refused/)
  step(store, 'migration_started', 'forward_recovery_started', 243)
  assert.throws(() => store.recordPrefix({ attemptId, expectedVersion: 242, observedPrefix: observed(244),
    observationDigest: sha('244'), expected }), /signed prefix changed/)
  const recorded = store.recordPrefix({ attemptId, expectedVersion: 243, observedPrefix: observed(244),
    observationDigest: sha('244'), expected })
  assert.equal(recorded.journal.database_prefix.version, 244)
  assert.equal(recorded.journal.observation_sha256, sha('244'))
  assert.throws(() => store.recordPrefix({ attemptId, expectedVersion: 244, observedPrefix: observed(243),
    observationDigest: sha('backward'), expected }), /must advance/)
  assert.throws(() => store.recordPrefix({ attemptId, expectedVersion: 244, observedPrefix: observed(246),
    observationDigest: sha('skip'), expected }), /must advance/)
  for (let version = 245; version <= 254; version += 1) store.recordPrefix({ attemptId, expectedVersion: version - 1,
    observedPrefix: observed(version), observationDigest: sha(`observed-${version}`), expected })
  assert.equal(step(store, 'forward_recovery_started', 'migration_254_verified', 254).journal.database_prefix.version, 254)
  assert.throws(() => step(store, 'migration_254_verified', 'old_recovery_started', 254), /bridge phase refused/)
})
