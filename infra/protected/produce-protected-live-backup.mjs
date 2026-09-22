// Operator-only: inspect the existing production source; on explicit create,
// bind its reviewed identity and invoke the installed protected backup process.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import assert from 'node:assert/strict'

const hash = value => createHash('sha256').update(value).digest('hex')
const expectedMigrationVersion = Number(process.env.EXPECTED_MIGRATION_VERSION ?? '')
assert(Number.isSafeInteger(expectedMigrationVersion) && expectedMigrationVersion > 0, 'EXPECTED_MIGRATION_VERSION must be a positive integer')
const postgresContainer = process.env.PRODUCTION_POSTGRES_CONTAINER ?? ''
assert(/^merchant-production-postgres-[1-9][0-9]*$/.test(postgresContainer), 'PRODUCTION_POSTGRES_CONTAINER must identify the reviewed production PostgreSQL container')
const releaseId = process.env.RELEASE_ID ?? ''
assert(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseId), 'RELEASE_ID must identify the reviewed release')
const policyPath = `/run/release-security/evidence-trust/production-backup-source-${releaseId}.json`
const outputRoot = `/var/lib/merchant-release-security/backups/${releaseId}`

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

assert.equal(process.getuid(), 0)
const mode = process.argv[2]
assert(['inspect', 'create'].includes(mode))
for (const path of ['/usr/bin/docker', '/usr/pgsql-16/bin/psql', dirname(policyPath), '/var/lib/merchant-release-security/backups']) protect(path)
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
  const result = spawnSync('/usr/local/libexec/merchant/attest-postgres-backup', ['create', '--backup', backup, '--checksum', `${backup}.sha256`, '--attestation', `${backup}.attestation.json`], { encoding: 'utf8', env: { ...pg, NODE_ENV: 'production' }, timeout: 300_000 })
  if (result.status !== 0) throw new Error('protected backup failed; inspect protected host diagnostics without exposing credentials')
  console.log(JSON.stringify({ backup, bytes: lstatSync(backup).size, sha256: hash(readFileSync(backup)), source_policy_sha256: policySha, database_mutations: false }))
}
