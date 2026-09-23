#!/usr/bin/env node
// Protected Bridge B host controller. Install independently reviewed bytes;
// never invoke it from a mutable checkout on a production host.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, chmodSync, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const FIXED_PATH = '/usr/local/libexec/merchant/ecs-bridge-b-transition'
const TRUST_DIR = '/run/release-security/evidence-trust'
const DIGEST_PATH = `${TRUST_DIR}/production-bridge-b-transition-sha256`
const PUBLIC_KEY_PATH = `${TRUST_DIR}/production-evidence-public.pem`
const KEY_ID_PATH = `${TRUST_DIR}/production-evidence-key-id`
const PRIVATE_KEY_PATH = '/var/lib/merchant-release-security/production-capability-private.pem'
const NONCE_LEDGER = '/var/lib/merchant-release-security/production-nonces.sqlite3'
const NONCE_CONSUMER = '/usr/local/libexec/merchant/consume-production-evidence-nonce'
const NONCE_CONSUMER_DIGEST_PATH = `${TRUST_DIR}/production-evidence-nonce-consumer-sha256`
const JOURNAL_ROOT = '/var/lib/merchant-release-security/bridge-b'
const BIN = Object.freeze({ docker: '/usr/bin/docker', psql: '/usr/bin/psql', flock: '/usr/bin/flock', curl: '/usr/bin/curl' })
const HEX = /^[a-f0-9]{64}$/u
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const TRANSITIONS = Object.freeze({
  captured: ['nonce_consumed'],
  nonce_consumed: ['bridge_runtime_mutation_started'],
  bridge_runtime_mutation_started: ['bridge_runtime_verified', 'recovery_started'],
  bridge_runtime_verified: ['recovery_started'],
  recovery_started: ['recovery_verified'],
  recovery_verified: [],
})
export const BRIDGE_B_RUNTIME_SERVICES = Object.freeze([
  'api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish',
  'worker-reconcile', 'worker-automation', 'worker-scan',
])
const BRIDGE_B_RUNTIME_SERVICE_SET = new Set(BRIDGE_B_RUNTIME_SERVICES)
const BRIDGE_B_MIGRATION_CAPABLE_API_SERVICES = new Set(['api', 'api-replica'])

function assert(value, message) { if (!value) throw new Error(message) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function verifyDocument(value, publicPem) {
  try { return verify(null, Buffer.from(canonical(value)), createPublicKey(publicPem), Buffer.from(value.signature_base64, 'base64')) } catch { return false }
}
function signDocument(value, privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519', 'Bridge B trust keys must be Ed25519')
  assert(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'Bridge B private key does not match production trust')
  const signed = { ...value }
  signed.signature_base64 = sign(null, Buffer.from(canonical(signed)), privateKey).toString('base64')
  assert(verifyDocument(signed, publicPem), 'Bridge B journal self-verification failed')
  return signed
}
function validateIdentity(identity, label) {
  assert(identity && /^[A-Za-z0-9._:-]{1,128}$/u.test(identity.releaseId ?? ''), `${label} release id is invalid`)
  assert(GIT.test(identity.gitSha ?? '') && HEX.test(identity.manifestSha256 ?? '') && IMAGE.test(identity.imageSetDigest ?? ''), `${label} identity is invalid`)
}
export function productionApiBaseUrl(value) {
  assert(typeof value === 'string' && value.length <= 2048, 'production API base URL is invalid')
  let url
  try { url = new URL(value) } catch { throw new Error('production API base URL is invalid') }
  assert(url.protocol === 'https:' && url.hostname === 'yxsona.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'production API identity probe must use the canonical https://yxsona.com origin')
  assert(value === 'https://yxsona.com' || value === 'https://yxsona.com/', 'production API origin must be canonical')
  return 'https://yxsona.com'
}
function validateBridgeServiceList(services) {
  assert(Array.isArray(services) && services.length > 0 && services.includes('api') && new Set(services).size === services.length, 'Bridge B service list must be unique, non-empty and include api')
  assert(services.every(name => BRIDGE_B_RUNTIME_SERVICE_SET.has(name)), 'Bridge B service list contains a service outside the fixed runtime allowlist')
  return [...services].sort()
}
function canonicalDigest(value) { return sha256(Buffer.from(canonical(value))) }
function verifyActive(document, publicPem, now) {
  assert(document?.schema_version === 'ecs-bridge-b-transition/2' && verifyDocument(document, publicPem), 'Bridge B journal signature is invalid')
  assert(Date.parse(document.expires_at) > now.getTime(), 'Bridge B journal is expired')
}

export function verifyBridgeBJournal(document, publicPem, now = new Date()) {
  verifyActive(document, publicPem, now)
  return true
}

/**
 * Record the specific Bridge B attempt using a one-use nonce. This receipt is
 * idempotent for the same attempt after a crash, but never reusable by a
 * second attempt or another release identity.
 */
export function recordBridgeBAttemptBinding(ledger, nonce, attemptId, identity) {
  assert(/^[A-Za-z0-9_-]{22,128}$/u.test(nonce ?? '') && /^[A-Za-z0-9_-]{16,128}$/u.test(attemptId ?? ''), 'Bridge B nonce attempt binding is invalid')
  assert(identity && /^[A-Za-z0-9._:-]{1,128}$/u.test(identity.release_id ?? '') && IMAGE.test(identity.image_set_digest ?? '') && HEX.test(identity.manifest_sha256 ?? '') && GIT.test(identity.release_git_sha ?? ''), 'Bridge B nonce release identity is invalid')
  try {
    ledger.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS bridge_b_nonce_attempts (nonce TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL, release_id TEXT NOT NULL, image_digest TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, release_git_sha TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);')
    const existing = ledger.prepare('SELECT attempt_id,release_id,image_digest,manifest_sha256,release_git_sha FROM bridge_b_nonce_attempts WHERE nonce=?').get(nonce)
    if (existing) {
      assert(existing.attempt_id === attemptId && existing.release_id === identity.release_id && existing.image_digest === identity.image_set_digest && existing.manifest_sha256 === identity.manifest_sha256 && existing.release_git_sha === identity.release_git_sha, 'Bridge B nonce was already bound to a different attempt or release')
    } else {
      ledger.prepare('INSERT INTO bridge_b_nonce_attempts(nonce,attempt_id,release_id,image_digest,manifest_sha256,release_git_sha) VALUES(?,?,?,?,?,?)').run(nonce, attemptId, identity.release_id, identity.image_set_digest, identity.manifest_sha256, identity.release_git_sha)
    }
    ledger.exec('COMMIT')
  } catch (error) {
    try { ledger.exec('ROLLBACK') } catch {}
    throw error
  }
  return true
}

/** Create a signed, immutable baseline for B. The only supported DB baseline is 242. */
export function createBridgeBSnapshot(observed, binding, privatePem, publicPem, now = new Date()) {
  validateIdentity(binding?.bridge, 'Bridge B')
  assert(/^[A-Za-z0-9_-]{16,128}$/u.test(binding.attemptId ?? ''), 'Bridge B attempt id is invalid')
  assert(/^[A-Za-z0-9_-]{22,128}$/u.test(binding.deploymentNonce ?? ''), 'Bridge B deployment nonce is invalid')
  assert(typeof binding.keyId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(binding.keyId), 'Bridge B key id is invalid')
  assert(observed.database?.version === 242 && HEX.test(observed.database.historySha256 ?? ''), 'Bridge B requires the exact approved database prefix at 242')
  assert((observed.database.invalidConcurrentIndexes ?? []).length === 0, 'invalid concurrent index blocks Bridge B')
  assert(typeof observed.composeProject === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(observed.composeProject), 'Bridge B Compose project is invalid')
  assert(Array.isArray(observed.containers) && observed.containers.length > 0, 'Bridge B requires a complete baseline workload')
  assert(Array.isArray(observed.inventory) && observed.inventory.length > 0, 'Bridge B requires a complete Docker inventory')
  assert(Array.isArray(observed.bridgeImageIds) && observed.bridgeImageIds.length > 0 && observed.bridgeImageIds.every(id => IMAGE.test(id)), 'Bridge B images must be immutable image IDs')
  assert(observed.bridgeIdentityRunning !== true && observed.bridgeExclusiveContainersRunning !== true, 'Bridge B candidate is already running during capture')
  const services = observed.containers.map(item => {
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(item.service ?? ''), 'baseline service name is invalid')
    assert(BRIDGE_B_RUNTIME_SERVICE_SET.has(item.service), `baseline service is outside the Bridge B runtime allowlist: ${item.service}`)
    assert(/^[a-f0-9]{12,64}$/u.test(item.id ?? '') && IMAGE.test(item.imageId ?? '') && HEX.test(item.configHash ?? '') && item.state === 'running', `baseline container is invalid: ${item.service}`)
    return { service: item.service, id: item.id, image_id: item.imageId, config_hash: item.configHash, state: item.state }
  }).sort((a, b) => a.service.localeCompare(b.service))
  assert(new Set(services.map(item => item.service)).size === services.length, 'baseline service names must be unique')
  const inventory = [...observed.inventory].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  assert(inventory.every(item => /^[a-f0-9]{12,64}$/u.test(item.id ?? '') && IMAGE.test(item.image_id ?? '') && HEX.test(item.config_hash ?? '') && typeof item.name === 'string' && typeof item.compose_service === 'string'), 'Docker inventory is incomplete or malformed')
  const document = {
    schema_version: 'ecs-bridge-b-transition/2', phase: 'captured',
    attempt_id: binding.attemptId, compose_project: observed.composeProject,
    captured_at: now.toISOString(), expires_at: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    bridge: { release_id: binding.bridge.releaseId, release_git_sha: binding.bridge.gitSha, manifest_sha256: binding.bridge.manifestSha256, image_set_digest: binding.bridge.imageSetDigest, exclusive_image_ids: [...new Set(observed.bridgeImageIds)].sort() },
    deployment_nonce_sha256: sha256(binding.deploymentNonce),
    database_before: { migration_version: 242, migration_history_sha256: observed.database.historySha256 },
    baseline: { services, inventory, workload_sha256: canonicalDigest(services), inventory_sha256: canonicalDigest(inventory) },
    service_map: Object.fromEntries(observed.containers.map(item => [item.service, item.containerName])),
    bridge_artifacts: structuredClone(binding.bridgeArtifacts),
    recovery_capsule: structuredClone(binding.recoveryCapsule),
    database_policy: { strategy: 'no_migration', required_version: 242, schema_downgrade: false },
    key_id: binding.keyId,
  }
  assert(Object.values(document.service_map).every(value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value ?? '')), 'baseline container mapping is invalid')
  for (const [label, artifacts] of [['Bridge B', document.bridge_artifacts], ['recovery', document.recovery_capsule]]) {
    assert(artifacts && HEX.test(artifacts.compose_sha256 ?? '') && HEX.test(artifacts.env_sha256 ?? '') && HEX.test(artifacts.image_digests_sha256 ?? ''), `${label} artifact hashes are invalid`)
    assert(Array.isArray(artifacts.services) && artifacts.services.length > 0 && artifacts.services.every(value => /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)), `${label} service list is invalid`)
  }
  validateBridgeServiceList(document.bridge_artifacts.services)
  assert(canonical(document.bridge_artifacts.services) === canonical(services.map(item => item.service)), 'Bridge B and baseline services must match exactly')
  assert(canonical(document.recovery_capsule.services) === canonical(services.map(item => item.service)), 'recovery capsule and baseline services must match exactly')
  return signDocument(document, privatePem, publicPem)
}

/** Accept only the fixed Bridge B phase graph and sign every journal version. */
export function transitionBridgeBJournal(document, nextPhase, privatePem, publicPem, now = new Date()) {
  verifyActive(document, publicPem, now)
  assert(TRANSITIONS[document.phase]?.includes(nextPhase), 'Bridge B journal phase transition is not monotonic')
  return signDocument({ ...document, phase: nextPhase, updated_at: now.toISOString(), signature_base64: undefined }, privatePem, publicPem)
}

/** Read-only, signed preflight that runs before the one-use nonce is consumed. */
export function preflightBridgeBMutation(document, input, publicPem, now = new Date()) {
  verifyActive(document, publicPem, now)
  assert(typeof input.deploymentNonce === 'string' && sha256(input.deploymentNonce) === document.deployment_nonce_sha256, 'Bridge B deployment nonce mismatch')
  assert(input.composeProject === document.compose_project, 'Bridge B Compose project changed')
  assert(input.bridgeIdentity?.releaseId === document.bridge.release_id && input.bridgeIdentity?.gitSha === document.bridge.release_git_sha && input.bridgeIdentity?.manifestSha256 === document.bridge.manifest_sha256 && input.bridgeIdentity?.imageSetDigest === document.bridge.image_set_digest, 'Bridge B release identity mismatch')
  assert(canonicalDigest(input.bridgeImageIds) === canonicalDigest(document.bridge.exclusive_image_ids), 'Bridge B immutable image set changed')
  assert(input.artifacts?.composeSha256 === document.bridge_artifacts.compose_sha256 && input.artifacts?.envSha256 === document.bridge_artifacts.env_sha256 && input.artifacts?.imageDigestsSha256 === document.bridge_artifacts.image_digests_sha256, 'Bridge B fixed Compose inputs changed')
  assert(canonicalDigest(input.artifacts?.services) === canonicalDigest(document.bridge_artifacts.services), 'Bridge B target services changed')
  assert(input.database?.version === 242 && input.database?.historySha256 === document.database_before.migration_history_sha256, 'Bridge B database changed from the captured migration-242 prefix')
  assert((input.database.invalidConcurrentIndexes ?? []).length === 0, 'invalid concurrent index blocks Bridge B')
  assert(input.baseline?.workloadSha256 === document.baseline.workload_sha256 && input.baseline?.inventorySha256 === document.baseline.inventory_sha256, 'baseline workload or Docker inventory changed')
  assert(input.bridgeIdentityRunning !== true, 'Bridge B identity is already running before the controlled mutation')
  return Object.freeze({ authorized: true, operation: 'preflight_only', migrationVersion: 242, migrationCommandAllowed: false })
}

/** Authorization checked after nonce consumption, immediately before B mutation. */
export function authorizeBridgeBMutation(document, input, publicPem, now = new Date()) {
  preflightBridgeBMutation(document, input, publicPem, now)
  assert(document.phase === 'nonce_consumed', 'Bridge B mutation requires the consumed-nonce phase')
  return Object.freeze({ authorized: true, operation: 'compose_up_runtime_only', migrationVersion: 242, migrationCommandAllowed: false })
}

/** Recovery is allowed only to the signed pre-B runtime while the DB is still exactly 242. */
export function authorizeBridgeBRecovery(document, input, publicPem, now = new Date()) {
  verifyActive(document, publicPem, now)
  assert(['bridge_runtime_mutation_started', 'bridge_runtime_verified'].includes(document.phase), 'Bridge B recovery requires a mutation-started phase')
  assert(typeof input.deploymentNonce === 'string' && sha256(input.deploymentNonce) === document.deployment_nonce_sha256, 'Bridge B recovery nonce mismatch')
  assert(input.composeProject === document.compose_project, 'Bridge B recovery Compose project changed')
  assert(input.database?.version === 242 && input.database?.historySha256 === document.database_before.migration_history_sha256, 'Bridge B recovery forbidden after database leaves the captured 242 prefix')
  assert((input.database.invalidConcurrentIndexes ?? []).length === 0, 'invalid concurrent index blocks Bridge B recovery')
  const isCandidateApi = input.currentBridgeIdentity?.releaseId === document.bridge.release_id && input.currentBridgeIdentity?.gitSha === document.bridge.release_git_sha && input.currentBridgeIdentity?.manifestSha256 === document.bridge.manifest_sha256 && input.currentBridgeIdentity?.imageSetDigest === document.bridge.image_set_digest
  if (!isCandidateApi) {
    assert(document.phase === 'bridge_runtime_mutation_started', 'verified Bridge B recovery requires the candidate API identity')
    const old = document.recovery_capsule?.target
    assert(input.currentBridgeIdentity?.releaseId === old?.release_id && input.currentBridgeIdentity?.gitSha === old?.release_git_sha && input.currentBridgeIdentity?.manifestSha256 === old?.manifest_sha256 && input.currentBridgeIdentity?.imageSetDigest === old?.image_set_digest, 'running release is neither the captured Bridge B nor frozen old-runtime identity')
    const baselineApi = document.baseline.services.find(item => item.service === 'api')
    assert(input.currentApiContainer?.id === baselineApi?.id && input.currentApiContainer?.imageId === baselineApi?.image_id && input.currentApiContainer?.configHash === baselineApi?.config_hash, 'old API recovery requires the exact captured baseline container, image and configuration')
  }
  assert(input.baseline?.workloadSha256 === document.baseline.workload_sha256 && input.baseline?.inventorySha256 === document.baseline.inventory_sha256, 'Bridge B recovery inventory is not the captured baseline')
  assert(input.recovery?.composeSha256 && HEX.test(input.recovery.composeSha256) && input.recovery.composeSha256 === document.recovery_capsule.compose_sha256, 'recovery Compose does not match the signed old-runtime capsule')
  assert(input.recovery?.envSha256 && HEX.test(input.recovery.envSha256) && input.recovery.envSha256 === document.recovery_capsule.env_sha256, 'recovery environment does not match the signed old-runtime capsule')
  assert(input.recovery?.imageDigestsSha256 && HEX.test(input.recovery.imageDigestsSha256) && input.recovery.imageDigestsSha256 === document.recovery_capsule.image_digests_sha256, 'recovery image set does not match the signed old-runtime capsule')
  assert(input.recovery?.targetServices && canonicalDigest([...input.recovery.targetServices].sort()) === canonicalDigest(document.recovery_capsule.services), 'recovery services do not match the signed old-runtime capsule')
  return Object.freeze({ authorized: true, operation: 'compose_up_old_runtime_only', migrationVersion: 242, migrationCommandAllowed: false })
}

export const BRIDGE_B_PHASES = Object.freeze(Object.keys(TRANSITIONS))

function protectChain(path, label) {
  let cursor = realpathSync(path)
  assert(cursor === resolve(path), `${label} path must be canonical`)
  while (cursor !== '/') {
    const st = lstatSync(cursor)
    assert(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, `${label} path chain must be root-owned and protected: ${cursor}`)
    cursor = dirname(cursor)
  }
}
function protectedPath(path, label, mode) {
  assert(path, `${label} path is required`)
  protectChain(path, label)
  const st = lstatSync(path)
  assert(!st.isSymbolicLink(), `${label} cannot be a symlink`)
  if (mode !== undefined) assert((st.mode & 0o777) === mode, `${label} has unsafe mode`)
}
function readRegular(path, maximum = 4 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    assert(st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0 && st.size > 0 && st.size <= maximum, `unsafe file: ${path}`)
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function assertRuntime() {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'Bridge B controller must run as root')
  assert(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'Bridge B controller requires a clean Node environment')
  assert(realpathSync(process.argv[1]) === FIXED_PATH, `Bridge B controller must run from ${FIXED_PATH}`)
  protectedPath(FIXED_PATH, 'Bridge B helper', 0o755)
  protectedPath(DIGEST_PATH, 'Bridge B helper digest')
  protectedPath(TRUST_DIR, 'trust directory')
  const expected = readRegular(DIGEST_PATH, 128).toString('utf8').trim()
  assert(HEX.test(expected) && sha256(readRegular(FIXED_PATH)) === expected, 'Bridge B helper self digest mismatch')
  protectedPath(PRIVATE_KEY_PATH, 'capability private key', 0o600)
  protectedPath(PUBLIC_KEY_PATH, 'production public key')
  protectedPath(KEY_ID_PATH, 'production key id')
  protectedPath(NONCE_CONSUMER, 'one-use production nonce consumer', 0o755)
  protectedPath(NONCE_CONSUMER_DIGEST_PATH, 'one-use nonce consumer digest')
  const consumerDigest = readRegular(NONCE_CONSUMER_DIGEST_PATH, 128).toString('utf8').trim()
  assert(HEX.test(consumerDigest) && sha256(readRegular(NONCE_CONSUMER)) === consumerDigest, 'production nonce consumer self digest mismatch')
  protectedPath(NONCE_LEDGER, 'nonce ledger', 0o600)
  protectedPath(JOURNAL_ROOT, 'Bridge B journal directory', 0o700)
}
function parseOptions(args, specification) {
  assert(args.length % 2 === 0, 'every option requires one value')
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    assert(Object.hasOwn(specification, name), `unknown option: ${name}`)
    assert(!Object.hasOwn(result, name), `duplicate option: ${name}`)
    assert(value && !value.startsWith('--'), `missing value for ${name}`)
    result[name] = value
  }
  for (const [name, required] of Object.entries(specification)) if (required) assert(Object.hasOwn(result, name), `${name} is required`)
  return result
}
function writeAtomic(path, value, replace = false, expectedSignature) {
  const parent = realpathSync(dirname(path))
  assert(parent === dirname(path), 'journal parent must be canonical')
  protectedPath(parent, 'journal parent', 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    if (replace) {
      const before = lstatSync(path)
      assert(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.nlink === 1 && (before.mode & 0o777) === 0o400, 'journal was substituted or has unsafe link count/mode')
      const previous = JSON.parse(readRegular(path).toString('utf8'))
      assert(typeof expectedSignature === 'string' && previous.signature_base64 === expectedSignature, 'journal phase changed since it was authorized')
      chmodSync(temporary, 0o400)
      const rechecked = lstatSync(path)
      assert(rechecked.dev === before.dev && rechecked.ino === before.ino && rechecked.nlink === 1 && !rechecked.isSymbolicLink(), 'journal changed during atomic update')
      const previousAgain = JSON.parse(readRegular(path).toString('utf8'))
      assert(previousAgain.signature_base64 === expectedSignature, 'journal was substituted during atomic update')
      renameSync(temporary, path)
    } else {
      chmodSync(temporary, 0o400)
      linkSync(temporary, path)
      unlinkSync(temporary)
    }
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
    const current = lstatSync(path)
    assert(readRegular(path).equals(bytes) && current.uid === 0 && current.nlink === 1 && (current.mode & 0o777) === 0o400, 'atomic journal readback or link-count check failed')
  } catch (error) { try { unlinkSync(temporary) } catch {} throw error }
}
function cleanExec(command, args, env = {}) {
  assert(Object.values(BIN).includes(command), `unapproved executable: ${command}`)
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env })
}
function jsonCommand(command, args, env = {}) { return JSON.parse(cleanExec(command, args, env)) }
function assertInheritedLock(lockPath) {
  protectedPath(lockPath, 'production mutation lock')
  const opened = fstatSync(9), expected = statSync(lockPath)
  assert(opened.isFile() && opened.dev === expected.dev && opened.ino === expected.ino, 'FD 9 does not match the canonical production mutation lock')
  const stdio = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9]
  assert(spawnSync(BIN.flock, ['-n', '9'], { env: {}, stdio }).status === 0, 'production mutation lock is held by another process')
}
function readJournal(path, publicPem) {
  protectedPath(path, 'Bridge B journal', 0o400)
  const journal = JSON.parse(readRegular(path).toString('utf8'))
  verifyBridgeBJournal(journal, publicPem)
  return journal
}
function pgEnv(databaseUrl) {
  const url = new URL(databaseUrl)
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1 && !url.searchParams.has('options'), 'database URL is invalid')
  return { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') || 'prefer' }
}
function collectDatabase(databaseUrl) {
  const env = pgEnv(databaseUrl)
  const sql = "SELECT json_build_object('version',coalesce(max(version),0),'history',coalesce(json_agg(json_build_array(version,name,checksum) ORDER BY version),'[]'::json)) FROM schema_migrations;"
  const result = JSON.parse(cleanExec(BIN.psql, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], env).trim())
  assert(Number.isInteger(Number(result.version)) && Array.isArray(result.history) && result.history.length === Number(result.version) && result.history.every((row, index) => Array.isArray(row) && Number(row[0]) === index + 1 && typeof row[1] === 'string' && HEX.test(row[2] ?? '')), 'database migration history is not a checksummed contiguous prefix')
  const invalidSql = "SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json) FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname IN ('rule_audit_events_workspace_occurred_id_idx','ops_incident_timeline_workspace_created_id_idx','workspace_support_ticket_events_workspace_created_id_idx') AND NOT i.indisvalid;"
  const invalid = JSON.parse(cleanExec(BIN.psql, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', invalidSql], env).trim())
  return { version: Number(result.version), historySha256: canonicalDigest(result.history), invalidConcurrentIndexes: invalid }
}
function configHash(value) {
  return sha256(Buffer.from(canonical({ image: value.Config?.Image, env: [...(value.Config?.Env ?? [])].sort(), entrypoint: value.Config?.Entrypoint ?? null, cmd: value.Config?.Cmd ?? null, mounts: (value.Mounts ?? []).map(({ Destination, Type, RW }) => ({ Destination, Type, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) })))
}
function collectInventory() {
  const ids = cleanExec(BIN.docker, ['ps', '-q', '--no-trunc']).trim().split(/\s+/u).filter(Boolean)
  assert(ids.length > 0, 'complete Docker running-container inventory is required')
  return ids.map(id => {
    const item = jsonCommand(BIN.docker, ['inspect', id])[0]
    assert(item?.Id && /^[a-f0-9]{64}$/u.test(item.Id) && item.Image && item.State?.Running === true, 'Docker inventory contains an unreadable or stopped container')
    return { id: item.Id, name: String(item.Name ?? '').replace(/^\//u, ''), image_id: item.Image, config_hash: configHash(item), project: item.Config?.Labels?.['com.docker.compose.project'] ?? '', compose_service: item.Config?.Labels?.['com.docker.compose.service'] ?? '', env: Object.fromEntries((item.Config?.Env ?? []).map(value => { const index = value.indexOf('='); return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)] })) }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
function collectMappedServices(path, project) {
  const map = JSON.parse(readRegular(path).toString('utf8'))
  assert(Array.isArray(map) && map.length > 0, 'reviewed Bridge B service map is empty')
  const inventory = collectInventory()
  const result = map.map(entry => {
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(entry.service ?? '') && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(entry.container ?? ''), 'reviewed service map is malformed')
    assert(BRIDGE_B_RUNTIME_SERVICE_SET.has(entry.service), `service is outside the fixed Bridge B runtime allowlist: ${entry.service}`)
    const matches = inventory.filter(item => item.name === entry.container)
    assert(matches.length === 1, `service must map to exactly one running container: ${entry.service}`)
    const item = matches[0]
    assert(item.project === project, `baseline container is not part of the expected Compose project: ${entry.service}`)
    assert(item.compose_service === entry.service, `baseline container Compose service label does not match the reviewed service map: ${entry.service}`)
    return { service: entry.service, containerName: item.name, id: item.id, imageId: item.image_id, configHash: item.config_hash, state: 'running' }
  }).sort((a, b) => a.service.localeCompare(b.service))
  assert(new Set(result.map(item => item.service)).size === result.length && new Set(result.map(item => item.containerName)).size === result.length, 'service map has duplicate services or containers')
  assert(result.some(item => item.service === 'api'), 'Bridge B service map must include api')
  return result
}
function composeConfig(compose, envFile, project) {
  const document = jsonCommand(BIN.docker, ['compose', '-p', project, '--env-file', envFile, '-f', compose, 'config', '--format', 'json'])
  assert(document?.services && typeof document.services === 'object', 'rendered Compose services are missing')
  return document
}
function validateRuntimeCompose(compose, envFile, project, imagePath, services, identity) {
  validateBridgeServiceList(services)
  const digests = JSON.parse(readRegular(imagePath).toString('utf8'))
  assert(digests && Object.getPrototypeOf(digests) === Object.prototype && Object.keys(digests).length > 0 && Object.values(digests).every(value => /^sha256:[a-f0-9]{64}$/u.test(value)), 'release image digest map is invalid')
  const document = composeConfig(compose, envFile, project)
  for (const name of services) {
    assert(name !== 'migrate', 'migration service cannot be selected for the runtime-only transition')
    const service = document.services[name]
    assert(service && typeof service.image === 'string' && !service.build, `runtime service is missing or not image-pinned: ${name}`)
    const digest = service.image.split('@').at(-1)
    assert(HEX.test(digest?.replace(/^sha256:/u, '') ?? '') && Object.values(digests).includes(digest), `runtime service image is outside the reviewed digest set: ${name}`)
    const dependencies = Array.isArray(service.depends_on) ? service.depends_on : Object.keys(service.depends_on ?? {})
    assert(!dependencies.includes('migrate'), `runtime service depends on migrate: ${name}`)
  }
  for (const name of services.filter(serviceName => BRIDGE_B_MIGRATION_CAPABLE_API_SERVICES.has(serviceName))) {
    const environment = document.services[name]?.environment ?? {}
    assert(environment.RUN_MIGRATIONS_ON_STARTUP === 'false' || environment.RUN_MIGRATIONS_ON_STARTUP === false, `${name} must explicitly disable startup migrations for the Bridge B migration-242 transition`)
  }
  const api = document.services.api
  const environment = api?.environment ?? {}
  const expected = { RELEASE_ID: identity.release_id, RELEASE_GIT_SHA: identity.release_git_sha, RELEASE_MANIFEST_SHA256: identity.manifest_sha256, RELEASE_IMAGE_SET_DIGEST: identity.image_set_digest }
  assert(services.includes('api') && Object.entries(expected).every(([key, value]) => environment[key] === value), 'API Compose release identity does not match the reviewed runtime')
  return { digests, document }
}
function resolveImageIds(composeDocument, services) {
  return [...new Set(services.map(name => {
    const reference = composeDocument.services[name].image
    const id = cleanExec(BIN.docker, ['image', 'inspect', '--format', '{{.Id}}', reference]).trim()
    assert(IMAGE.test(id), `immutable runtime image is unavailable locally: ${name}`)
    return id
  }))].sort()
}
function productionRelease(baseUrl) {
  const base = productionApiBaseUrl(baseUrl)
  cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${base}/livez`])
  cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${base}/readyz`])
  return jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${base}/releasez`])
}
function assertRelease(response, expected, label) {
  const actual = response?.data?.release ?? response?.release
  assert(actual && actual.release_id === expected.release_id && actual.release_git_sha === expected.release_git_sha && actual.manifest_sha256 === expected.manifest_sha256 && actual.image_set_digest === expected.image_set_digest, `${label} release identity mismatch`)
}
function frozenOldCapsule(planPath, composePath, envPath, digestPath, database) {
  const planBytes = readRegular(planPath), plan = JSON.parse(planBytes.toString('utf8'))
  const created = Date.parse(plan.created_at), expires = Date.parse(plan.expires_at), now = Date.now()
  assert(plan.schema_version === '1' && plan.kind === 'ecs-compose-rollback-capsule', 'frozen old-runtime capsule schema is invalid')
  assert(Number.isFinite(created) && Number.isFinite(expires) && plan.created_at === new Date(created).toISOString() && plan.expires_at === new Date(expires).toISOString() && created <= now + 300_000 && expires > now && expires - created <= 86_400_000, 'frozen old-runtime capsule is expired or outside its validity window')
  assert(plan.database?.strategy === 'forward_only' && plan.database.schema_downgrade === false && plan.volumes?.preserve === true, 'frozen capsule must prohibit schema downgrade and preserve volumes')
  assert(plan.database.live_migration_version === 242 && plan.database.target_migration_tail === 242 && database.version === 242, 'frozen old-runtime capsule must read exactly database migration 242')
  assert(plan.database.allowed_prefix_sha256?.[242] === database.historySha256, 'frozen old-runtime capsule history checksum does not match the live database')
  const target = plan.target
  const targetIdentity = { release_id: target?.release_id, release_git_sha: target?.git_sha, manifest_sha256: target?.manifest_sha256, image_set_digest: target?.image_set_digest }
  assert(targetIdentity.release_id && GIT.test(targetIdentity.release_git_sha ?? '') && HEX.test(targetIdentity.manifest_sha256 ?? '') && IMAGE.test(targetIdentity.image_set_digest ?? ''), 'frozen old-runtime identity is invalid')
  for (const [path, key, label] of [[composePath, 'compose_sha256', 'old-runtime Compose'], [envPath, 'env_sha256', 'old-runtime environment'], [digestPath, 'image_digests_sha256', 'old-runtime image digests']]) {
    const actual = sha256(readRegular(path)), expected = target[key]
    assert(HEX.test(expected ?? '') && actual === expected, `${label} checksum does not match the frozen capsule`)
  }
  validateBridgeServiceList(target.services)
  return { plan, planSha256: sha256(planBytes), targetIdentity, services: [...target.services].sort(), artifactHashes: { compose_sha256: target.compose_sha256, env_sha256: target.env_sha256, image_digests_sha256: target.image_digests_sha256 } }
}
function assertNonceConsumed(nonce, attemptId, identity) {
  assert(nonceLedgerHasBinding(nonce, attemptId, identity), 'one-use deployment nonce ledger binding is not owned by this Bridge B attempt')
}
function nonceLedgerHasBinding(nonce, attemptId, identity) {
  protectedPath(NONCE_LEDGER, 'nonce ledger', 0o600)
  const ledger = new DatabaseSync(NONCE_LEDGER, { readOnly: true })
  try {
    const consumedTable = ledger.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consumed_nonces'").get()
    const ownerTable = ledger.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nonce_owners'").get()
    assert(consumedTable, 'nonce ledger is missing its consumption table')
    const row = ledger.prepare('SELECT release_id,image_digest,manifest_sha256,release_git_sha FROM consumed_nonces WHERE namespace=? AND nonce=?').get('merchant-production-deploy', nonce)
    if (!ownerTable) {
      assert(!row, 'legacy consumed nonce has no operation owner; Bridge B cannot take it over')
      return false
    }
    const owner = ledger.prepare('SELECT operation,attempt_id FROM nonce_owners WHERE namespace=? AND nonce=?').get('merchant-production-deploy', nonce)
    if (!row && !owner) return false
    assert(row && owner, 'nonce ledger consumption and ownership records disagree')
    assert(row.release_id === identity.release_id && row.image_digest === identity.image_set_digest && row.manifest_sha256 === identity.manifest_sha256 && row.release_git_sha === identity.release_git_sha, 'Bridge B nonce is already consumed by another release identity')
    assert(owner.operation === 'bridge-b' && owner.attempt_id === attemptId, 'Bridge B nonce is owned by a different operation or attempt')
    return true
  } finally { ledger.close() }
}
function recordNonceAttempt(nonce, attemptId, identity) {
  protectedPath(NONCE_LEDGER, 'nonce ledger', 0o600)
  const ledger = new DatabaseSync(NONCE_LEDGER)
  try { recordBridgeBAttemptBinding(ledger, nonce, attemptId, identity) } finally { ledger.close() }
}
function consumeNonce(nonce, attemptId, identity) {
  assert(typeof attemptId === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(attemptId), 'Bridge B nonce attempt id is invalid')
  const result = spawnSync(NONCE_CONSUMER, ['consume', '--namespace', 'merchant-production-deploy', '--nonce', nonce, '--release-id', identity.release_id, '--image-digest', identity.image_set_digest, '--manifest-sha256', identity.manifest_sha256, '--release-git-sha', identity.release_git_sha, '--operation', 'bridge-b', '--attempt-id', attemptId], { encoding: 'utf8', env: {} })
  assert(result.status === 0, `shared one-use production nonce consumer rejected the Bridge B nonce: ${(result.stderr ?? '').trim()}`)
  assert(result.stdout.trim() === 'nonce accepted', 'shared production nonce consumer returned an unexpected result')
}
function journalPath(attemptId) { assert(/^[A-Za-z0-9_-]{16,128}$/u.test(attemptId), 'Bridge B attempt id is invalid'); return `${JOURNAL_ROOT}/${attemptId}.json` }
function journalAdvance(path, journal, nextPhase, privatePem, publicPem) { const next = transitionBridgeBJournal(journal, nextPhase, privatePem, publicPem); writeAtomic(path, next, true, journal.signature_base64); return next }
function databaseIs242(database, journal, label) { assert(database.version === 242 && database.historySha256 === journal.database_before.migration_history_sha256 && database.invalidConcurrentIndexes.length === 0, `${label}: database is not the exact valid migration-242 prefix`) }
function baselineInventory(inventory) { return inventory.map(({ id, name, image_id, config_hash, compose_service }) => ({ id, name, image_id, config_hash, compose_service })).sort((a, b) => a.name.localeCompare(b.name)) }
function currentBaseline(serviceMap, project) {
  const map = JSON.parse(readRegular(serviceMap).toString('utf8'))
  assert(Array.isArray(map) && map.length > 0, 'reviewed service map is empty')
  const inventory = collectInventory()
  const services = map.map(entry => {
    const actual = inventory.filter(item => item.name === entry.container)
    assert(actual.length === 1 && actual[0].project === project, `baseline service does not resolve uniquely in the expected project: ${entry.service}`)
    assert(actual[0].compose_service === entry.service, `baseline container Compose service label does not match the reviewed service map: ${entry.service}`)
    return { service: entry.service, containerName: actual[0].name, id: actual[0].id, imageId: actual[0].image_id, configHash: actual[0].config_hash, state: 'running' }
  }).sort((a, b) => a.service.localeCompare(b.service))
  assert(new Set(services.map(item => item.service)).size === services.length && services.some(item => item.service === 'api'), 'service map must uniquely include api')
  return { services, inventory }
}
function currentReleaseEnv(inventory, identity) {
  return inventory.some(item => item.env.RELEASE_ID === identity.release_id || item.env.RELEASE_GIT_SHA === identity.release_git_sha || item.env.RELEASE_MANIFEST_SHA256 === identity.manifest_sha256 || item.env.RELEASE_IMAGE_SET_DIGEST === identity.image_set_digest)
}
function assertUnchangedBeforeInstall(journal, serviceMap, project) {
  const current = currentBaseline(serviceMap, project)
  const workload = current.services.map(item => ({ service: item.service, id: item.id, image_id: item.imageId, config_hash: item.configHash, state: item.state }))
  assert(canonicalDigest(workload) === journal.baseline.workload_sha256, 'baseline workload changed after Bridge B capture')
  assert(canonicalDigest(baselineInventory(current.inventory)) === journal.baseline.inventory_sha256, 'Docker inventory changed after Bridge B capture')
  return current
}
function assertBridgeInventory(journal, candidateImageIds, permitOldDuringRecovery) {
  const current = collectInventory(), baseline = new Map(journal.baseline.inventory.map(item => [item.name, item])), managed = new Set(Object.values(journal.service_map))
  assert(current.length === journal.baseline.inventory.length, 'running Docker inventory cardinality changed')
  for (const item of current) {
    const previous = baseline.get(item.name)
    assert(previous, `unexpected running container blocks Bridge B: ${item.name}`)
    if (!managed.has(item.name)) assert(item.id === previous.id && item.image_id === previous.image_id && item.config_hash === previous.config_hash && item.compose_service === previous.compose_service, `unmanaged container changed during Bridge B: ${item.name}`)
    else {
      const expectedService = Object.entries(journal.service_map).find(([, containerName]) => containerName === item.name)?.[0]
      assert(expectedService && item.compose_service === expectedService, `managed container Compose service label changed: ${item.name}`)
      assert(candidateImageIds.includes(item.image_id) || permitOldDuringRecovery && item.image_id === previous.image_id, `managed service is running an unapproved image: ${item.name}`)
    }
  }
  return current
}
function assertRecoveredInventory(journal) {
  const current = collectInventory(), baseline = new Map(journal.baseline.inventory.map(item => [item.name, item])), managed = new Set(Object.values(journal.service_map))
  assert(current.length === journal.baseline.inventory.length, 'old-runtime inventory cardinality mismatch after recovery')
  for (const item of current) {
    const old = baseline.get(item.name)
    assert(old && item.image_id === old.image_id && item.config_hash === old.config_hash, `old-runtime container configuration was not restored: ${item.name}`)
    if (!managed.has(item.name)) assert(item.id === old.id, `unmanaged container changed during recovery: ${item.name}`)
  }
}
function checkedTimeout(value) { const timeout = value ?? '300'; assert(/^(?:[3-9][0-9]|[1-8][0-9]{2}|900)$/u.test(timeout), 'wait timeout must be between 30 and 900 seconds'); return timeout }
function composeUp(compose, envFile, project, timeout, services) {
  assert(services.length > 0 && services.every(value => /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value) && value !== 'migrate'), 'runtime service list contains a forbidden migration or invalid service')
  const result = spawnSync(BIN.docker, ['compose', '-p', project, '--env-file', envFile, '-f', compose, 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', timeout, ...services], { stdio: 'inherit', env: {} })
  assert(result.status === 0, 'runtime-only Compose up failed; database and persistent data were preserved')
}
function capture(get, privatePem, publicPem) {
  const attemptId = get('--attempt-id'), path = journalPath(attemptId), project = get('--compose-project'), baseUrl = productionApiBaseUrl(get('--production-api-base-url'))
  assert(get('--state') === path, 'state path must be derived from the attempt id under the protected journal root')
  const database = collectDatabase(process.env.DATABASE_URL)
  assert(database.version === 242 && database.invalidConcurrentIndexes.length === 0, 'Bridge B capture requires the exact valid database migration-242 prefix')
  const old = frozenOldCapsule(get('--recovery-plan'), get('--recovery-compose'), get('--recovery-env'), get('--recovery-image-digests'), database)
  assertRelease(productionRelease(baseUrl), old.targetIdentity, 'live old runtime before Bridge B')
  const { services, inventory } = currentBaseline(get('--service-map'), project)
  assert(canonical(services.map(item => item.service)) === canonical(old.services), 'service map differs from frozen old-runtime capsule')
  const candidate = { release_id: get('--bridge-release-id'), release_git_sha: get('--bridge-git-sha'), manifest_sha256: get('--bridge-manifest-sha256'), image_set_digest: get('--bridge-image-set-digest') }
  assert(GIT.test(candidate.release_git_sha) && HEX.test(candidate.manifest_sha256) && IMAGE.test(candidate.image_set_digest) && /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.release_id), 'Bridge B release identity is invalid')
  const bridgeCompose = get('--bridge-compose'), bridgeEnv = get('--bridge-env'), bridgeDigestsPath = get('--bridge-image-digests')
  const bridgeArtifacts = { compose_sha256: sha256(readRegular(bridgeCompose)), env_sha256: sha256(readRegular(bridgeEnv)), image_digests_sha256: sha256(readRegular(bridgeDigestsPath)), services: services.map(item => item.service) }
  const bridgeConfig = validateRuntimeCompose(bridgeCompose, bridgeEnv, project, bridgeDigestsPath, bridgeArtifacts.services, candidate)
  const bridgeImageIds = resolveImageIds(bridgeConfig.document, bridgeArtifacts.services)
  assert(!inventory.some(item => bridgeImageIds.includes(item.image_id) || currentReleaseEnv([item], candidate)), 'Bridge B image or release identity is already running')
  const oldMap = JSON.parse(readRegular(get('--service-map')).toString('utf8'))
  const recoveryCapsule = { plan_sha256: old.planSha256, compose_sha256: old.artifactHashes.compose_sha256, env_sha256: old.artifactHashes.env_sha256, image_digests_sha256: old.artifactHashes.image_digests_sha256, services: old.services, target: old.targetIdentity }
  const journal = createBridgeBSnapshot({ composeProject: project, containers: services, inventory: baselineInventory(inventory), bridgeImageIds, bridgeIdentityRunning: false, bridgeExclusiveContainersRunning: false, database }, { attemptId, deploymentNonce: get('--deployment-nonce'), keyId: readRegular(KEY_ID_PATH, 128).toString('utf8').trim(), bridge: { releaseId: candidate.release_id, gitSha: candidate.release_git_sha, manifestSha256: candidate.manifest_sha256, imageSetDigest: candidate.image_set_digest }, bridgeArtifacts, recoveryCapsule }, privatePem, publicPem)
  journal.service_map = Object.fromEntries(oldMap.map(item => [item.service, item.container]))
  const signed = signDocument(Object.fromEntries(Object.entries(journal).filter(([key]) => key !== 'signature_base64')), privatePem, publicPem)
  writeAtomic(path, signed, false)
  process.stdout.write('Bridge B signed baseline captured at migration 242\n')
}
function install(get, privatePem, publicPem) {
  const path = get('--state'), journal = readJournal(path, publicPem), project = get('--compose-project')
  assert(path === journalPath(journal.attempt_id), 'Bridge B journal path does not match signed attempt')
  assert(['captured', 'nonce_consumed'].includes(journal.phase), 'Bridge B install can run only once from captured or safely resumed nonce-consumed state')
  assert(project === journal.compose_project, 'Compose project differs from the signed Bridge B journal')
  const baseUrl = productionApiBaseUrl(get('--production-api-base-url'))
  const nonce = get('--deployment-nonce')
  assert(sha256(nonce) === journal.deployment_nonce_sha256, 'Bridge B deployment nonce mismatch')
  const compose = get('--bridge-compose'), envFile = get('--bridge-env'), digestsPath = get('--bridge-image-digests')
  assert(sha256(readRegular(compose)) === journal.bridge_artifacts.compose_sha256 && sha256(readRegular(envFile)) === journal.bridge_artifacts.env_sha256 && sha256(readRegular(digestsPath)) === journal.bridge_artifacts.image_digests_sha256, 'Bridge B Compose inputs changed after signed capture')
  assertUnchangedBeforeInstall(journal, get('--service-map'), project)
  const before = collectDatabase(process.env.DATABASE_URL)
  databaseIs242(before, journal, 'pre-mutation check')
  const candidate = { release_id: journal.bridge.release_id, release_git_sha: journal.bridge.release_git_sha, manifest_sha256: journal.bridge.manifest_sha256, image_set_digest: journal.bridge.image_set_digest }
  const config = validateRuntimeCompose(compose, envFile, project, digestsPath, journal.bridge_artifacts.services, candidate)
  const imageIds = resolveImageIds(config.document, journal.bridge_artifacts.services)
  const mutationInput = database => ({ deploymentNonce: nonce, composeProject: project, bridgeIdentity: { releaseId: candidate.release_id, gitSha: candidate.release_git_sha, manifestSha256: candidate.manifest_sha256, imageSetDigest: candidate.image_set_digest }, bridgeImageIds: imageIds, artifacts: { composeSha256: journal.bridge_artifacts.compose_sha256, envSha256: journal.bridge_artifacts.env_sha256, imageDigestsSha256: journal.bridge_artifacts.image_digests_sha256, services: journal.bridge_artifacts.services }, database, baseline: { workloadSha256: journal.baseline.workload_sha256, inventorySha256: journal.baseline.inventory_sha256 }, bridgeIdentityRunning: currentReleaseEnv(collectInventory(), candidate) })
  preflightBridgeBMutation(journal, mutationInput(before), publicPem)
  const old = frozenOldCapsule(get('--recovery-plan'), get('--recovery-compose'), get('--recovery-env'), get('--recovery-image-digests'), before)
  assert(old.planSha256 === journal.recovery_capsule.plan_sha256 && canonical(old.targetIdentity) === canonical(journal.recovery_capsule.target), 'signed old-runtime capsule changed')
  assertRelease(productionRelease(baseUrl), old.targetIdentity, 'live old runtime immediately before Bridge B')
  let current = journal
  if (current.phase === 'captured') {
    if (!nonceLedgerHasBinding(nonce, current.attempt_id, candidate)) consumeNonce(nonce, current.attempt_id, candidate)
    assertNonceConsumed(nonce, current.attempt_id, candidate)
    recordNonceAttempt(nonce, current.attempt_id, candidate)
    current = journalAdvance(path, current, 'nonce_consumed', privatePem, publicPem)
  } else {
    assertNonceConsumed(nonce, current.attempt_id, candidate)
    recordNonceAttempt(nonce, current.attempt_id, candidate)
  }
  // Recheck all mutable deployment observations after durable nonce binding,
  // then authorize against the latest signed nonce_consumed journal. This
  // also lets an exact same-attempt retry resume after a process loss between
  // the external nonce ledger commit and the journal phase replacement.
  assertUnchangedBeforeInstall(current, get('--service-map'), project)
  const beforeMutation = collectDatabase(process.env.DATABASE_URL)
  databaseIs242(beforeMutation, current, 'final pre-mutation check')
  authorizeBridgeBMutation(current, mutationInput(beforeMutation), publicPem)
  current = journalAdvance(path, current, 'bridge_runtime_mutation_started', privatePem, publicPem)
  composeUp(compose, envFile, project, checkedTimeout(get('--wait-timeout')), current.bridge_artifacts.services)
  const after = collectDatabase(process.env.DATABASE_URL)
  databaseIs242(after, current, 'post-mutation check')
  assertBridgeInventory(current, imageIds, false)
  assertRelease(productionRelease(baseUrl), candidate, 'Bridge B live runtime')
  journalAdvance(path, current, 'bridge_runtime_verified', privatePem, publicPem)
  process.stdout.write('Bridge B runtime verified; database remains at migration 242\n')
}
function recover(get, privatePem, publicPem) {
  const path = get('--state'), journal = readJournal(path, publicPem), project = get('--compose-project')
  assert(path === journalPath(journal.attempt_id), 'Bridge B journal path does not match signed attempt')
  assert(['bridge_runtime_mutation_started', 'bridge_runtime_verified'].includes(journal.phase), 'recovery requires a started Bridge B runtime')
  assert(project === journal.compose_project && sha256(get('--deployment-nonce')) === journal.deployment_nonce_sha256, 'recovery binding does not match signed journal')
  const before = collectDatabase(process.env.DATABASE_URL)
  databaseIs242(before, journal, 'recovery guard')
  const recoveryIdentity = { release_id: journal.bridge.release_id, image_set_digest: journal.bridge.image_set_digest, manifest_sha256: journal.bridge.manifest_sha256, release_git_sha: journal.bridge.release_git_sha }
  assertNonceConsumed(get('--deployment-nonce'), journal.attempt_id, recoveryIdentity)
  recordNonceAttempt(get('--deployment-nonce'), journal.attempt_id, recoveryIdentity)
  const actual = collectInventory(), candidateIds = journal.bridge.exclusive_image_ids, oldByName = new Map(journal.baseline.inventory.map(item => [item.name, item])), managed = new Set(Object.values(journal.service_map))
  assert(actual.length === journal.baseline.inventory.length, 'runtime inventory changed; recovery requires manual review')
  for (const item of actual) {
    const old = oldByName.get(item.name)
    assert(old, `unexpected running container blocks recovery: ${item.name}`)
    if (managed.has(item.name)) {
      const expectedService = Object.entries(journal.service_map).find(([, containerName]) => containerName === item.name)?.[0]
      assert(expectedService && item.compose_service === expectedService, `managed container Compose service label changed; recovery blocked: ${item.name}`)
      assert(candidateIds.includes(item.image_id) || item.image_id === old.image_id, `unrecognized managed runtime blocks recovery: ${item.name}`)
    } else assert(item.id === old.id && item.image_id === old.image_id && item.config_hash === old.config_hash && item.compose_service === old.compose_service, `unmanaged runtime changed; recovery blocked: ${item.name}`)
  }
  const old = frozenOldCapsule(get('--recovery-plan'), get('--recovery-compose'), get('--recovery-env'), get('--recovery-image-digests'), before)
  assert(old.planSha256 === journal.recovery_capsule.plan_sha256 && canonical(old.targetIdentity) === canonical(journal.recovery_capsule.target) && canonical(old.services) === canonical(journal.recovery_capsule.services), 'signed frozen old-runtime capsule changed')
  const config = validateRuntimeCompose(get('--recovery-compose'), get('--recovery-env'), project, get('--recovery-image-digests'), old.services, old.targetIdentity)
  const imageIds = resolveImageIds(config.document, old.services)
  assert(old.services.every(name => journal.baseline.services.some(item => item.service === name)), 'frozen recovery services differ from captured old runtime')
  const currentApi = actual.find(item => item.name === journal.service_map.api)
  assert(currentApi, 'Bridge B API container is missing during recovery authorization')
  const currentBridgeIdentity = {
    releaseId: currentApi.env.RELEASE_ID,
    gitSha: currentApi.env.RELEASE_GIT_SHA,
    manifestSha256: currentApi.env.RELEASE_MANIFEST_SHA256,
    imageSetDigest: currentApi.env.RELEASE_IMAGE_SET_DIGEST,
  }
  authorizeBridgeBRecovery(journal, {
    deploymentNonce: get('--deployment-nonce'),
    composeProject: project,
    database: before,
    currentBridgeIdentity,
    currentApiContainer: { id: currentApi.id, imageId: currentApi.image_id, configHash: currentApi.config_hash },
    baseline: { workloadSha256: journal.baseline.workload_sha256, inventorySha256: journal.baseline.inventory_sha256 },
    recovery: {
      composeSha256: old.artifactHashes.compose_sha256,
      envSha256: old.artifactHashes.env_sha256,
      imageDigestsSha256: old.artifactHashes.image_digests_sha256,
      targetServices: old.services,
    },
  }, publicPem)
  let current = journalAdvance(path, journal, 'recovery_started', privatePem, publicPem)
  composeUp(get('--recovery-compose'), get('--recovery-env'), project, checkedTimeout(get('--wait-timeout')), old.services)
  const after = collectDatabase(process.env.DATABASE_URL)
  databaseIs242(after, current, 'post-recovery check')
  const finalInventory = collectInventory()
  for (const item of finalInventory) {
    const previous = oldByName.get(item.name)
    assert(previous && item.image_id === previous.image_id && item.config_hash === previous.config_hash && item.compose_service === previous.compose_service, `recovered runtime differs from captured old image/configuration: ${item.name}`)
    if (!managed.has(item.name)) assert(item.id === previous.id, `unmanaged runtime changed during recovery: ${item.name}`)
  }
  assertRelease(productionRelease(get('--production-api-base-url')), old.targetIdentity, 'restored old runtime')
  current = journalAdvance(path, current, 'recovery_verified', privatePem, publicPem)
  process.stdout.write('Bridge B recovery verified at migration 242\n')
}
const COMMON = { '--state': true, '--lock-path': true, '--compose-project': true, '--production-api-base-url': true }
const CLI = Object.freeze({
  capture: { ...COMMON, '--attempt-id': true, '--deployment-nonce': true, '--service-map': true, '--bridge-release-id': true, '--bridge-git-sha': true, '--bridge-manifest-sha256': true, '--bridge-image-set-digest': true, '--bridge-compose': true, '--bridge-env': true, '--bridge-image-digests': true, '--recovery-plan': true, '--recovery-compose': true, '--recovery-env': true, '--recovery-image-digests': true },
  install: { ...COMMON, '--deployment-nonce': true, '--service-map': true, '--bridge-compose': true, '--bridge-env': true, '--bridge-image-digests': true, '--recovery-plan': true, '--recovery-compose': true, '--recovery-env': true, '--recovery-image-digests': true, '--wait-timeout': false },
  recover: { ...COMMON, '--deployment-nonce': true, '--recovery-plan': true, '--recovery-compose': true, '--recovery-env': true, '--recovery-image-digests': true, '--wait-timeout': false },
})
function main(args) {
  assertRuntime()
  const command = args[0]
  assert(Object.hasOwn(CLI, command), 'expected capture, install, or recover')
  const options = parseOptions(args.slice(1), CLI[command]), get = name => options[name]
  assertInheritedLock(get('--lock-path'))
  const privatePem = readRegular(PRIVATE_KEY_PATH, 8192).toString('utf8'), publicPem = readRegular(PUBLIC_KEY_PATH, 8192).toString('utf8')
  if (command === 'capture') return capture(get, privatePem, publicPem)
  if (command === 'install') return install(get, privatePem, publicPem)
  return recover(get, privatePem, publicPem)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`Bridge B transition rejected: ${error.message}\n`); process.exitCode = 1 }
}
