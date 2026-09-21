#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Install as a root-owned, digest-pinned executable outside the repository.
// This process owns pg_dump, the exported snapshot and the production key.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRUST_ROOT = '/run/release-security/evidence-trust'
const PRIVATE_KEY = '/var/lib/merchant-release-security/production-capability-private.pem'
const SOURCE_POLICY = join(TRUST_ROOT, 'production-backup-source.json')
const BACKUP_ROOT = '/var/lib/merchant-release-security/backups'
const INSTALLED_PATH = '/usr/local/libexec/merchant/attest-postgres-backup'
const INSTALLED_DIGEST = join(TRUST_ROOT, 'production-backup-attester-sha256')
const PSQL = '/usr/pgsql-16/bin/psql'
const PG_DUMP = '/usr/pgsql-16/bin/pg_dump'
const MAX_VALIDITY_SECONDS = 24 * 60 * 60
const MAX_CAPTURE_BYTES = 16 * 1024
const SNAPSHOT_TIMEOUT_MS = 30_000
const DUMP_TIMEOUT_MS = 6 * 60 * 60_000
const HEX = /^[a-f0-9]{64}$/u
const SNAPSHOT = /^[A-Za-z0-9:-]{1,256}$/u
const FORWARDED_PG_ENV = new Set(['PGAPPNAME', 'PGCHANNELBINDING', 'PGCONNECT_TIMEOUT', 'PGDATABASE', 'PGHOST', 'PGHOSTADDR', 'PGPASSWORD', 'PGPORT', 'PGREQUIRESSL', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGTARGETSESSIONATTRS', 'PGUSER'])

function assert(value, message) { if (!value) throw new Error(message) }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function readRegular(path, maxBytes = 8192) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const stat = fstatSync(fd); assert(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'unsafe protected input'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
function syncPath(path, flags = constants.O_RDONLY) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function syncParent(path) { syncPath(dirname(path)) }
function atomicExclusive(path, bytes) {
  const temp = `${path}.${process.pid}.tmp`, old = process.umask(0o077)
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    syncPath(temp)
    linkSync(temp, path)
    syncParent(path)
  }
  finally { try { unlinkSync(temp) } catch {} process.umask(old) }
}
function assertProtectedPath(path, { kind, mode } = {}) {
  const absolute = resolve(path)
  assert(path === absolute && realpathSync(path) === absolute, 'protected path must be absolute and canonical')
  const { root } = parse(absolute)
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    assert(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, `untrusted protected path component: ${current}`)
  }
  const stat = lstatSync(absolute)
  if (kind === 'file') assert(stat.isFile(), 'protected path must be a regular file')
  if (kind === 'directory') assert(stat.isDirectory(), 'protected path must be a directory')
  if (mode !== undefined) assert((stat.mode & 0o777) === mode, `protected file mode must be ${mode.toString(8)}`)
  return stat
}
function protectedOutput(path) {
  assert(path === resolve(path), 'output path must be absolute')
  const parent = realpathSync(dirname(path))
  assert(parent === BACKUP_ROOT || parent.startsWith(`${BACKUP_ROOT}${sep}`), 'output must be inside the protected backup root')
  assertProtectedPath(BACKUP_ROOT, { kind: 'directory' })
  assertProtectedPath(parent, { kind: 'directory' })
  assert(resolve(path) === join(parent, basename(path)), 'output path must be a direct child of the protected root')
  try { lstatSync(path); throw new Error('output already exists') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  return parent
}
export function createProtectedEnvironment(source = process.env) {
  const env = { PATH: '/usr/bin:/bin', NODE_OPTIONS: '' }
  for (const name of FORWARDED_PG_ENV) if (typeof source[name] === 'string') env[name] = source[name]
  return env
}
function assertInstalledIdentity() {
  const invoked = realpathSync(process.argv[1])
  assert(invoked === INSTALLED_PATH, 'protected backup attester must run from its fixed installed path')
  assertProtectedPath(invoked, { kind: 'file' })
  assertProtectedPath(PSQL, { kind: 'file' })
  assertProtectedPath(PG_DUMP, { kind: 'file' })
  assertProtectedPath(process.execPath, { kind: 'file' })
  assertProtectedPath(INSTALLED_DIGEST, { kind: 'file' })
  const expected = readRegular(INSTALLED_DIGEST, 128).toString('utf8').trim()
  assert(HEX.test(expected) && createHash('sha256').update(readRegular(invoked, 4 * 1024 * 1024)).digest('hex') === expected, 'installed attester digest mismatch')
}

export const SNAPSHOT_SQL = [
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;',
  "SELECT 'SYSTEM_IDENTIFIER=' || system_identifier FROM pg_control_system();",
  "SELECT 'DATABASE_OID=' || oid::text FROM pg_database WHERE datname = current_database();",
  "SELECT 'DATABASE_NAME_HEX=' || encode(convert_to(current_database(),'UTF8'),'hex');",
  "SELECT 'MIGRATION_VERSION=' || COALESCE(max(version),0)::text FROM public.schema_migrations;",
  "SELECT 'SNAPSHOT=' || pg_export_snapshot();",
]
export function pgDumpArguments(snapshot, output) {
  assert(SNAPSHOT.test(snapshot), 'exported snapshot is invalid')
  return ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, `--file=${output}`]
}

export function parseSourcePolicy(bytes) {
  let value
  try { value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes) } catch { throw new Error('backup source policy must be valid JSON') }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'backup source policy must be an object')
  assert(Object.keys(value).sort().join(',') === 'database_name,database_oid,system_identifier_sha256', 'backup source policy fields are invalid')
  assert(HEX.test(value.system_identifier_sha256), 'backup source policy system identifier hash is invalid')
  assert(Number.isInteger(value.database_oid) && value.database_oid > 0 && value.database_oid <= 4_294_967_295, 'backup source policy database OID is invalid')
  assert(typeof value.database_name === 'string' && value.database_name.length > 0 && Buffer.byteLength(value.database_name, 'utf8') <= 63 && !value.database_name.includes('\0'), 'backup source policy database name is invalid')
  return value
}
export function assertSourcePolicy({ systemIdentifier, databaseOid, databaseName }, policy) {
  const clusterHash = createHash('sha256').update(systemIdentifier).digest('hex')
  assert(clusterHash === policy.system_identifier_sha256, 'database cluster does not match protected source policy')
  assert(databaseOid === policy.database_oid, 'database OID does not match protected source policy')
  assert(databaseName === policy.database_name, 'database name does not match protected source policy')
  return clusterHash
}

export function signBackupAttestation({ backupBytes, backupFileName, systemIdentifier, databaseOid, databaseName, migrationVersion, keyId, privatePem, publicPem, now = new Date(), validitySeconds = MAX_VALIDITY_SECONDS }) {
  assert(Buffer.isBuffer(backupBytes) && backupBytes.length > 0, 'backup bytes are required')
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(backupFileName), 'backup file name is invalid')
  assert(/^\d{1,32}$/u.test(systemIdentifier), 'database system identifier is invalid')
  assert(Number.isInteger(databaseOid) && databaseOid > 0 && databaseOid <= 4_294_967_295, 'database OID is invalid')
  assert(typeof databaseName === 'string' && databaseName.length > 0 && Buffer.byteLength(databaseName, 'utf8') <= 63 && !databaseName.includes('\0'), 'database name is invalid')
  assert(Number.isSafeInteger(migrationVersion) && migrationVersion > 0, 'migration version is invalid')
  assert(/^[A-Za-z0-9._:-]{1,128}$/u.test(keyId), 'trusted key ID is invalid')
  assert(Number.isSafeInteger(validitySeconds) && validitySeconds > 0 && validitySeconds <= MAX_VALIDITY_SECONDS, 'attestation validity exceeds the protected maximum')
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519', 'trust keys must be Ed25519')
  assert(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'protected private key does not match trust anchor')
  const value = {
    schema_version: '1', kind: 'postgres_backup', environment: 'production', simulated: false,
    backup_file_name: backupFileName,
    backup_sha256: createHash('sha256').update(backupBytes).digest('hex'),
    source_database_id_sha256: createHash('sha256').update(systemIdentifier).digest('hex'),
    source_database_oid: databaseOid,
    source_database_name: databaseName,
    migration_version: migrationVersion,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + validitySeconds * 1000).toISOString(), key_id: keyId,
  }
  const payload = Buffer.from(canonical(value))
  value.signature_base64 = sign(null, payload, privateKey).toString('base64')
  assert(verify(null, payload, publicKey, Buffer.from(value.signature_base64, 'base64')), 'self-verification failed')
  return value
}

export function captureSnapshot() {
  return new Promise((resolveSnapshot, rejectSnapshot) => {
    const child = spawn(PSQL, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], env: createProtectedEnvironment() })
    let stdout = '', stderrBytes = 0, settled = false
    const timer = setTimeout(() => finish(new Error('database snapshot capture timed out')), SNAPSHOT_TIMEOUT_MS)
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGTERM'); rejectSnapshot(error) } }
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_CAPTURE_BYTES) finish(new Error('database snapshot command produced excessive diagnostics')) })
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) return finish(new Error('database snapshot metadata exceeded limit'))
      const system = /(?:^|\n)SYSTEM_IDENTIFIER=(\d{1,32})(?:\n|$)/u.exec(stdout)?.[1]
      const databaseOidText = /(?:^|\n)DATABASE_OID=(\d{1,10})(?:\n|$)/u.exec(stdout)?.[1]
      const databaseNameHex = /(?:^|\n)DATABASE_NAME_HEX=([a-f0-9]{2,126})(?:\n|$)/u.exec(stdout)?.[1]
      const migration = /(?:^|\n)MIGRATION_VERSION=(\d+)(?:\n|$)/u.exec(stdout)?.[1]
      const snapshot = /(?:^|\n)SNAPSHOT=([^\n]+)(?:\n|$)/u.exec(stdout)?.[1]
      if (system && databaseOidText && databaseNameHex && migration && snapshot && SNAPSHOT.test(snapshot)) {
        const databaseName = Buffer.from(databaseNameHex, 'hex').toString('utf8'), databaseOid = Number(databaseOidText)
        if (Buffer.from(databaseName, 'utf8').toString('hex') !== databaseNameHex || !Number.isInteger(databaseOid) || databaseOid <= 0 || databaseOid > 4_294_967_295) return finish(new Error('database snapshot identity is invalid'))
        settled = true; clearTimeout(timer)
        resolveSnapshot({ systemIdentifier: system, databaseOid, databaseName, migrationVersion: Number(migration), snapshot, release: () => { if (!child.stdin.destroyed) child.stdin.end('ROLLBACK;\n\\q\n') } })
      }
    })
    child.on('error', finish)
    child.stdin.on('error', finish)
    child.on('exit', code => { if (!settled) finish(new Error(`database snapshot transaction exited before export (${code ?? 'signal'})`)) })
    for (const statement of SNAPSHOT_SQL) child.stdin.write(`${statement}\n`)
  })
}

function realDump(snapshot, path) {
  return new Promise((resolveDump, rejectDump) => {
    const child = spawn(PG_DUMP, pgDumpArguments(snapshot, path), { stdio: ['ignore', 'ignore', 'pipe'], env: createProtectedEnvironment() })
    let stderrBytes = 0
    const timer = setTimeout(() => { child.kill('SIGTERM'); rejectDump(new Error('pg_dump timed out')) }, DUMP_TIMEOUT_MS)
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_CAPTURE_BYTES) child.kill('SIGTERM') })
    child.on('error', error => { clearTimeout(timer); rejectDump(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveDump() : rejectDump(new Error('pg_dump failed')) })
  })
}

export async function produceBackup({ backupPath, attestationPath, checksumPath = `${backupPath}.sha256`, validitySeconds = MAX_VALIDITY_SECONDS, now = new Date(), privatePem, publicPem, keyId, sourcePolicy }, adapter = { snapshot: captureSnapshot, dump: realDump }) {
  assert(new Set([resolve(backupPath), resolve(attestationPath), resolve(checksumPath)]).size === 3, 'backup outputs must be distinct')
  const tempBackup = `${backupPath}.${process.pid}.${randomBytes(12).toString('hex')}.dump.tmp`
  try { lstatSync(tempBackup); throw new Error('temporary backup path already exists') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  let held
  try {
    held = await adapter.snapshot()
    assertSourcePolicy(held, sourcePolicy)
    await adapter.dump(held.snapshot, tempBackup)
    syncPath(tempBackup)
    const bytes = readRegular(tempBackup, Number.MAX_SAFE_INTEGER)
    const document = signBackupAttestation({ backupBytes: bytes, backupFileName: basename(backupPath), systemIdentifier: held.systemIdentifier, databaseOid: held.databaseOid, databaseName: held.databaseName, migrationVersion: held.migrationVersion, keyId, privatePem, publicPem, now, validitySeconds })
    linkSync(tempBackup, backupPath)
    syncParent(backupPath)
    atomicExclusive(checksumPath, Buffer.from(`${document.backup_sha256}  ${backupPath}\n`))
    atomicExclusive(attestationPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`))
    return document
  } finally { held?.release?.(); try { unlinkSync(tempBackup) } catch {} }
}

export function parseCreateArguments(args) {
  assert(args[0] === 'create', 'create subcommand required')
  const allowed = new Set(['--backup', '--checksum', '--attestation']), values = new Map()
  assert((args.length - 1) % 2 === 0, 'every option requires exactly one value')
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    assert(allowed.has(name), `unknown option: ${name}`)
    assert(!values.has(name), `duplicate option: ${name}`)
    assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `missing value for ${name}`)
    values.set(name, value)
  }
  for (const name of allowed) assert(values.has(name), `${name} is required`)
  return { backupPath: values.get('--backup'), checksumPath: values.get('--checksum'), attestationPath: values.get('--attestation') }
}

async function main(args) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'protected backup attester must run as root')
  assertInstalledIdentity()
  assert(process.env.NODE_ENV === 'production' && process.env.VITEST !== 'true' && !/(?:mock|fixture|test)/iu.test(process.env.BACKUP_ATTESTATION_MODE ?? ''), 'mock/test production attestation is forbidden')
  const { backupPath, attestationPath, checksumPath } = parseCreateArguments(args)
  assert(new Set([resolve(backupPath), resolve(attestationPath), resolve(checksumPath)]).size === 3, 'backup outputs must be distinct')
  protectedOutput(backupPath); protectedOutput(checksumPath); protectedOutput(attestationPath)
  for (const name of ['PGHOST','PGDATABASE','PGUSER']) assert(process.env[name]?.trim(), `${name} is required`)
  const keyIdPath = join(TRUST_ROOT, 'production-evidence-key-id'), publicKeyPath = join(TRUST_ROOT, 'production-evidence-public.pem')
  assertProtectedPath(PRIVATE_KEY, { kind: 'file', mode: 0o600 })
  assertProtectedPath(keyIdPath, { kind: 'file' })
  assertProtectedPath(publicKeyPath, { kind: 'file' })
  assertProtectedPath(SOURCE_POLICY, { kind: 'file' })
  const keyId = readRegular(keyIdPath, 128).toString('utf8').trim()
  const privatePem = readRegular(PRIVATE_KEY), publicPem = readRegular(publicKeyPath)
  const sourcePolicy = parseSourcePolicy(readRegular(SOURCE_POLICY))
  const old = process.umask(0o077)
  try { await produceBackup({ backupPath, checksumPath, attestationPath, privatePem, publicPem, keyId, sourcePolicy }) }
  finally { process.umask(old) }
  process.stdout.write(`protected postgres backup written: ${basename(backupPath)}\n`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`backup attestation rejected: ${error.message}\n`); process.exitCode = 1 })
}
