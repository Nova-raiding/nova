#!/usr/bin/env node
// Durable, signed host state for the independent 254→255 transition. This
// module owns the journal, nonce boundary, and read-only status snapshot; it
// never runs Docker, SQL, gateway, or service operations. Mutations require FD9.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, chmodSync, closeSync, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { reviewBridge255Phase, validateBridge255Plan } from './ecs-bridge-255-review.mjs'
import { reviewBridge255Transition } from './ecs-bridge-255-state.mjs'

const SHA = /^[a-f0-9]{64}$/u
const ATTEMPT = /^[A-Za-z0-9_-]{16,128}$/u
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const ROOT = '/var/lib/merchant-release-security/bridge-255'
const LEDGER = '/var/lib/merchant-release-security/production-nonces.sqlite3'
const CONSUMER = '/usr/local/libexec/merchant/consume-production-evidence-nonce'
const LOCK = '/var/lib/merchant-release-security/production-deploy.lock'
const INSTALLED = '/usr/local/libexec/merchant/ecs-bridge-255-state-store.mjs'
const REVIEW_INSTALLED = '/usr/local/libexec/merchant/ecs-bridge-255-review.mjs'
const TRANSITION_REVIEW_INSTALLED = '/usr/local/libexec/merchant/ecs-bridge-255-state.mjs'
const TRUST = '/run/release-security/evidence-trust'
const PRIVATE_KEY = '/var/lib/merchant-release-security/production-capability-private.pem'
const APPROVED_PLAN = `${TRUST}/production-bridge-255-execution-plan.json`
const requireValue = (ok, message) => { if (!ok) throw new Error(`BRIDGE_255_STATE_STORE_${message}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const journalDigest = journal => sha(JSON.stringify(Object.fromEntries(Object.entries(journal).sort(([a], [b]) => a.localeCompare(b)))))

function protectedFile(path, mode, uid) {
  requireValue(resolve(path) === path && realpathSync(path) === path, 'PATH_NOT_CANONICAL')
  const st = lstatSync(path)
  const allowedModes = Array.isArray(mode) ? mode : [mode]
  requireValue(!st.isSymbolicLink() && st.uid === uid && st.nlink === 1
    && allowedModes.includes(st.mode & 0o777) && st.isFile(), 'FILE_OWNERSHIP_MODE_OR_TYPE_INVALID')
  return st
}
function protectedChain(path) {
  let cursor = dirname(path)
  for (;;) {
    const st = lstatSync(cursor)
    requireValue(realpathSync(cursor) === cursor && st.isDirectory() && st.uid === 0
      && (st.mode & 0o022) === 0, 'ANCESTOR_NOT_PROTECTED')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
}
function readProtected(path, mode, uid, limit = 1024 * 1024) {
  const before = protectedFile(path, mode, uid)
  requireValue(before.size > 0 && before.size <= limit, 'FILE_SIZE_INVALID')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    requireValue(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1,
      'FILE_CHANGED_WHILE_OPENING')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function atomic(path, bytes, uid, previous = null) {
  const parent = dirname(path)
  const dirStat = lstatSync(parent)
  requireValue(dirStat.isDirectory() && !dirStat.isSymbolicLink() && dirStat.uid === uid
    && (dirStat.mode & 0o777) === 0o700, 'STATE_DIRECTORY_UNSAFE')
  const temp = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    chmodSync(temp, 0o400)
    if (previous === null) { linkSync(temp, path); unlinkSync(temp) }
    else {
      const before = readProtected(path, 0o400, uid)
      requireValue(before.equals(previous), 'JOURNAL_CAS_CONFLICT')
      const st = lstatSync(path)
      requireValue(readProtected(path, 0o400, uid).equals(previous), 'JOURNAL_CHANGED_BEFORE_REPLACE')
      const after = lstatSync(path)
      requireValue(st.dev === after.dev && st.ino === after.ino, 'JOURNAL_INODE_CHANGED')
      renameSync(temp, path)
    }
    const dirFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    requireValue(readProtected(path, 0o400, uid).equals(bytes), 'JOURNAL_READBACK_MISMATCH')
  } finally { try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}
function signDocument(body, privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  requireValue(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      .equals(publicKey.export({ type: 'spki', format: 'der' })), 'JOURNAL_SIGNING_KEY_MISMATCH')
  return { ...body, signature_base64: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64') }
}
export function verifySignedBridge255ExecutionPlan(envelope, publicPem, keyId, now = new Date()) {
  requireValue(envelope && Object.keys(envelope).sort().join('\0')
    === ['created_at', 'expires_at', 'key_id', 'plan', 'schema_version', 'signature_base64'].sort().join('\0')
    && envelope.schema_version === 'ecs-bridge-255-execution-plan/1' && envelope.key_id === keyId,
  'APPROVED_PLAN_ENVELOPE_INVALID')
  const created = Date.parse(envelope.created_at), expires = Date.parse(envelope.expires_at)
  requireValue(Number.isFinite(created) && Number.isFinite(expires)
    && envelope.created_at === new Date(created).toISOString()
    && envelope.expires_at === new Date(expires).toISOString()
    && created <= now.getTime() + 300_000 && expires > now.getTime()
    && expires - created <= 86_400_000, 'APPROVED_PLAN_TIME_INVALID')
  validateBridge255Plan(envelope.plan)
  let valid = false
  try {
    const key = createPublicKey(publicPem), bytes = Buffer.from(envelope.signature_base64, 'base64')
    valid = key.asymmetricKeyType === 'ed25519' && bytes.length === 64
      && bytes.toString('base64') === envelope.signature_base64
      && verify(null, Buffer.from(canonical(envelope)), key, bytes)
  } catch { /* invalid protected trust input fails closed */ }
  requireValue(valid, 'APPROVED_PLAN_SIGNATURE_INVALID')
  return Object.freeze({ plan: envelope.plan, plan_sha256: validateBridge255Plan(envelope.plan) })
}
export function productionLockProbeConflicts(path, probe = spawnSync) {
  const contention = probe('/usr/bin/flock', ['-n', path, '/bin/true'], {
    encoding: 'utf8', env: {}, stdio: ['ignore', 'ignore', 'ignore'],
  })
  return contention.status === 1
}
function lockHeld(path) {
  const st = lstatSync(path)
  requireValue(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0,
    'PRODUCTION_LOCK_PATH_UNSAFE')
  const fd = fstatSync(9), live = statSync(path)
  requireValue(fd.dev === live.dev && fd.ino === live.ino, 'FD9_NOT_PRODUCTION_LOCK')
  const probeFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const probe = fstatSync(probeFd)
    requireValue(probe.dev === live.dev && probe.ino === live.ino, 'LOCK_CHANGED_WHILE_PROBING')
    // Open a second descriptor for the same inode and ask flock to acquire it.
    // flock locks are associated with open-file descriptions, so this must
    // conflict exactly when FD 9's description holds the exclusive lock.
    requireValue(productionLockProbeConflicts(path), 'PRODUCTION_LOCK_NOT_HELD_EXCLUSIVELY')
  } finally { closeSync(probeFd) }
  const device = BigInt(live.dev)
  const deviceInode = `${(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)).toString(16).padStart(2, '0')}:${((device & 0xffn) | ((device >> 12n) & 0xffffff00n)).toString(16).padStart(2, '0')}:${live.ino}`
  const owned = readFileSync('/proc/locks', 'utf8').split('\n').some(line => {
    const match = /^\s*\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+:[0-9a-f]+:\d+)\s+/u.exec(line)
    return match && [process.pid, process.ppid].includes(Number(match[1])) && match[2] === deviceInode
  })
  requireValue(owned, 'FD9_LOCK_NOT_OWNED_BY_INVOCATION')
}
function readNonce(ledgerPath, nonce, plan, uid, { allowMissing = false } = {}) {
  protectedFile(ledgerPath, 0o600, uid)
  const db = new DatabaseSync(ledgerPath, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT c.release_id,c.image_digest,c.manifest_sha256,c.release_git_sha,
      o.operation,o.attempt_id FROM consumed_nonces c JOIN nonce_owners o USING(namespace,nonce)
      WHERE c.namespace=? AND c.nonce=?`).all('merchant-production-deploy', nonce)
    requireValue(rows.length === 1 || (allowMissing && rows.length === 0),
      rows.length > 1 ? 'NONCE_LEDGER_BINDING_DUPLICATE' : 'NONCE_LEDGER_BINDING_MISSING')
    if (rows.length === 0) return null
    const row = rows[0], identity = plan.bridge_254_255.identity
    requireValue(row.release_id === identity.release_id && row.image_digest === identity.image_set_digest
      && row.manifest_sha256 === identity.manifest_sha256 && row.release_git_sha === identity.git_sha
      && row.operation === 'bridge-255' && row.attempt_id === plan.attempt_id, 'NONCE_OWNER_MISMATCH')
    return Object.freeze({ namespace: 'merchant-production-deploy', operation: 'bridge-255',
      attempt_id: plan.attempt_id, nonce_sha256: plan.nonce_sha256,
      release_id: row.release_id, git_sha: row.release_git_sha,
      manifest_sha256: row.manifest_sha256, image_set_digest: row.image_digest })
  } finally { db.close() }
}
function readNonceForAttempt(ledgerPath, plan, uid, { allowMissing = false } = {}) {
  protectedFile(ledgerPath, 0o600, uid)
  const db = new DatabaseSync(ledgerPath, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT c.nonce,c.release_id,c.image_digest,c.manifest_sha256,c.release_git_sha,
      o.operation,o.attempt_id FROM consumed_nonces c JOIN nonce_owners o USING(namespace,nonce)
      WHERE c.namespace=? AND o.attempt_id=?`).all('merchant-production-deploy', plan.attempt_id)
    if (allowMissing && rows.length === 0) {
      const identity = plan.bridge_254_255.identity
      const ambiguous = db.prepare(`SELECT c.nonce FROM consumed_nonces c
        WHERE c.namespace=? AND c.release_id=? AND c.image_digest=? AND c.manifest_sha256=? AND c.release_git_sha=?`)
        .all('merchant-production-deploy', identity.release_id, identity.image_set_digest,
          identity.manifest_sha256, identity.git_sha)
      requireValue(!ambiguous.some(row => sha(row.nonce) === plan.nonce_sha256),
        'NONCE_LEDGER_OWNER_MISSING_OR_DIFFERENT_ATTEMPT')
    }
    requireValue(rows.length === 1 || (allowMissing && rows.length === 0), 'NONCE_LEDGER_BINDING_MISSING_OR_DUPLICATE')
    if (rows.length === 0) return null
    const row = rows[0], identity = plan.bridge_254_255.identity
    requireValue(row.operation === 'bridge-255' && row.attempt_id === plan.attempt_id
      && sha(row.nonce) === plan.nonce_sha256 && row.release_id === identity.release_id
      && row.image_digest === identity.image_set_digest && row.manifest_sha256 === identity.manifest_sha256
      && row.release_git_sha === identity.git_sha, 'NONCE_OWNER_MISMATCH')
    return Object.freeze({ namespace: 'merchant-production-deploy', operation: 'bridge-255',
      attempt_id: plan.attempt_id, nonce_sha256: plan.nonce_sha256,
      release_id: row.release_id, git_sha: row.release_git_sha,
      manifest_sha256: row.manifest_sha256, image_set_digest: row.image_digest })
  } finally { db.close() }
}

function verifyProtectedPrerequisites() {
  protectedChain(ROOT)
  const state = lstatSync(ROOT)
  requireValue(realpathSync(ROOT) === ROOT && state.isDirectory() && !state.isSymbolicLink()
    && state.uid === 0 && (state.mode & 0o777) === 0o700, 'STATE_DIRECTORY_UNSAFE')
  protectedChain(LOCK)
  const lock = lstatSync(LOCK)
  requireValue(realpathSync(LOCK) === LOCK && lock.isFile() && !lock.isSymbolicLink()
    && lock.uid === 0 && (lock.mode & 0o022) === 0, 'PRODUCTION_LOCK_UNSAFE')
  for (const [path, mode, label] of [[LEDGER, 0o600, 'NONCE_LEDGER'],
    [CONSUMER, 0o755, 'NONCE_CONSUMER']]) {
    protectedChain(path)
    try { protectedFile(path, mode, 0) } catch { requireValue(false, `${label}_UNSAFE`) }
  }
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    const expected = {
      consumed_nonces: { columns: ['namespace', 'nonce', 'release_id', 'image_digest', 'manifest_sha256', 'release_git_sha', 'consumed_at'], primaryKey: ['namespace', 'nonce'] },
      nonce_owners: { columns: ['namespace', 'nonce', 'operation', 'attempt_id'], primaryKey: ['namespace', 'nonce'] },
    }
    for (const [table, contract] of Object.entries(expected)) {
      const found = db.prepare(`PRAGMA table_info(${table})`).all()
      const columns = found.map(row => row.name)
      const primaryKey = found.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => row.name)
      requireValue(contract.columns.every(column => columns.includes(column))
        && canonical(primaryKey) === canonical(contract.primaryKey), 'NONCE_LEDGER_SCHEMA_INVALID')
    }
    db.prepare(`SELECT c.namespace,c.nonce,c.release_id,c.image_digest,c.manifest_sha256,c.release_git_sha,
      o.operation,o.attempt_id FROM consumed_nonces c JOIN nonce_owners o USING(namespace,nonce) LIMIT 0`).all()
  } catch (error) {
    if (String(error?.message ?? '').includes('NONCE_LEDGER_SCHEMA_INVALID')) throw error
    requireValue(false, 'NONCE_LEDGER_SCHEMA_INVALID')
  } finally { db.close() }
}

/** Construct a journal store. Production paths, key material and approved plan are fixed by openProtectedBridge255StateStore. */
export function createBridge255StateStore({ directory, ledgerPath, consumerPath, privateKeyPem,
  publicKeyPem, trustedKeyId, approvedPlanSha256, approvedPlan, expectedUid = 0,
  approvedPlanExpiresAt = null, requireProductionLock = true, now = () => new Date(), consume = null }) {
  requireValue(typeof privateKeyPem === 'string' && typeof publicKeyPem === 'string', 'ED25519_KEYS_REQUIRED')
  requireValue(typeof trustedKeyId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trustedKeyId), 'KEY_ID_INVALID')
  requireValue(SHA.test(approvedPlanSha256 ?? '') && approvedPlanSha256 === validateBridge255Plan(approvedPlan), 'APPROVED_PLAN_HASH_MISMATCH')
  requireValue(typeof directory === 'string' && typeof ledgerPath === 'string' && typeof consumerPath === 'string', 'PROTECTED_PATHS_REQUIRED')
  if (requireProductionLock) {
    requireValue(process.getuid?.() === 0 && process.geteuid?.() === 0 && expectedUid === 0, 'ROOT_REQUIRED')
    requireValue(directory === ROOT && ledgerPath === LEDGER && consumerPath === CONSUMER, 'PRODUCTION_PATHS_ARE_FIXED')
    requireValue(consume === null, 'INJECTED_NONCE_CONSUMER_FORBIDDEN')
  } else {
    const isolated = `${realpathSync(tmpdir())}/merchant-bridge-255-state-`
    requireValue(directory.startsWith(isolated) && ledgerPath.startsWith(`${directory}/`), 'TEST_PATH_OUTSIDE_ISOLATED_TMP')
  }
  const guard = ({ requireLock = true } = {}) => {
    const st = lstatSync(directory)
    requireValue(realpathSync(directory) === directory && st.isDirectory() && st.uid === expectedUid
      && (st.mode & 0o777) === 0o700, 'STATE_DIRECTORY_UNSAFE')
    if (requireProductionLock) {
      protectedChain(directory); protectedChain(ledgerPath); protectedChain(consumerPath)
      if (requireLock) lockHeld(LOCK)
    }
  }
  const pathFor = attemptId => {
    requireValue(ATTEMPT.test(attemptId ?? ''), 'ATTEMPT_ID_INVALID')
    return join(directory, `${attemptId}.json`)
  }
  const bindPlan = plan => requireValue(validateBridge255Plan(plan) === approvedPlanSha256
    && canonical(plan) === canonical(approvedPlan), 'PLAN_NOT_APPROVED')
  const encode = state => Buffer.from(`${JSON.stringify(state)}\n`)
  const readState = ({ attemptId, plan, now: at = now(), requireLock = true }) => {
    guard({ requireLock }); bindPlan(plan)
    const bytes = readProtected(pathFor(attemptId), 0o400, expectedUid, 4 * 1024 * 1024)
    const state = JSON.parse(bytes.toString('utf8'))
    requireValue(state?.schema_version === 'ecs-bridge-255-protected-state/1'
      && state.attempt_id === attemptId && canonical(state.plan) === canonical(plan)
      && Array.isArray(state.history) && state.history.length > 0, 'STATE_DOCUMENT_INVALID')
    let prior = null
    for (const entry of state.history) {
      requireValue(entry && Object.keys(entry).sort().join('\0') === ['journal', 'observation'].sort().join('\0'), 'STATE_HISTORY_ENTRY_INVALID')
      if (prior) reviewBridge255Transition({ plan, capture: state.capture,
        previous: prior.journal, next: entry.journal, publicKeyPem,
        previousObservation: prior.observation, nextObservation: entry.observation, now: at })
      else reviewBridge255Phase({ plan, capture: state.capture, journal: entry.journal,
        publicKeyPem, observation: entry.observation, now: at })
      prior = entry
    }
    requireValue(state.history.at(-1).journal.attempt_id === attemptId, 'STATE_ATTEMPT_MISMATCH')
    return { state, bytes }
  }
  const save = (attemptId, state, bytes = null) => atomic(pathFor(attemptId), encode(state), expectedUid, bytes)
  const captureSigned = async ({ plan, capture, observation }) => {
    guard(); bindPlan(plan)
    requireValue(observation?.phase === 'captured_254', 'INITIAL_PHASE_INVALID')
    const at = now(), created = at.toISOString(), expiryMs = Math.min(at.getTime() + 86_400_000,
      Date.parse(capture?.expires_at ?? '') || at.getTime() + 86_400_000)
    requireValue(Number.isFinite(expiryMs) && expiryMs > at.getTime(), 'PLAN_EXPIRED')
    const body = { schema_version: 'ecs-bridge-255-journal/2', attempt_id: plan.attempt_id,
      plan_sha256: approvedPlanSha256, phase: 'captured_254', previous_journal_sha256: null,
      nonce_sha256: plan.nonce_sha256, capture_sha256: capture?.capture_sha256,
      observation_sha256: sha(canonical(observation)), created_at: created,
      expires_at: new Date(expiryMs).toISOString() }
    const journal = signDocument(body, privateKeyPem, publicKeyPem)
    reviewBridge255Phase({ plan, capture, journal, publicKeyPem, observation, now: at })
    const state = { schema_version: 'ecs-bridge-255-protected-state/1', attempt_id: plan.attempt_id,
      plan, capture, history: [{ journal, observation }] }
    save(plan.attempt_id, state)
    return journal
  }
  const advanceSigned = async ({ plan, capture, previous, phase, observation }) => {
    const at = now(), current = readState({ attemptId: plan.attempt_id, plan, now: at })
    const last = current.state.history.at(-1)
    requireValue(canonical(last.journal) === canonical(previous)
      && canonical(current.state.capture) === canonical(capture), 'SIGNED_STATE_CHANGED_BEFORE_ADVANCE')
    requireValue(observation?.phase === phase, 'OBSERVATION_PHASE_MISMATCH')
    const body = { ...last.journal, phase, previous_journal_sha256: journalDigest(last.journal),
      observation_sha256: sha(canonical(observation)), created_at: at.toISOString(), signature_base64: undefined }
    const next = signDocument(body, privateKeyPem, publicKeyPem)
    reviewBridge255Transition({ plan, capture, previous: last.journal, next, publicKeyPem,
      previousObservation: last.observation, nextObservation: observation, now: at })
    save(plan.attempt_id, { ...current.state, history: [...current.state.history, { journal: next, observation }] }, current.bytes)
    return next
  }
  const consumeNonceOnce = async ({ plan, deploymentNonce, namespace, operation }) => {
    guard(); bindPlan(plan)
    requireValue(namespace === 'merchant-production-deploy' && operation === 'bridge-255'
      && NONCE.test(deploymentNonce ?? '') && sha(deploymentNonce) === plan.nonce_sha256, 'NONCE_INPUT_INVALID')
    const existing = readNonce(ledgerPath, deploymentNonce, plan, expectedUid, { allowMissing: true })
    if (existing) return existing
    const identity = plan.bridge_254_255.identity
    if (consume && !requireProductionLock) consume(deploymentNonce, plan)
    else {
      requireValue(requireProductionLock, 'ISOLATED_NONCE_CONSUMPTION_DISABLED')
      protectedFile(consumerPath, 0o755, expectedUid)
      const result = spawnSync(consumerPath, ['consume', '--namespace', namespace, '--nonce', deploymentNonce,
        '--release-id', identity.release_id, '--image-digest', identity.image_set_digest,
        '--manifest-sha256', identity.manifest_sha256, '--release-git-sha', identity.git_sha,
        '--operation', operation, '--attempt-id', plan.attempt_id], { encoding: 'utf8', env: {}, timeout: 15_000 })
      requireValue(result.status === 0 && result.stdout.trim() === 'nonce accepted', 'PROTECTED_NONCE_CONSUMER_REJECTED')
    }
    return readNonce(ledgerPath, deploymentNonce, plan, expectedUid)
  }
  const readConsumedNonce = async ({ plan = approvedPlan, attemptId, nonce_sha256 }) => {
    guard(); bindPlan(plan)
    requireValue(attemptId === plan.attempt_id && nonce_sha256 === plan.nonce_sha256, 'NONCE_LOOKUP_BINDING_INVALID')
    return readNonceForAttempt(ledgerPath, plan, expectedUid)
  }
  const readFrozenAttempt = async ({ attemptId }) => {
    guard(); const bytes = readProtected(pathFor(attemptId), 0o400, expectedUid, 4 * 1024 * 1024)
    const state = JSON.parse(bytes.toString('utf8'))
    bindPlan(state.plan)
    const validated = readState({ attemptId, plan: state.plan })
    return { plan_sha256: approvedPlanSha256, capture: validated.state.capture,
      journal: validated.state.history.at(-1).journal,
      observation: validated.state.history.at(-1).observation }
  }
  const inspectApprovedAttempt = async () => {
    guard({ requireLock: false }); bindPlan(approvedPlan)
    let frozen = null
    try {
      const statePath = pathFor(approvedPlan.attempt_id)
      const stat = lstatSync(statePath)
      requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid
        && stat.nlink === 1 && (stat.mode & 0o777) === 0o400, 'STATE_FILE_UNSAFE')
      const validated = readState({ attemptId: approvedPlan.attempt_id, plan: approvedPlan, requireLock: false })
      const last = validated.state.history.at(-1)
      frozen = { phase: last.journal.phase, created_at: last.journal.created_at,
        expires_at: last.journal.expires_at, journal_sha256: journalDigest(last.journal),
        history_length: validated.state.history.length }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const nonceReceipt = readNonceForAttempt(ledgerPath, approvedPlan, expectedUid, { allowMissing: true })
    return Object.freeze({ schema_version: 'ecs-bridge-255-host-status/1',
      plan_sha256: approvedPlanSha256, key_id: trustedKeyId,
      attempt_id: approvedPlan.attempt_id, project: approvedPlan.project,
      plan_expires_at: approvedPlanExpiresAt,
      phase: frozen?.phase ?? null, journal: frozen,
      nonce_consumed: nonceReceipt !== null,
      nonce_owner: nonceReceipt ? { operation: nonceReceipt.operation,
        attempt_id: nonceReceipt.attempt_id, nonce_sha256: nonceReceipt.nonce_sha256 } : null,
      production_lock: { path: LOCK, path_verified: true, held_by_invocation: false },
      production_mutation_authorized: false,
      blockers: ['NO_PRODUCTION_HOST_CONTROL_ADAPTER', 'NO_REHEARSED_FORWARD_RECOVERY_PATH'] })
  }
  return Object.freeze({ captureSigned, advanceSigned, consumeNonceOnce, readConsumedNonce,
    readFrozenAttempt, inspectApprovedAttempt })
}

export const BRIDGE_255_PROTECTED_STATE_PATHS = Object.freeze({ directory: ROOT,
  ledgerPath: LEDGER, consumerPath: CONSUMER, lockPath: LOCK, approvedPlan: APPROVED_PLAN })

export function openProtectedBridge255StateStore() {
  requireValue(process.getuid?.() === 0 && process.geteuid?.() === 0, 'ROOT_REQUIRED')
  requireValue(fileURLToPath(import.meta.url) === INSTALLED, 'FIXED_INSTALL_REQUIRED')
  const readTrust = path => { protectedChain(path); return readProtected(path, [0o400, 0o444], 0, 64 * 1024) }
  const publicKeyPem = readTrust(`${TRUST}/production-evidence-public.pem`).toString('utf8')
  const trustedKeyId = readTrust(`${TRUST}/production-evidence-key-id`).toString('utf8').trim()
  protectedChain(PRIVATE_KEY)
  const privateKeyPem = readProtected(PRIVATE_KEY, 0o600, 0, 8192).toString('utf8')
  const approvedPlan = JSON.parse(readTrust(APPROVED_PLAN).toString('utf8'))
  const verifiedPlan = verifySignedBridge255ExecutionPlan(approvedPlan, publicKeyPem, trustedKeyId)
  const exactDigest = (path, digestPath) => {
    protectedChain(path)
    requireValue(sha(readProtected(path, 0o755, 0, 4 * 1024 * 1024))
      === readTrust(digestPath).toString('utf8').trim(), 'INSTALLED_SOURCE_DIGEST_INVALID')
  }
  exactDigest(INSTALLED, `${TRUST}/production-bridge-255-state-store-sha256`)
  exactDigest(REVIEW_INSTALLED, `${TRUST}/production-bridge-255-review-sha256`)
  exactDigest(TRANSITION_REVIEW_INSTALLED, `${TRUST}/production-bridge-255-transition-review-sha256`)
  exactDigest(CONSUMER, `${TRUST}/production-evidence-nonce-consumer-sha256`)
  verifyProtectedPrerequisites()
  return createBridge255StateStore({ directory: ROOT, ledgerPath: LEDGER, consumerPath: CONSUMER,
    privateKeyPem, publicKeyPem, trustedKeyId, approvedPlanSha256: verifiedPlan.plan_sha256,
    approvedPlan: verifiedPlan.plan, approvedPlanExpiresAt: approvedPlan.expires_at })
}
