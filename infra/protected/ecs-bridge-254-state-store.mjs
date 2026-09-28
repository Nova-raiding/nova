#!/usr/bin/env node
// Protected 242→254 journal/nonce component. The caller owns Docker, ingress,
// job drain and database observations. This component never runs migrations.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { reviewBridge254NextPhase, reviewBridge254SignedJournal } from './ecs-bridge-254-review-state.mjs'

const SHA = /^[a-f0-9]{64}$/u
const ATTEMPT = /^[A-Za-z0-9_-]{16,128}$/u
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const ROOT = '/var/lib/merchant-release-security/bridge-254'
const LEDGER = '/var/lib/merchant-release-security/production-nonces.sqlite3'
const CONSUMER = '/usr/local/libexec/merchant/consume-production-evidence-nonce'
const LOCK = '/var/lib/merchant-release-security/production-deploy.lock'
const INSTALLED = '/usr/local/libexec/merchant/ecs-bridge-254-state-store.mjs'
const REVIEW_INSTALLED = '/usr/local/libexec/merchant/ecs-bridge-254-review-state.mjs'
const TRUST = '/run/release-security/evidence-trust'
const PRIVATE_KEY = '/var/lib/merchant-release-security/production-capability-private.pem'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const assert = (condition, message) => { if (!condition) throw new Error(message) }

function protectedFile(path, mode, uid) {
  assert(resolve(path) === path && realpathSync(path) === path, 'protected path must be canonical and non-symlink')
  const st = lstatSync(path)
  assert(st.uid === uid && (mode === 0o700 || st.nlink === 1) && (st.mode & 0o777) === mode
    && (mode === 0o700 ? st.isDirectory() : st.isFile()), 'protected path ownership, mode, or type is invalid')
  return st
}
function protectedChain(path) {
  let cursor = dirname(path)
  while (true) {
    const st = lstatSync(cursor)
    assert(realpathSync(cursor) === cursor && st.isDirectory() && st.uid === 0 && (st.mode & 0o022) === 0,
      'protected ancestor is writable, non-root, or a symlink')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
}
function readTrust(path, maxBytes = 4096) {
  protectedChain(path)
  const st = lstatSync(path)
  assert(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1
    && (st.mode & 0o022) === 0 && st.size > 0 && st.size <= maxBytes,
  'protected trust input has unsafe owner, mode, type, or size')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    assert(opened.dev === st.dev && opened.ino === st.ino, 'protected trust input changed while opening')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function readProtected(path, mode, uid) {
  protectedFile(path, mode, uid)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd), old = lstatSync(path)
    assert(st.dev === old.dev && st.ino === old.ino && st.nlink === 1, 'protected file changed while opening')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function atomic(path, bytes, uid, previousBytes = null) {
  const parent = dirname(path)
  protectedFile(parent, 0o700, uid)
  const temp = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    chmodSync(temp, 0o400)
    if (previousBytes === null) {
      linkSync(temp, path)
      unlinkSync(temp)
    } else {
      const before = readProtected(path, 0o400, uid)
      assert(before.equals(previousBytes), 'signed journal changed since CAS read')
      const st = lstatSync(path)
      assert(readProtected(path, 0o400, uid).equals(previousBytes), 'signed journal changed before replacement')
      const again = lstatSync(path)
      assert(st.dev === again.dev && st.ino === again.ino, 'signed journal inode changed during CAS')
      renameSync(temp, path)
    }
    const dirFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    assert(readProtected(path, 0o400, uid).equals(bytes), 'signed journal durable readback mismatch')
  } finally { try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}
function nonceBinding(ledgerPath, nonce, journal, uid) {
  protectedFile(ledgerPath, 0o600, uid)
  const db = new DatabaseSync(ledgerPath, { readOnly: true })
  try {
    const rows = db.prepare('SELECT c.release_id,c.image_digest,c.manifest_sha256,c.release_git_sha,o.operation,o.attempt_id FROM consumed_nonces c JOIN nonce_owners o USING(namespace,nonce) WHERE c.namespace=? AND c.nonce=?')
      .all('merchant-production-deploy', nonce)
    assert(rows.length === 1, 'nonce ledger lacks one exact consumption and owner pair')
    const row = rows[0]
    assert(row.release_id === journal.bridge.release_id && row.image_digest === journal.bridge.image_set_digest
      && row.manifest_sha256 === journal.bridge.manifest_sha256 && row.release_git_sha === journal.bridge.git_sha
      && row.operation === 'bridge-254' && row.attempt_id === journal.attempt_id,
    'nonce belongs to a different operation, attempt, or release')
    return row
  } finally { db.close() }
}
function signed(body, privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })),
  'journal signing key does not match the trusted Ed25519 public key')
  return { ...body, signature_base64: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64') }
}
function expectedPlan(expected) {
  assert(expected?.project === 'merchant-production' && expected?.prefixes
    && Object.keys(expected.prefixes).sort().join('\0') === Array.from({ length: 13 }, (_, index) => String(index + 242)).sort().join('\0')
    && Object.values(expected.prefixes).every(value => SHA.test(value)),
  'independently frozen project and complete 242–254 prefix chain are required')
  if (expected.oldRuntime) assert(canonical(expected.oldRuntime) === canonical(expected.old_runtime),
    'maintenance and signed-state old identities differ')
}
function capturedSnapshot(snapshot, expected) {
  expectedPlan(expected)
  assert(snapshot && snapshot.schema_version === 'ecs-bridge-254-capture/1' && Array.isArray(snapshot.containers)
    && snapshot.containers.length === 8 && snapshot.database?.runtime?.version === 242
    && snapshot.database?.ops?.version === 242 && SHA.test(snapshot.database.runtime.history_sha256 ?? '')
    && snapshot.database.runtime.history_sha256 === snapshot.database.ops.history_sha256,
  'frozen capture must contain eight legacy containers and matching runtime/ops 242 histories')
  const roles = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync', 'external-gateway']
  assert(snapshot.containers.map(item => item.role).sort().join('\0') === roles.sort().join('\0'), 'frozen legacy role set is invalid')
  assert(new Set(snapshot.containers.map(item => item.id)).size === 8
    && snapshot.containers.every(item => SHA.test(item.id ?? '') && /^sha256:[a-f0-9]{64}$/u.test(item.image_id ?? '')
      && SHA.test(item.inspect_sha256 ?? '') && SHA.test(item.network_sha256 ?? '') && item.running === true),
  'frozen legacy container identities or full inspect/network hashes are invalid')
  assert(snapshot.database.runtime.history_sha256 === expected.prefixes['242'], 'frozen capture database differs from approved 242 prefix')
  assert(canonical(snapshot.public_release) === canonical(expected.old_runtime),
    'frozen public release differs from independently approved old identity')
  const artifacts = snapshot.bridge_artifacts, recovery = snapshot.old_recovery
  assert(artifacts && ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'].every(key => artifacts[key] === expected.bridge?.[key])
    && Array.isArray(artifacts.services) && artifacts.services.length === 8
    && ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
      .every(service => artifacts.services.includes(service))
    && SHA.test(artifacts.compose_sha256 ?? '') && SHA.test(artifacts.env_sha256 ?? '') && SHA.test(artifacts.image_digests_sha256 ?? '')
    && recovery?.preserve_volumes === true && SHA.test(recovery.compose_sha256 ?? '')
    && SHA.test(recovery.env_sha256 ?? '') && SHA.test(recovery.image_digests_sha256 ?? ''),
  'frozen bridge and recovery bytes are not bound to the independent plan')
  return sha(canonical(snapshot))
}
function observedPair(value) {
  assert(value && Number.isSafeInteger(value.version) && value.version >= 242 && value.version <= 254
    && SHA.test(value.history_sha256 ?? '') && value.ops_version === value.version
    && value.ops_history_sha256 === value.history_sha256,
  'runtime and ops database observations must agree on an exact prefix')
  return { version: value.version, history_sha256: value.history_sha256 }
}

export function invocationOwnsFlockRecord(procLocks, deviceInode, ownerPids) {
  if (typeof procLocks !== 'string' || typeof deviceInode !== 'string' || !Array.isArray(ownerPids)) return false
  const allowed = new Set(ownerPids.filter(Number.isSafeInteger))
  return procLocks.split('\n').some(line => {
    const match = /^\s*\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+:[0-9a-f]+:\d+)\s+/u.exec(line)
    return match && allowed.has(Number(match[1])) && match[2] === deviceInode
  })
}

export function linuxDeviceInode(stat) {
  const device = BigInt(stat.dev)
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n)
  return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${stat.ino}`
}

export function assertReviewOnlyMutationAllowed(requireProductionLock) {
  assert(!requireProductionLock,
    'production bridge-254 signing and nonce mutation are disabled until an independent trusted capture and identity verifier is installed')
}

export function createBridge254StateStore({ directory, ledgerPath, consumerPath, privateKeyPem, publicKeyPem,
  trustedKeyId, expectedUid = 0, requireProductionLock = true, consume = null }) {
  assert(typeof privateKeyPem === 'string' && typeof publicKeyPem === 'string', 'protected Ed25519 keys are required')
  assert(typeof trustedKeyId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trustedKeyId), 'protected key ID is required')
  assert(typeof directory === 'string' && typeof ledgerPath === 'string' && typeof consumerPath === 'string', 'protected paths are required')
  // Production construction has no override for the fixed protected locations.
  if (requireProductionLock) {
    assert(process.getuid?.() === 0 && process.geteuid?.() === 0 && expectedUid === 0,
      'production journal store requires root')
    assert(directory === ROOT && ledgerPath === LEDGER && consumerPath === CONSUMER, 'production journal paths are fixed')
    assert(consume === null, 'injected nonce consumer is forbidden in production')
  } else {
    const isolatedPrefix = `${realpathSync(tmpdir())}/merchant-bridge-254-state-`
    assert(directory.startsWith(isolatedPrefix) && ledgerPath.startsWith(`${directory}/`),
      'unprotected journal store may use only an isolated temporary directory')
  }
  const guard = () => {
    protectedFile(directory, 0o700, expectedUid)
    if (requireProductionLock) {
      protectedChain(directory)
      protectedChain(ledgerPath)
      protectedChain(consumerPath)
      const lockStat = lstatSync(LOCK)
      assert(lockStat.isFile() && !lockStat.isSymbolicLink() && lockStat.uid === 0
        && (lockStat.mode & 0o022) === 0, 'production deployment lock is unsafe')
      const fd = fstatSync(9), st = statSync(LOCK)
      assert(fd.dev === st.dev && fd.ino === st.ino, 'FD 9 is not the production deployment lock')
      const deviceInode = linuxDeviceInode(st)
      const probeFd = openSync(LOCK, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const probe = fstatSync(probeFd)
        assert(probe.dev === st.dev && probe.ino === st.ino, 'production lock changed while opening independent probe')
        const contention = spawnSync('/usr/bin/flock', ['-n', '10', '/bin/true'], {
          env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', probeFd],
        })
        assert(contention.status === 1, 'FD 9 does not hold the production deployment lock')
      } finally { closeSync(probeFd) }
      const procLocks = readFileSync('/proc/locks', 'utf8')
      assert(invocationOwnsFlockRecord(procLocks, deviceInode, [process.pid, process.ppid]),
        'FD 9 lock is not owned by the deploy invocation')
    }
  }
  const paths = attemptId => {
    assert(ATTEMPT.test(attemptId ?? ''), 'attempt ID is invalid')
    return { journal: join(directory, `${attemptId}.json`), capture: join(directory, `${attemptId}.capture.json`) }
  }
  const trustExpected = expected => assert(expected?.publicKeyPem === publicKeyPem && expected?.trustedKeyId === trustedKeyId,
    'independent expectation does not match protected journal trust anchor')
  const read = ({ attemptId, expected }) => {
    guard()
    trustExpected(expected)
    expectedPlan(expected)
    const path = paths(attemptId), bytes = readProtected(path.journal, 0o400, expectedUid)
    const journal = JSON.parse(bytes.toString('utf8'))
    assert(journal.attempt_id === attemptId, 'signed journal attempt differs from protected path')
    assert(journal.schema_version === 'ecs-bridge-254-review-journal/2', 'protected state requires journal v2')
    const result = reviewBridge254SignedJournal(journal, expected)
    assert(result.structure_consistent, `signed journal rejected: ${result.errors.join('; ')}`)
    assert(canonical(journal.allowed_prefix_sha256) === canonical(expected.prefixes),
      'signed prefix chain differs from independent expectation')
    const snapshot = JSON.parse(readProtected(path.capture, 0o400, expectedUid).toString('utf8'))
    assert(capturedSnapshot(snapshot, expected) === journal.baseline_inventory_sha256, 'frozen capture digest differs from signed journal')
    if (journal.phase !== 'captured') {
      assert(NONCE.test(expected?.deploymentNonce ?? ''), 'deployment nonce is missing')
      nonceBinding(ledgerPath, expected.deploymentNonce, journal, expectedUid)
    }
    return { journal, capture: snapshot, bytes }
  }
  const capture = ({ attemptId, journalBody, frozenCapture, expected }) => {
    assertReviewOnlyMutationAllowed(requireProductionLock)
    guard()
    trustExpected(expected)
    expectedPlan(expected)
    const path = paths(attemptId)
    assert(journalBody.phase === 'captured' && journalBody.attempt_id === attemptId && journalBody.nonce_owner === null,
      'capture requires a fresh unconsumed attempt')
    assert(journalBody.schema_version === 'ecs-bridge-254-review-journal/2'
      && journalBody.purpose === 'bridge_242_to_254_protected', 'protected capture requires journal v2')
    assert(canonical(journalBody.allowed_prefix_sha256) === canonical(expected.prefixes),
      'capture prefix chain differs from independent expectation')
    assert(capturedSnapshot(frozenCapture, expected) === journalBody.baseline_inventory_sha256,
      'signed baseline digest does not bind exact frozen capture')
    assert(journalBody.observation_sha256 === journalBody.baseline_inventory_sha256,
      'initial observation must bind the exact captured snapshot')
    const document = signed(journalBody, privateKeyPem, publicKeyPem)
    assert(reviewBridge254SignedJournal(document, expected).structure_consistent, 'new signed capture is invalid')
    assert(!existsSync(path.journal), 'signed journal already exists for this attempt')
    const snapshotBytes = Buffer.from(`${JSON.stringify(frozenCapture)}\n`)
    if (existsSync(path.capture)) assert(readProtected(path.capture, 0o400, expectedUid).equals(snapshotBytes),
      'orphan capture from interrupted write differs from this exact attempt')
    else atomic(path.capture, snapshotBytes, expectedUid)
    atomic(path.journal, Buffer.from(`${JSON.stringify(document)}\n`), expectedUid)
    return document
  }
  const advance = ({ attemptId, fromPhase, toPhase, observedPrefix, observationDigest, expected, deploymentNonce }) => {
    assertReviewOnlyMutationAllowed(requireProductionLock)
    const current = read({ attemptId, expected }), { journal } = current
    assert(journal.phase === fromPhase, 'signed journal phase changed before CAS')
    const now = new Date()
    assert(now.getTime() >= Date.parse(journal.updated_at), 'host clock moved behind signed journal')
    assert(SHA.test(observationDigest ?? ''), 'independent observation digest is required')
    const compactPrefix = observedPair(observedPrefix)
    if (['bridge_mutation_started', 'migration_started'].includes(toPhase)) {
      assert(observationDigest === journal.baseline_inventory_sha256,
        'mutation phase observation must bind the signed old-runtime capture')
    }
    if (['forward_recovery_started', 'migration_254_verified'].includes(toPhase)) {
      assert(observationDigest === compactPrefix.history_sha256,
        'migration phase observation must bind the exact live prefix checksum')
    }
    const result = reviewBridge254NextPhase(journal, toPhase, compactPrefix, expected)
    assert(result.next_phase === toPhase, `bridge phase refused: ${result.errors.join('; ')}`)
    if (toPhase === 'nonce_consumed') {
      assert(NONCE.test(deploymentNonce ?? '') && deploymentNonce === expected.deploymentNonce, 'deployment nonce changed')
      let exists = false
      try { nonceBinding(ledgerPath, deploymentNonce, journal, expectedUid); exists = true } catch (error) {
        if (error.code !== 'ENOENT' && !String(error.message).includes('lacks one exact consumption')) throw error
      }
      if (!exists) {
        assert(consume === null || !requireProductionLock, 'injected nonce consumer is forbidden in production')
        if (consume) consume(deploymentNonce, journal)
        else {
          protectedFile(consumerPath, 0o755, expectedUid)
          const args = ['consume', '--namespace', 'merchant-production-deploy', '--nonce', deploymentNonce,
            '--release-id', journal.bridge.release_id, '--image-digest', journal.bridge.image_set_digest,
            '--manifest-sha256', journal.bridge.manifest_sha256, '--release-git-sha', journal.bridge.git_sha,
            '--operation', 'bridge-254', '--attempt-id', attemptId]
          const result = spawnSync(consumerPath, args, { encoding: 'utf8', env: {} })
          assert(result.status === 0 && result.stdout.trim() === 'nonce accepted', 'protected nonce consumer rejected bridge-254 attempt')
        }
      }
      nonceBinding(ledgerPath, deploymentNonce, journal, expectedUid)
    }
    const next = signed({ ...journal, phase: toPhase, database_prefix: compactPrefix,
      nonce_owner: toPhase === 'nonce_consumed' ? expected.nonceOwner : journal.nonce_owner,
      observation_sha256: observationDigest, updated_at: now.toISOString(), signature_base64: undefined }, privateKeyPem, publicKeyPem)
    assert(reviewBridge254SignedJournal(next, expected).structure_consistent, 'next signed journal is invalid')
    atomic(paths(attemptId).journal, Buffer.from(`${JSON.stringify(next)}\n`), expectedUid, current.bytes)
    return { journal: next, observation_digest: observationDigest, deployable: false }
  }
  const recordPrefix = ({ attemptId, expectedVersion, observedPrefix, observationDigest, expected }) => {
    assertReviewOnlyMutationAllowed(requireProductionLock)
    const current = read({ attemptId, expected }), { journal } = current
    const now = new Date()
    assert(now.getTime() >= Date.parse(journal.updated_at), 'host clock moved behind signed journal')
    assert(journal.phase === 'forward_recovery_started', 'intermediate prefix recording requires forward recovery phase')
    assert(journal.database_prefix.version === expectedVersion && Number.isSafeInteger(expectedVersion), 'signed prefix changed before CAS')
    const compactPrefix = observedPair(observedPrefix)
    assert(compactPrefix.version === expectedVersion + 1
      && compactPrefix.history_sha256 === journal.allowed_prefix_sha256[compactPrefix.version],
    'observed prefix must advance within the frozen chain')
    assert(SHA.test(observationDigest ?? ''), 'independent database observation digest is required')
    assert(observationDigest === compactPrefix.history_sha256,
      'recorded prefix observation digest must equal the checked live history')
    const next = signed({ ...journal, database_prefix: compactPrefix, observation_sha256: observationDigest, updated_at: now.toISOString(),
      signature_base64: undefined }, privateKeyPem, publicKeyPem)
    assert(reviewBridge254SignedJournal(next, expected).structure_consistent, 'new signed prefix is invalid')
    atomic(paths(attemptId).journal, Buffer.from(`${JSON.stringify(next)}\n`), expectedUid, current.bytes)
    return { journal: next, observation_digest: observationDigest, deployable: false }
  }
  return Object.freeze({ capture, read, advance, recordPrefix })
}

export const BRIDGE_254_PROTECTED_STATE_PATHS = Object.freeze({ directory: ROOT, ledgerPath: LEDGER, consumerPath: CONSUMER, lockPath: LOCK })

export function assertBridge254NonceConsumerSupportsOperation(path) {
  const result = spawnSync(path, ['consume', '--help'], { encoding: 'utf8', env: {}, timeout: 5000, maxBuffer: 8192 })
  assert(result.status === 0 && /--operation \{deployment,bridge-b,bridge-254,bridge-255,demo-254-backup\}/u.test(result.stdout ?? ''),
    'installed nonce consumer does not advertise the independently reviewed bridge-254 operation')
}

export function openProtectedBridge254StateStore() {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'protected bridge state requires root')
  assert(fileURLToPath(import.meta.url) === INSTALLED, 'bridge state must run from its fixed installed path')
  const exactDigest = (path, digestPath) => {
    const trusted = readTrust(digestPath, 128).toString('utf8').trim()
    assert(SHA.test(trusted) && sha(readTrust(path, 2 * 1024 * 1024)) === trusted,
      'installed protected source differs from its independently provisioned digest')
  }
  exactDigest(INSTALLED, `${TRUST}/production-bridge-254-state-store-sha256`)
  exactDigest(REVIEW_INSTALLED, `${TRUST}/production-bridge-254-review-state-sha256`)
  exactDigest(CONSUMER, `${TRUST}/production-evidence-nonce-consumer-sha256`)
  assertBridge254NonceConsumerSupportsOperation(CONSUMER)
  const privateKeyPem = readTrust(PRIVATE_KEY, 8192).toString('utf8')
  const publicKeyPem = readTrust(`${TRUST}/production-evidence-public.pem`, 8192).toString('utf8')
  const trustedKeyId = readTrust(`${TRUST}/production-evidence-key-id`, 128).toString('utf8').trim()
  return createBridge254StateStore({ directory: ROOT, ledgerPath: LEDGER, consumerPath: CONSUMER,
    privateKeyPem, publicKeyPem, trustedKeyId })
}
