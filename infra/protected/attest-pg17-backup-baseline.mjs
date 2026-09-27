#!/usr/bin/env node
// Fixed-install, root-only candidate. Produces a signed PG16 backup plus raw
// same-snapshot rowset baseline; it never signs final PG17 restore evidence.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { bindReviewOnlyBaseline } from './review-only-pg17-snapshot-baseline.mjs'
import { reviewOnlyPreSignSnapshotCheck } from './review-only-pg17-frozen-plan-preflight.mjs'
import { digestSortedPgRows } from './pg17-streamed-rowset.mjs'
import { captureSnapshot, createProtectedEnvironment, pgDumpArguments, produceBackup } from './attest-postgres-backup.mjs'

const INSTALLED = '/usr/local/libexec/merchant/attest-pg17-backup-baseline'
const DIGEST = '/run/release-security/evidence-trust/production-pg17-baseline-backup-sha256'
const TRUST = '/run/release-security/evidence-trust'
const STATE = '/var/lib/merchant-release-security'
const RELEASES = '/srv/merchant-releases'
const HEX = /^[a-f0-9]{64}$/u
const RELEASE = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u
const MAX_ROWS_PER_TABLE = 1_000_000
const DOCKER_SOCKET = 'unix:///var/run/docker.sock'
const PRODUCTION_POSTGRES = 'merchant-production-postgres-1'
const BACKUP_WALL_CLOCK_MS = 30 * 60_000
const DUMP_TIMEOUT_MS = 15 * 60_000
const STATEMENT_TIMEOUT_MS = 60_000
const check = (condition, message) => { if (!condition) throw new Error(message) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function protectedPath(path, mode, maxBytes = 8 * 1024 * 1024) {
  check(path === resolve(path) && realpathSync(path) === path, 'protected path must be canonical')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const st = lstatSync(cursor)
    check(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'untrusted protected path')
    if (cursor === '/') break
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const st = fstatSync(fd); check(st.isFile() && st.size > 0 && st.size <= maxBytes && (mode === undefined || (st.mode & 0o777) === mode), 'protected file invalid'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
function protectedDirectory(path) {
  check(path === resolve(path) && realpathSync(path) === path, 'protected directory must be canonical')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const st = lstatSync(cursor)
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'untrusted protected directory')
    if (cursor === '/') break
  }
}
function options(args) {
  const required = ['--release-id', '--git-sha', '--attempt-id', '--approved-plan-sha256', '--max-rows-per-table']
  check(args.length === required.length * 2, 'exact PG17 baseline backup arguments required')
  const out = {}
  for (let i = 0; i < args.length; i += 2) { check(required.includes(args[i]) && !Object.hasOwn(out, args[i]) && args[i + 1], 'unknown or duplicate argument'); out[args[i]] = args[i + 1] }
  check(required.every(name => out[name]) && RELEASE.test(out['--release-id']) && /^[a-f0-9]{40}$/u.test(out['--git-sha']) && ATTEMPT.test(out['--attempt-id']) && HEX.test(out['--approved-plan-sha256']), 'release or plan binding invalid')
  const maxRows = Number(out['--max-rows-per-table'])
  check(Number.isSafeInteger(maxRows) && maxRows > 0 && maxRows <= MAX_ROWS_PER_TABLE, 'reviewed row bound invalid')
  return { releaseId: out['--release-id'], gitSha: out['--git-sha'], attemptId: out['--attempt-id'], planSha: out['--approved-plan-sha256'], maxRows }
}
function candidateIdentity(releaseId, gitSha) {
  const file = join(RELEASES, releaseId, '.candidate-identity')
  const values = Object.fromEntries(protectedPath(file).toString('utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  check(values.release_id === releaseId && values.git_sha === gitSha && /^sha256:[a-f0-9]{64}$/u.test(values.source_sha256 ?? ''), 'candidate archive identity mismatch')
}
function assertInstalled() {
  check(process.getuid?.() === 0 && process.geteuid?.() === 0 && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'protected root runtime required')
  check(realpathSync(process.argv[1]) === INSTALLED, 'PG17 baseline backup must run from fixed installed path')
  const expected = protectedPath(DIGEST).toString('utf8').trim()
  check(HEX.test(expected) && sha(protectedPath(INSTALLED)) === expected, 'installed PG17 baseline backup digest mismatch')
  protectedPath(process.execPath, undefined, 256 * 1024 * 1024)
  protectedPath('/usr/bin/docker', undefined, 64 * 1024 * 1024)
  protectedPath('/usr/pgsql-16/bin/psql')
  protectedPath('/usr/pgsql-16/bin/pg_dump')
}
export function assertLocalDockerTarget(environment = process.env) {
  check(!environment.DOCKER_CONTEXT && !environment.DOCKER_CONFIG
    && (!environment.DOCKER_HOST || environment.DOCKER_HOST === DOCKER_SOCKET), 'remote or user-configured Docker target is forbidden')
}
export function validateProductionPostgresInspection(value) {
  check(value?.Name === `/${PRODUCTION_POSTGRES}`
    && value?.State?.Running === true
    && /^[a-f0-9]{64}$/u.test(value.Id ?? '')
    && /(?:^|\/)postgres:16(?:[-@]|$)/u.test(value.Config?.Image ?? '')
    && value.Config?.Labels?.['com.docker.compose.project'] === 'merchant-production'
    && value.Config?.Labels?.['com.docker.compose.service'] === 'postgres', 'reviewed production PG16 container identity mismatch')
  const networks = Object.entries(value.NetworkSettings?.Networks ?? {})
  check(networks.length === 1 && networks[0][0] === 'merchant-production_default'
    && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(networks[0][1]?.IPAddress ?? ''), 'production Postgres network ambiguous')
  return { networkHost: networks[0][1].IPAddress, environment: value.Config.Env ?? [] }
}
export function inspectProductionPostgres({ run = execFileSync, environment = process.env } = {}) {
  assertLocalDockerTarget(environment)
  const raw = run('/usr/bin/docker', ['--host', DOCKER_SOCKET, 'inspect', PRODUCTION_POSTGRES], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_HOST: DOCKER_SOCKET }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  })
  const result = JSON.parse(raw)
  check(Array.isArray(result) && result.length === 1, 'reviewed production PG16 container unavailable')
  return validateProductionPostgresInspection(result[0])
}
function configureLiveSource() {
  const source = inspectProductionPostgres()
  const config = Object.fromEntries(source.environment.map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  const networks = [source.networkHost]
  check(config.POSTGRES_DB && config.POSTGRES_USER && config.POSTGRES_PASSWORD, 'production database credentials unavailable')
  for (const key of Object.keys(process.env)) if (key.startsWith('PG')) delete process.env[key]
  Object.assign(process.env, { PGHOST: networks[0], PGPORT: '5432', PGDATABASE: config.POSTGRES_DB, PGUSER: config.POSTGRES_USER, PGPASSWORD: config.POSTGRES_PASSWORD, PGCONNECT_TIMEOUT: '10', NODE_ENV: 'production' })
}
function dump(snapshot, path) {
  return new Promise((resolveDump, rejectDump) => {
    const child = spawn('/usr/pgsql-16/bin/pg_dump', pgDumpArguments(snapshot, path), { stdio: ['ignore', 'ignore', 'pipe'], env: createProtectedEnvironment() })
    let errorBytes = 0
    const timeout = setTimeout(() => { child.kill('SIGTERM'); rejectDump(new Error('protected pg_dump timed out')) }, DUMP_TIMEOUT_MS)
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 64 * 1024) child.kill('SIGTERM') })
    child.on('error', error => { clearTimeout(timeout); rejectDump(error) })
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolveDump() : rejectDump(new Error('protected pg_dump failed')) })
  })
}
function connectSource() {
  const env = process.env
  check(env.PGHOST && env.PGUSER && env.PGDATABASE && env.PGPASSWORD && env.PGPORT === '5432', 'protected PostgreSQL connection is incomplete')
  const client = new pg.Client({ host: env.PGHOST, port: 5432, user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, connectionTimeoutMillis: 10_000, statement_timeout: STATEMENT_TIMEOUT_MS })
  return client.connect().then(() => client)
}
export function backupAttemptDirectoryName(releaseId, attemptId) {
  check(RELEASE.test(releaseId ?? '') && ATTEMPT.test(attemptId ?? ''), 'backup attempt identity invalid')
  return `${releaseId}-attempt-${attemptId}`
}
export async function runProtectedPg17BaselineBackup(args) {
  assertInstalled()
  const deadlineAt = Date.now() + BACKUP_WALL_CLOCK_MS
  const { releaseId, gitSha, attemptId, planSha, maxRows } = options(args)
  candidateIdentity(releaseId, gitSha)
  configureLiveSource()
  const sourcePolicyPath = join(TRUST, `production-backup-source-${releaseId}.json`)
  const sourcePolicyBytes = protectedPath(sourcePolicyPath, 0o444)
  const sourcePolicy = JSON.parse(sourcePolicyBytes.toString('utf8'))
  const planPath = join(STATE, 'pg17-plans', `${releaseId}-${attemptId}.json`)
  const planBytes = protectedPath(planPath, 0o600)
  check(sha(planBytes) === planSha, 'approved signed plan bytes changed')
  const publicPem = protectedPath(join(TRUST, 'production-evidence-public.pem'), 0o444)
  const keyId = protectedPath(join(TRUST, 'production-evidence-key-id')).toString('utf8').trim()
  const privatePem = protectedPath(join(STATE, 'production-capability-private.pem'), 0o600)
  // The installed PG17 isolated restore runner accepts release-attempt-* only.
  const outputRoot = join(STATE, 'backups', backupAttemptDirectoryName(releaseId, attemptId))
  protectedDirectory(join(STATE, 'backups'))
  mkdirSync(outputRoot, { mode: 0o700 })
  protectedDirectory(outputRoot)
  const backupPath = join(outputRoot, 'before-upgrade-242.dump')
  const attestationPath = `${backupPath}.attestation.json`
  let bound
  const adapter = {
    snapshot: captureSnapshot,
    dump,
    reviewOnlyObserveSnapshot: (snapshot, identity) => reviewOnlyPreSignSnapshotCheck({ snapshot, identity, connect: connectSource, streamRows: digestSortedPgRows, maxRowsPerTable: maxRows, deadlineAt, planBytes, sourcePolicyBytes, trustedPublicKey: publicPem, trustedKeyId: keyId, expectedReleaseId: releaseId, expectedGitSha: gitSha, expectedMigrationVersion: 242 }),
    reviewOnlyBindBackup: async (observation, signedBackup) => { bound = { ...bindReviewOnlyBaseline(observation.observation, signedBackup), signed_plan_sha256: observation.plan_sha256, source_policy_sha256: observation.source_policy_sha256, release_id: releaseId, release_git_sha: gitSha } },
  }
  const document = await produceBackup({ backupPath, attestationPath, privatePem, publicPem, keyId, sourcePolicy }, adapter)
  check(bound && bound.backup_sha256 === document.backup_sha256, 'same-snapshot baseline was not bound to backup')
  const baselinePath = join(outputRoot, 'before-upgrade-242.rowset-review.json')
  writeFileSync(baselinePath, `${JSON.stringify(bound, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ status: 'raw_backup_and_baseline_captured', release_id: releaseId, backup_sha256: document.backup_sha256, baseline_sha256: sha(protectedPath(baselinePath, 0o600)), final_production_evidence: false }) + '\n')
}
if (process.argv[1] && basename(process.argv[1]) === 'attest-pg17-backup-baseline' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runProtectedPg17BaselineBackup(process.argv.slice(2)).catch(error => { process.stderr.write(`PG17 baseline backup rejected: ${error.message}\n`); process.exitCode = 1 })
}
