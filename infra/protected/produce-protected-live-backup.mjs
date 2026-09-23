// Operator-only: inspect the existing production source; on explicit create,
// bind its reviewed identity and invoke the installed protected backup process.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const ATTESTER_TIMEOUT_MS = 6 * 60 * 60_000 + 60_000

function hashRegularFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    assert(stat.isFile() && stat.size > 0, 'protected backup must be a nonempty regular file')
    const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024)
    let total = 0, count
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) { digest.update(chunk.subarray(0, count)); total += count }
    assert(total === stat.size, 'protected backup changed while hashing')
    return { sha256: digest.digest('hex'), bytes: total }
  } finally { closeSync(fd) }
}

function protect(path) {
  assert.equal(realpathSync(path), path)
  for (let cur = path;; cur = dirname(cur)) {
    const stat = lstatSync(cur)
    assert(stat.uid === 0 && !stat.isSymbolicLink() && !(stat.mode & 0o022))
    if (cur === '/') break
  }
}

function durableExclusive(path, bytes, mode) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function verifyProducedBackupV2(document, backupSha256, backupName, policy, migrationVersion, publicPem, keyId, now = new Date()) {
  assert(document?.schema_version === '2' && document.kind === 'postgres_backup' && document.environment === 'production' && document.simulated === false, 'protected backup must be production schema v2')
  assert(/^[a-f0-9]{64}$/.test(backupSha256) && document.backup_file_name === backupName && document.backup_sha256 === backupSha256, 'protected backup does not match signed dump identity')
  assert(document.source_database_id_sha256 === policy.system_identifier_sha256 && document.source_database_oid === policy.database_oid && document.source_database_name === policy.database_name, 'protected backup does not match reviewed source')
  assert(document.migration_version === migrationVersion && document.key_id === keyId, 'protected backup does not match reviewed migration/key identity')
  assert(/^[a-f0-9]{64}$/.test(document.snapshot_id_sha256 ?? ''), 'protected backup snapshot identity is missing')
  const strictUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  const times = ['backup_started_at', 'snapshot_export_observed_at', 'dump_completed_at', 'expires_at'].map(field => {
    assert(strictUtc.test(document[field] ?? '') && Number.isFinite(Date.parse(document[field])), `protected backup ${field} is invalid`)
    return Date.parse(document[field])
  })
  assert(document.created_at === document.backup_started_at && times[0] <= times[1] && times[1] <= times[2] && times[2] <= now.getTime() + 300_000 && times[2] < times[3] && times[3] <= times[2] + 24 * 60 * 60_000 && times[3] > now.getTime(), 'protected backup signed chronology is invalid or expired')
  assert(typeof document.signature_base64 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(document.signature_base64), 'protected backup signature is malformed')
  const publicKey = createPublicKey(publicPem)
  assert(publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(document)), publicKey, Buffer.from(document.signature_base64, 'base64')), 'protected backup signature is invalid')
}

function main() {
const expectedMigrationVersion = Number(process.env.EXPECTED_MIGRATION_VERSION ?? '')
assert(Number.isSafeInteger(expectedMigrationVersion) && expectedMigrationVersion > 0, 'EXPECTED_MIGRATION_VERSION must be a positive integer')
const postgresContainer = process.env.PRODUCTION_POSTGRES_CONTAINER ?? ''
assert(/^merchant-production-postgres-[1-9][0-9]*$/.test(postgresContainer), 'PRODUCTION_POSTGRES_CONTAINER must identify the reviewed production PostgreSQL container')
const releaseId = process.env.RELEASE_ID ?? ''
assert(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseId), 'RELEASE_ID must identify the reviewed release')
const attemptId = process.env.BACKUP_ATTEMPT_ID ?? ''
assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(attemptId), 'BACKUP_ATTEMPT_ID must identify this immutable backup attempt')
const policyPath = `/run/release-security/evidence-trust/production-backup-source-${releaseId}.json`
const outputRoot = `/var/lib/merchant-release-security/backups/${releaseId}-${attemptId}`
assert.equal(process.getuid(), 0)
const mode = process.argv[2]
assert(['inspect', 'create'].includes(mode))
for (const path of [fileURLToPath(import.meta.url), '/usr/bin/docker', '/usr/pgsql-16/bin/psql', dirname(policyPath), '/var/lib/merchant-release-security/backups']) protect(path)
const inspected = JSON.parse(execFileSync('/usr/bin/docker', ['inspect', postgresContainer], { encoding: 'utf8', env: {} }))[0]
assert(inspected?.State?.Running === true && inspected.Config.Image && inspected.Id)
const config = Object.fromEntries(inspected.Config.Env.map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
const networks = Object.values(inspected.NetworkSettings.Networks).map(value => value.IPAddress).filter(Boolean)
assert(networks.length === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(networks[0]))
assert(config.POSTGRES_USER && config.POSTGRES_DB && config.POSTGRES_PASSWORD, 'source database credentials unavailable')
const pg = { PGHOST: networks[0], PGPORT: '5432', PGDATABASE: config.POSTGRES_DB, PGUSER: config.POSTGRES_USER, PGPASSWORD: config.POSTGRES_PASSWORD, PGCONNECT_TIMEOUT: '10' }
const query = "SELECT json_build_object('system_identifier',system_identifier::text,'database_oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'database_name',current_database(),'migration_version',(SELECT max(version) FROM public.schema_migrations),'server_version_num',current_setting('server_version_num')) FROM pg_control_system();"
let value
try { value = JSON.parse(execFileSync('/usr/pgsql-16/bin/psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8', env: pg, stdio: ['ignore', 'pipe', 'pipe'] })) }
catch { throw new Error('production source identity query failed; credentials withheld') }
assert.equal(value.migration_version, expectedMigrationVersion, `production source migration version does not match EXPECTED_MIGRATION_VERSION=${expectedMigrationVersion}`)
assert(Number(value.server_version_num) >= 160000 && Number(value.server_version_num) < 170000)
const policy = { system_identifier_sha256: hash(value.system_identifier), database_oid: Number(value.database_oid), database_name: value.database_name }
assert(Number.isInteger(policy.database_oid) && policy.database_oid > 0)
const policyBytes = Buffer.from(`${JSON.stringify(policy)}\n`)
const policySha = hash(policyBytes)
if (mode === 'inspect') {
  console.log(JSON.stringify({ ...policy, policy_sha256: policySha, migration_version: value.migration_version, server_version_num: value.server_version_num }))
} else {
  assert.equal(process.argv.length, 4)
  assert.equal(process.argv[3], policySha, 'source differs from owner-reviewed policy')
  if (existsSync(policyPath)) { protect(policyPath); assert(readFileSync(policyPath).equals(policyBytes), 'existing source policy differs; refusing replacement') }
  else durableExclusive(policyPath, policyBytes, 0o444)
  assert(!existsSync(outputRoot), 'backup attempt already exists; refusing overwrite')
  mkdirSync(outputRoot, { mode: 0o700 }); protect(outputRoot)
  const backup = `${outputRoot}/before-upgrade-${expectedMigrationVersion}.dump`
  const result = spawnSync('/usr/local/libexec/merchant/attest-postgres-backup', ['create', '--backup', backup, '--checksum', `${backup}.sha256`, '--attestation', `${backup}.attestation.json`, '--source-policy', policyPath], { encoding: 'utf8', env: { ...pg, NODE_ENV: 'production' }, timeout: ATTESTER_TIMEOUT_MS })
  if (result.status !== 0) throw new Error('protected backup failed; inspect protected host diagnostics without exposing credentials')
  const publicPath = '/run/release-security/evidence-trust/production-evidence-public.pem'
  const keyIdPath = '/run/release-security/evidence-trust/production-evidence-key-id'
  for (const path of [backup, `${backup}.sha256`, `${backup}.attestation.json`, publicPath, keyIdPath]) protect(path)
  const backupDigest = hashRegularFile(backup)
  const document = JSON.parse(readFileSync(`${backup}.attestation.json`, 'utf8'))
  verifyProducedBackupV2(document, backupDigest.sha256, basename(backup), policy, expectedMigrationVersion, readFileSync(publicPath), readFileSync(keyIdPath, 'utf8').trim())
  assert(readFileSync(`${backup}.sha256`, 'utf8') === `${document.backup_sha256}  ${backup}\n`, 'protected backup checksum sidecar does not match signed dump')
  console.log(JSON.stringify({ backup, bytes: backupDigest.bytes, sha256: document.backup_sha256, source_policy_sha256: policySha, schema_version: '2', snapshot_id_sha256: document.snapshot_id_sha256, database_mutations: false }))
}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
