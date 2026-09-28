import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openProtectedBridge255StateStore } from '/usr/local/libexec/merchant/ecs-bridge-255-state-store.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const h = value => value.repeat(64)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const trust = '/run/release-security/evidence-trust'
const journalRoot = '/var/lib/merchant-release-security/bridge-255'
const ledgerPath = '/var/lib/merchant-release-security/production-nonces.sqlite3'
const key = generateKeyPairSync('ed25519')
const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const services = ['api', 'api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-sync', 'ops-ui', 'payment-gateway', 'pilot-gateway', 'postgres', 'redis', 'ui'].sort()
const identity = char => ({ release_id: `release-${char}`, git_sha: char.repeat(40), manifest_sha256: h(char), image_set_digest: `sha256:${h(char)}` })
const artifacts = char => ({ identity: identity(char), compose_sha256: h(char), env_sha256: h(char), image_digests_sha256: h(char) })
const nonce = 'nonce_abcdefghijklmnopqrstu'
const plan = { schema_version: 'ecs-bridge-255-plan/1', attempt_id: 'attempt_abcdefghijklmnop', project: 'merchant-demo-85575f9c',
  lock_path: '/var/lib/merchant-release-security/production-deploy.lock', nonce_sha256: sha(nonce),
  old_demo: artifacts('b'), bridge_254_255: artifacts('c'), candidate_255: artifacts('d'), recovery_255: artifacts('e'),
  old_demo_services: services, recovery_255_services: services, candidate_255_services: services,
  database: { strategy: 'forward_only', schema_downgrade: false, preserve_volumes: true,
    prefix_254_sha256: h('1'), prefix_255_sha256: h('2') }, pg17_image_ref: `sha256:${h('f')}` }
const now = new Date(), body = { schema_version: 'ecs-bridge-255-execution-plan/1', key_id: 'isolated-key',
  created_at: new Date(now.getTime() - 1000).toISOString(), expires_at: new Date(now.getTime() + 3_600_000).toISOString(), plan }
const envelope = { ...body, signature_base64: sign(null, Buffer.from(canonical(body)), key.privateKey).toString('base64') }
const writeProtected = (path, value, mode = 0o400) => writeFileSync(path, value, { mode })
const writeDigest = (filename, source) => writeProtected(`${trust}/${filename}`, `${sha(readFileSync(source))}\n`)
const storePath = '/usr/local/libexec/merchant/ecs-bridge-255-state-store.mjs'
const reviewPath = '/usr/local/libexec/merchant/ecs-bridge-255-review.mjs'
const transitionReviewPath = '/usr/local/libexec/merchant/ecs-bridge-255-state.mjs'
const consumerPath = '/usr/local/libexec/merchant/consume-production-evidence-nonce'
const controllerPath = '/usr/local/libexec/merchant/ecs-bridge-255-transition'

writeProtected(`${trust}/production-evidence-public.pem`, publicKeyPem)
writeProtected(`${trust}/production-evidence-key-id`, 'isolated-key\n')
writeProtected(`${trust}/production-bridge-255-execution-plan.json`, `${JSON.stringify(envelope)}\n`)
writeDigest('production-bridge-255-state-store-sha256', storePath)
writeDigest('production-bridge-255-review-sha256', reviewPath)
writeDigest('production-bridge-255-transition-review-sha256', transitionReviewPath)
writeDigest('production-evidence-nonce-consumer-sha256', consumerPath)
writeProtected(`${trust}/production-bridge-255-transition-sha256`, `${sha(readFileSync(controllerPath))}\n`, 0o444)
writeProtected('/var/lib/merchant-release-security/production-capability-private.pem', privateKeyPem, 0o600)

const ledger = new DatabaseSync(ledgerPath)
ledger.exec(`CREATE TABLE consumed_nonces (
  namespace TEXT NOT NULL, nonce TEXT NOT NULL, release_id TEXT NOT NULL, image_digest TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL, release_git_sha TEXT NOT NULL, consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(namespace,nonce));
CREATE TABLE nonce_owners (
  namespace TEXT NOT NULL, nonce TEXT NOT NULL, operation TEXT NOT NULL, attempt_id TEXT NOT NULL,
  PRIMARY KEY(namespace,nonce));`)
ledger.close()
chmodSync(ledgerPath, 0o600)

const store = openProtectedBridge255StateStore()
assert.deepEqual(Object.keys(store).sort(), ['advanceSigned', 'captureSigned', 'consumeNonceOnce',
  'inspectApprovedAttempt', 'readConsumedNonce', 'readFrozenAttempt'])
const ledgerStat = lstatSync(ledgerPath)
await assert.rejects(store.readConsumedNonce({ plan, attemptId: plan.attempt_id, nonce_sha256: plan.nonce_sha256 }), /NONCE_LEDGER_BINDING_MISSING_OR_DUPLICATE/u)
assert.equal(lstatSync(ledgerPath).mtimeMs, ledgerStat.mtimeMs, 'read-only trust/ledger verification must not write to the nonce ledger')
assert.deepEqual((await import('node:fs')).readdirSync(journalRoot), [], 'opening and verifying must not create a journal')

const runController = command => spawnSync(process.execPath, [controllerPath, command], {
  encoding: 'utf8', env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
})
const controllerStatus = runController('status')
assert.equal(controllerStatus.status, 0, controllerStatus.stderr)
assert.deepEqual(JSON.parse(controllerStatus.stdout), {
  schema_version: 'ecs-bridge-255-host-status/1', plan_sha256: sha(canonical(plan)), key_id: 'isolated-key',
  attempt_id: plan.attempt_id, project: plan.project, plan_expires_at: body.expires_at, phase: null,
  journal: null, nonce_consumed: false, nonce_owner: null,
  production_lock: { path: '/var/lib/merchant-release-security/production-deploy.lock', path_verified: true, held_by_invocation: false },
  production_mutation_authorized: false,
  blockers: ['NO_PRODUCTION_HOST_CONTROL_ADAPTER', 'NO_REHEARSED_FORWARD_RECOVERY_PATH'],
  command: 'status', plan_valid: true, controller_mode: 'read_only_preflight',
})
const verifyPlan = runController('verify-plan')
assert.equal(verifyPlan.status, 0, verifyPlan.stderr)
assert.equal(JSON.parse(verifyPlan.stdout).plan_valid, true)
const addNonceRecord = ownerAttempt => {
  const identity = plan.bridge_254_255.identity, db = new DatabaseSync(ledgerPath)
  db.prepare(`INSERT INTO consumed_nonces(namespace,nonce,release_id,image_digest,manifest_sha256,release_git_sha)
    VALUES(?,?,?,?,?,?)`).run('merchant-production-deploy', nonce, identity.release_id,
    identity.image_set_digest, identity.manifest_sha256, identity.git_sha)
  if (ownerAttempt) db.prepare('INSERT INTO nonce_owners(namespace,nonce,operation,attempt_id) VALUES(?,?,?,?)')
    .run('merchant-production-deploy', nonce, 'bridge-255', ownerAttempt)
  db.close(); chmodSync(ledgerPath, 0o600)
}
const removeNonceRecord = () => {
  const db = new DatabaseSync(ledgerPath)
  db.prepare('DELETE FROM nonce_owners WHERE namespace=? AND nonce=?').run('merchant-production-deploy', nonce)
  db.prepare('DELETE FROM consumed_nonces WHERE namespace=? AND nonce=?').run('merchant-production-deploy', nonce)
  db.close(); chmodSync(ledgerPath, 0o600)
}
addNonceRecord(null)
const orphanNonce = runController('status')
assert.notEqual(orphanNonce.status, 0)
assert.match(orphanNonce.stderr, /NONCE_LEDGER_OWNER_MISSING_OR_DIFFERENT_ATTEMPT/u)
removeNonceRecord()
addNonceRecord('attempt_other_abcdefghijkl')
const foreignNonce = runController('status')
assert.notEqual(foreignNonce.status, 0)
assert.match(foreignNonce.stderr, /NONCE_LEDGER_OWNER_MISSING_OR_DIFFERENT_ATTEMPT/u)
removeNonceRecord()
const rejectedExecution = runController('execute')
assert.notEqual(rejectedExecution.status, 0)
assert.equal(readdirSync(journalRoot).length, 0, 'unsupported mutation commands must not create journal state')

chmodSync(journalRoot, 0o755)
assert.throws(() => openProtectedBridge255StateStore(), /STATE_DIRECTORY_UNSAFE/u)
chmodSync(journalRoot, 0o700)
chmodSync(ledgerPath, 0o644)
assert.throws(() => openProtectedBridge255StateStore(), /NONCE_LEDGER_UNSAFE/u)
chmodSync(ledgerPath, 0o600)
const writableLedger = new DatabaseSync(ledgerPath)
writableLedger.exec('ALTER TABLE nonce_owners RENAME TO nonce_owners_saved; CREATE TABLE nonce_owners (namespace TEXT, nonce TEXT, operation TEXT);')
writableLedger.close()
assert.throws(() => openProtectedBridge255StateStore(), /NONCE_LEDGER_SCHEMA_INVALID/u)
const restoreLedger = new DatabaseSync(ledgerPath)
restoreLedger.exec('DROP TABLE nonce_owners; ALTER TABLE nonce_owners_saved RENAME TO nonce_owners;')
restoreLedger.close()
chmodSync(ledgerPath, 0o600)
const weakLedger = new DatabaseSync(ledgerPath)
weakLedger.exec('ALTER TABLE nonce_owners RENAME TO nonce_owners_saved; CREATE TABLE nonce_owners (namespace TEXT, nonce TEXT, operation TEXT, attempt_id TEXT);')
weakLedger.close()
assert.throws(() => openProtectedBridge255StateStore(), /NONCE_LEDGER_SCHEMA_INVALID/u)
const restoreKeyConstraints = new DatabaseSync(ledgerPath)
restoreKeyConstraints.exec('DROP TABLE nonce_owners; ALTER TABLE nonce_owners_saved RENAME TO nonce_owners;')
restoreKeyConstraints.close()
chmodSync(ledgerPath, 0o600)

const storeDigestPath = `${trust}/production-bridge-255-state-store-sha256`
const goodStoreDigest = readFileSync(storeDigestPath)
writeProtected(storeDigestPath, `${h('0')}\n`)
assert.throws(() => openProtectedBridge255StateStore(), /INSTALLED_SOURCE_DIGEST_INVALID/u)
writeProtected(storeDigestPath, goodStoreDigest)

const approvedPlanPath = `${trust}/production-bridge-255-execution-plan.json`
const approvedPlanBackup = `${approvedPlanPath}.saved`
renameSync(approvedPlanPath, approvedPlanBackup)
symlinkSync(approvedPlanBackup, approvedPlanPath)
assert.throws(() => openProtectedBridge255StateStore(), /PATH_NOT_CANONICAL/u)
unlinkSync(approvedPlanPath)
renameSync(approvedPlanBackup, approvedPlanPath)

const keyIdPath = `${trust}/production-evidence-key-id`
const originalKeyId = readFileSync(keyIdPath)
writeProtected(keyIdPath, 'wrong-key\n')
assert.throws(() => openProtectedBridge255StateStore(), /APPROVED_PLAN_ENVELOPE_INVALID/u)
writeProtected(keyIdPath, originalKeyId)

console.log('PASS: protected 255 store opens only with fixed-path signed trust, source digests, protected files and read-only nonce/journal verification')
