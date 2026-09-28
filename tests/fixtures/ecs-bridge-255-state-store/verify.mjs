import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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

writeProtected(`${trust}/production-evidence-public.pem`, publicKeyPem)
writeProtected(`${trust}/production-evidence-key-id`, 'isolated-key\n')
writeProtected(`${trust}/production-bridge-255-execution-plan.json`, `${JSON.stringify(envelope)}\n`)
writeDigest('production-bridge-255-state-store-sha256', storePath)
writeDigest('production-bridge-255-review-sha256', reviewPath)
writeDigest('production-bridge-255-transition-review-sha256', transitionReviewPath)
writeDigest('production-evidence-nonce-consumer-sha256', consumerPath)
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
assert.deepEqual(Object.keys(store).sort(), ['advanceSigned', 'captureSigned', 'consumeNonceOnce', 'readConsumedNonce', 'readFrozenAttempt'])
const ledgerStat = lstatSync(ledgerPath)
assert.equal(lstatSync(ledgerPath).mtimeMs, ledgerStat.mtimeMs, 'read-only trust/ledger verification must not write to the nonce ledger')
assert.deepEqual((await import('node:fs')).readdirSync(journalRoot), [], 'opening and verifying must not create a journal')

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
