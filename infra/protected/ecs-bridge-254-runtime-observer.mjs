#!/usr/bin/env node
// Production read-only runtime port for the 242→254 maintenance controller.
// Credentials and the frozen prefix chain must be supplied by its protected
// caller. This module cannot sign a journal, consume a nonce, or mutate Docker.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, constants } from 'node:fs'
import { dirname } from 'node:path'

const LOCK = '/var/lib/merchant-release-security/production-deploy.lock'
const IDENTITY = '/var/lib/merchant-release-security/bridge-254/database-identity.json'
const IDENTITY_DIGEST = '/run/release-security/evidence-trust/bridge-254-database-identity-sha256'
const SHA = /^[a-f0-9]{64}$/u
const ROLE = Object.freeze({ runtime: 'merchant_app', ops: 'merchant_ops', cluster: 'merchant' })
const fail = message => { throw new Error(`BRIDGE_254_OBSERVER_${message}`) }
const requireValue = (condition, message) => { if (!condition) fail(message) }
const sha = value => createHash('sha256').update(value).digest('hex')

export const BRIDGE_254_OBSERVE_SQL = `SELECT json_build_object(
 'history', coalesce(json_agg(json_build_array(version,name,checksum) ORDER BY version),'[]'::json),
 'database_oid', (SELECT oid FROM pg_database WHERE datname=current_database()),
 'database_name', current_database(), 'server_addr', inet_server_addr()::text,
 'server_port', inet_server_port(),
 'invalid_indexes', (
   SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_index i ON i.indexrelid=c.oid
    WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)
 )) FROM public.schema_migrations`

export const BRIDGE_254_CLUSTER_SQL = `SELECT json_build_object(
 'system_identifier', (pg_control_system()).system_identifier::text,
 'database_oid', (SELECT oid FROM pg_database WHERE datname=current_database()),
 'database_name', current_database(), 'server_addr', inet_server_addr()::text,
 'server_port', inet_server_port())`

export function verifyBridge254DatabaseIdentityPolicy(policy) {
  requireValue(policy && typeof policy === 'object' && !Array.isArray(policy) &&
    Object.keys(policy).sort().join(',') ===
      'ca_file,ca_sha256,database_name,database_oid,hostname,port,system_identifier_sha256' &&
    typeof policy.hostname === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(policy.hostname) &&
    !/^(?:localhost|127\.|0\.|::1$)/iu.test(policy.hostname) &&
    Number.isSafeInteger(policy.port) && policy.port > 0 && policy.port <= 65535 &&
    typeof policy.database_name === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(policy.database_name) &&
    Number.isSafeInteger(policy.database_oid) && policy.database_oid > 0 &&
    SHA.test(policy.system_identifier_sha256 ?? '') && SHA.test(policy.ca_sha256 ?? '') &&
    typeof policy.ca_file === 'string' && policy.ca_file.startsWith('/') &&
    !policy.ca_file.includes('\0'), 'DATABASE_IDENTITY_POLICY_INVALID')
  return policy
}

function protectedBytes(path, maxBytes, exactMode) {
  requireValue(typeof path === 'string' && path.startsWith('/') && realpathSync(path) === path, 'PROTECTED_PATH_INVALID')
  for (let cursor = path; cursor !== '/'; cursor = dirname(cursor)) {
    const st = lstatSync(cursor)
    requireValue(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'PROTECTED_PATH_UNSAFE')
  }
  const stat = lstatSync(path)
  requireValue(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes &&
    (exactMode === undefined || (stat.mode & 0o777) === exactMode), 'PROTECTED_FILE_INVALID')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    requireValue(opened.dev === stat.dev && opened.ino === stat.ino, 'PROTECTED_FILE_CHANGED')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

function frozenDatabaseIdentity() {
  const trusted = protectedBytes(IDENTITY_DIGEST, 128).toString('utf8').trim()
  requireValue(SHA.test(trusted), 'DATABASE_IDENTITY_TRUST_INVALID')
  const bytes = protectedBytes(IDENTITY, 8192, 0o400)
  requireValue(sha(bytes) === trusted, 'DATABASE_IDENTITY_DIGEST_MISMATCH')
  let policy
  try { policy = JSON.parse(bytes.toString('utf8')) } catch { fail('DATABASE_IDENTITY_JSON_INVALID') }
  verifyBridge254DatabaseIdentityPolicy(policy)
  requireValue(sha(protectedBytes(policy.ca_file, 65536)) === policy.ca_sha256, 'DATABASE_CA_DIGEST_MISMATCH')
  return Object.freeze(policy)
}

export function bridge254DatabaseEnvironment(databaseUrl, expectedRole, policy) {
  verifyBridge254DatabaseIdentityPolicy(policy)
  requireValue(typeof databaseUrl === 'string' && databaseUrl.length > 0 && databaseUrl.length <= 4096, 'DATABASE_URL_INVALID')
  let url
  try { url = new URL(databaseUrl) } catch { fail('DATABASE_URL_INVALID') }
  requireValue(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === policy.hostname &&
    (url.port || '5432') === String(policy.port) && url.pathname === `/${policy.database_name}` &&
    !url.hash && !url.searchParams.has('options') && url.searchParams.size === 2 &&
    url.searchParams.get('sslmode') === 'verify-full' && url.searchParams.get('sslrootcert') === policy.ca_file,
  'DATABASE_URL_TLS_INVALID')
  requireValue(url.username === expectedRole && url.password,
  'DATABASE_ROLE_OR_TARGET_INVALID')
  return Object.freeze({ PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: expectedRole,
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: policy.database_name,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: policy.ca_file,
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=10000' })
}

function protectedProductionLock() {
  requireValue(process.getuid?.() === 0 && process.geteuid?.() === 0 && process.platform === 'linux', 'ROOT_LINUX_REQUIRED')
  requireValue(realpathSync(LOCK) === LOCK, 'LOCK_PATH_INVALID')
  for (let path = LOCK; path !== '/'; path = dirname(path)) {
    const st = lstatSync(path)
    requireValue(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'LOCK_PATH_UNPROTECTED')
  }
  const st = statSync(LOCK), fd = fstatSync(9)
  requireValue(st.isFile() && st.nlink === 1 && fd.dev === st.dev && fd.ino === st.ino, 'LOCK_FD_MISMATCH')
  const probeFd = openSync(LOCK, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const probe = fstatSync(probeFd)
    requireValue(probe.dev === st.dev && probe.ino === st.ino, 'LOCK_CHANGED')
    const contention = spawnSync('/usr/bin/flock', ['-n', '10', '/bin/true'], {
      env: {}, timeout: 5000, stdio: ['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',probeFd],
    })
    requireValue(contention.status === 1, 'LOCK_NOT_HELD')
  } finally { closeSync(probeFd) }
  // The kernel lock table binds the lock inode to this process or its parent
  // flock invocation. Merely inheriting an unrelated open FD is insufficient.
  const dev = BigInt(st.dev)
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)
  const identity = `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${st.ino}`
  const pids = new Set([process.pid, process.ppid])
  requireValue(readFileSync('/proc/locks', 'utf8').split('\n').some(line => {
    const match = /^\s*\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+:[0-9a-f]+:\d+)\s+/u.exec(line)
    return match && pids.has(Number(match[1])) && match[2] === identity
  }), 'LOCK_OWNER_MISMATCH')
}

export function verifyBridge254ObservedHistories(runtimeResult, opsResult, clusterResult, frozenPrefixes, policy) {
  verifyBridge254DatabaseIdentityPolicy(policy)
  requireValue(frozenPrefixes && typeof frozenPrefixes === 'object' &&
    Object.keys(frozenPrefixes).sort().join(',') === Array.from({ length: 13 }, (_, i) => String(242 + i)).sort().join(',') &&
    Object.values(frozenPrefixes).every(value => SHA.test(value)), 'FROZEN_PREFIX_CHAIN_INVALID')
  const parse = (value, label) => {
    requireValue(value && Array.isArray(value.history) && Array.isArray(value.invalid_indexes)
      && value.invalid_indexes.length === 0 && value.database_oid === policy.database_oid &&
      value.database_name === policy.database_name && typeof value.server_addr === 'string' &&
      value.server_addr.length > 0 && value.server_port === policy.port,
    `${label}_INVALID_INDEX_OR_DATABASE_IDENTITY`)
    const rows = value.history
    requireValue(rows.length >= 242 && rows.length <= 254 && rows.every((row, index) =>
      Array.isArray(row) && row.length === 3 && row[0] === index + 1
      && typeof row[1] === 'string' && /^[a-z0-9_]+$/u.test(row[1]) && SHA.test(row[2] ?? '')),
    `${label}_HISTORY_INVALID`)
    return { version: rows.length, server_addr: value.server_addr, history_sha256: sha(rows.map(([version, name, checksum]) =>
      `${version}\t${name}\t${checksum}\n`).join('')) }
  }
  const runtime = parse(runtimeResult, 'RUNTIME'), ops = parse(opsResult, 'OPS')
  requireValue(clusterResult && /^\d{1,32}$/u.test(clusterResult.system_identifier ?? '') &&
    sha(clusterResult.system_identifier) === policy.system_identifier_sha256 &&
    clusterResult.database_oid === policy.database_oid && clusterResult.database_name === policy.database_name &&
    clusterResult.server_port === policy.port && clusterResult.server_addr === runtime.server_addr &&
    clusterResult.server_addr === ops.server_addr, 'CLUSTER_IDENTITY_MISMATCH')
  requireValue(runtime.version === ops.version && runtime.history_sha256 === ops.history_sha256,
    'RUNTIME_OPS_HISTORY_MISMATCH')
  requireValue(runtime.history_sha256 === frozenPrefixes[String(runtime.version)], 'FROZEN_PREFIX_MISMATCH')
  return Object.freeze({ version: runtime.version, history_sha256: runtime.history_sha256,
    ops_version: ops.version, ops_history_sha256: ops.history_sha256 })
}

function queryRole(databaseUrl, expectedRole, policy, sql) {
  const environment = bridge254DatabaseEnvironment(databaseUrl, expectedRole, policy)
  const result = spawnSync('/usr/bin/psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...environment }, encoding: 'utf8',
    timeout: 15000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // psql stderr may contain connection material. Never include it in errors.
  requireValue(!result.error && result.status === 0, `${expectedRole.toUpperCase()}_QUERY_FAILED`)
  try { return JSON.parse(result.stdout.trim()) } catch { fail(`${expectedRole.toUpperCase()}_QUERY_INVALID`) }
}

/** Actual production port methods. Call under the same inherited FD 9 lock. */
export function openProductionBridge254RuntimeObserver({ databaseUrl, opsDatabaseUrl, clusterObserverUrl, frozenPrefixes }) {
  protectedProductionLock()
  const policy = frozenDatabaseIdentity()
  requireValue(typeof databaseUrl === 'string' && typeof opsDatabaseUrl === 'string' &&
    typeof clusterObserverUrl === 'string', 'EXPLICIT_DATABASE_URLS_REQUIRED')
  bridge254DatabaseEnvironment(databaseUrl, ROLE.runtime, policy)
  bridge254DatabaseEnvironment(opsDatabaseUrl, ROLE.ops, policy)
  bridge254DatabaseEnvironment(clusterObserverUrl, ROLE.cluster, policy)
  const assertProtectedLock = () => protectedProductionLock()
  const observePrefix = () => {
    assertProtectedLock()
    const runtime = queryRole(databaseUrl, ROLE.runtime, policy, BRIDGE_254_OBSERVE_SQL)
    assertProtectedLock()
    const ops = queryRole(opsDatabaseUrl, ROLE.ops, policy, BRIDGE_254_OBSERVE_SQL)
    assertProtectedLock()
    const cluster = queryRole(clusterObserverUrl, ROLE.cluster, policy, BRIDGE_254_CLUSTER_SQL)
    assertProtectedLock()
    return verifyBridge254ObservedHistories(runtime, ops, cluster, frozenPrefixes, policy)
  }
  return Object.freeze({ assertProtectedLock, observePrefix })
}
