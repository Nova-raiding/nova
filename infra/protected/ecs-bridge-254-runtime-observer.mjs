#!/usr/bin/env node
// Production read-only runtime port for the 242→254 maintenance controller.
// Credentials and the frozen prefix chain must be supplied by its protected
// caller. This module cannot sign a journal, consume a nonce, or mutate Docker.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, constants } from 'node:fs'
import { dirname } from 'node:path'

const LOCK = '/var/lib/merchant-release-security/production-deploy.lock'
const SHA = /^[a-f0-9]{64}$/u
const ROLE = Object.freeze({ runtime: 'merchant_app', ops: 'merchant_ops' })
const fail = message => { throw new Error(`BRIDGE_254_OBSERVER_${message}`) }
const requireValue = (condition, message) => { if (!condition) fail(message) }
const sha = value => createHash('sha256').update(value).digest('hex')

export const BRIDGE_254_OBSERVE_SQL = `SELECT json_build_object(
 'history', coalesce(json_agg(json_build_array(version,name,checksum) ORDER BY version),'[]'::json),
 'invalid_indexes', (
   SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_index i ON i.indexrelid=c.oid
    WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)
 )) FROM schema_migrations`

export function bridge254DatabaseEnvironment(databaseUrl, expectedRole) {
  requireValue(typeof databaseUrl === 'string' && databaseUrl.length > 0 && databaseUrl.length <= 4096, 'DATABASE_URL_INVALID')
  let url
  try { url = new URL(databaseUrl) } catch { fail('DATABASE_URL_INVALID') }
  requireValue(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1
    && !url.hash && !url.searchParams.has('options') && url.searchParams.size === 1
    && url.searchParams.get('sslmode') && ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')),
  'DATABASE_URL_TLS_INVALID')
  requireValue(url.username === expectedRole && url.password && url.pathname === '/merchant'
    && (!url.port || /^\d{1,5}$/u.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535),
  'DATABASE_ROLE_OR_TARGET_INVALID')
  return Object.freeze({ PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: expectedRole,
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: 'merchant', PGSSLMODE: url.searchParams.get('sslmode'),
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

export function verifyBridge254ObservedHistories(runtimeResult, opsResult, frozenPrefixes) {
  requireValue(frozenPrefixes && typeof frozenPrefixes === 'object' &&
    Object.keys(frozenPrefixes).sort().join(',') === Array.from({ length: 13 }, (_, i) => String(242 + i)).sort().join(',') &&
    Object.values(frozenPrefixes).every(value => SHA.test(value)), 'FROZEN_PREFIX_CHAIN_INVALID')
  const parse = (value, label) => {
    requireValue(value && Array.isArray(value.history) && Array.isArray(value.invalid_indexes)
      && value.invalid_indexes.length === 0, `${label}_INVALID_INDEX_OR_RESULT`)
    const rows = value.history
    requireValue(rows.length >= 242 && rows.length <= 254 && rows.every((row, index) =>
      Array.isArray(row) && row.length === 3 && row[0] === index + 1
      && typeof row[1] === 'string' && /^[a-z0-9_]+$/u.test(row[1]) && SHA.test(row[2] ?? '')),
    `${label}_HISTORY_INVALID`)
    return { version: rows.length, history_sha256: sha(rows.map(([version, name, checksum]) =>
      `${version}\t${name}\t${checksum}\n`).join('')) }
  }
  const runtime = parse(runtimeResult, 'RUNTIME'), ops = parse(opsResult, 'OPS')
  requireValue(runtime.version === ops.version && runtime.history_sha256 === ops.history_sha256,
    'RUNTIME_OPS_HISTORY_MISMATCH')
  requireValue(runtime.history_sha256 === frozenPrefixes[String(runtime.version)], 'FROZEN_PREFIX_MISMATCH')
  return Object.freeze({ version: runtime.version, history_sha256: runtime.history_sha256,
    ops_version: ops.version, ops_history_sha256: ops.history_sha256 })
}

function queryRole(databaseUrl, expectedRole) {
  const environment = bridge254DatabaseEnvironment(databaseUrl, expectedRole)
  const result = spawnSync('/usr/bin/psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', BRIDGE_254_OBSERVE_SQL], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...environment }, encoding: 'utf8',
    timeout: 15000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // psql stderr may contain connection material. Never include it in errors.
  requireValue(!result.error && result.status === 0, `${expectedRole.toUpperCase()}_QUERY_FAILED`)
  try { return JSON.parse(result.stdout.trim()) } catch { fail(`${expectedRole.toUpperCase()}_QUERY_INVALID`) }
}

/** Actual production port methods. Call under the same inherited FD 9 lock. */
export function openProductionBridge254RuntimeObserver({ databaseUrl, opsDatabaseUrl, frozenPrefixes }) {
  requireValue(typeof databaseUrl === 'string' && typeof opsDatabaseUrl === 'string', 'EXPLICIT_DATABASE_URLS_REQUIRED')
  bridge254DatabaseEnvironment(databaseUrl, ROLE.runtime)
  bridge254DatabaseEnvironment(opsDatabaseUrl, ROLE.ops)
  const assertProtectedLock = () => protectedProductionLock()
  const observePrefix = () => {
    assertProtectedLock()
    const runtime = queryRole(databaseUrl, ROLE.runtime)
    assertProtectedLock()
    const ops = queryRole(opsDatabaseUrl, ROLE.ops)
    assertProtectedLock()
    return verifyBridge254ObservedHistories(runtime, ops, frozenPrefixes)
  }
  return Object.freeze({ assertProtectedLock, observePrefix })
}
