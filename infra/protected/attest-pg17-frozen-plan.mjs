#!/usr/bin/env node
// Fixed-install catalog inspector. Plan signing remains disabled until an
// independent approval source is provisioned; caller-supplied digests are not approval.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { collectFrozenPlanCatalog } from './pg17-frozen-plan-catalog.mjs'
import { reviewOnlyVerifyFrozenPlan } from './review-only-pg17-frozen-plan-preflight.mjs'

const INSTALLED = '/usr/local/libexec/merchant/attest-pg17-frozen-plan'
const DIGEST = '/run/release-security/evidence-trust/production-pg17-plan-signer-sha256'
const TRUST = '/run/release-security/evidence-trust'
const STATE = '/var/lib/merchant-release-security'
const RELEASES = '/srv/merchant-releases'
const HEX = /^[a-f0-9]{64}$/u
const RELEASE = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u
const check = (condition, message) => { if (!condition) throw new Error(message) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'unsupported signed plan value')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function protectedPath(path, mode, maxBytes = 8 * 1024 * 1024) {
  check(path === resolve(path) && realpathSync(path) === path, 'protected path must be canonical')
  for (let cursor = path;; cursor = dirname(cursor)) { const st = lstatSync(cursor); check(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'untrusted protected path'); if (cursor === '/') break }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const st = fstatSync(fd); check(st.isFile() && st.size > 0 && st.size <= maxBytes && (mode === undefined || (st.mode & 0o777) === mode), 'protected file invalid'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
function protectedDirectory(path) {
  check(path === resolve(path) && realpathSync(path) === path, 'protected directory must be canonical')
  for (let cursor = path;; cursor = dirname(cursor)) { const st = lstatSync(cursor); check(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'untrusted protected directory'); if (cursor === '/') break }
}
function assertInstalled() {
  check(process.getuid?.() === 0 && process.geteuid?.() === 0 && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'protected root runtime required')
  check(realpathSync(process.argv[1]) === INSTALLED, 'PG17 plan signer must run from fixed installed path')
  const expected = protectedPath(DIGEST).toString('utf8').trim()
  check(HEX.test(expected) && sha(protectedPath(INSTALLED)) === expected, 'installed PG17 plan signer digest mismatch')
  protectedPath(process.execPath, undefined, 256 * 1024 * 1024)
  protectedPath('/usr/bin/docker', undefined, 64 * 1024 * 1024)
}
function candidateIdentity(releaseId, gitSha) {
  const bytes = protectedPath(join(RELEASES, releaseId, '.candidate-identity'))
  const values = Object.fromEntries(bytes.toString('utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  check(values.release_id === releaseId && values.git_sha === gitSha && /^sha256:[a-f0-9]{64}$/u.test(values.source_sha256 ?? ''), 'candidate archive identity mismatch')
}
function argsOf(args) {
  const mode = args[0]
  check(mode === 'inspect', 'plan signing is disabled until independent owner approval is provisioned')
  const names = ['--release-id', '--git-sha']
  check(args.length === 1 + names.length * 2, 'exact plan signing arguments required')
  const values = {}
  for (let i = 1; i < args.length; i += 2) { check(names.includes(args[i]) && !Object.hasOwn(values, args[i]) && args[i + 1], 'unknown or duplicate argument'); values[args[i]] = args[i + 1] }
  check(names.every(name => values[name]) && RELEASE.test(values['--release-id']) && /^[a-f0-9]{40}$/u.test(values['--git-sha']), 'candidate identity invalid')
  return { mode, values }
}
function liveSource() {
  const value = JSON.parse(execFileSync('/usr/bin/docker', ['inspect', 'merchant-production-postgres-1'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }))[0]
  check(value?.State?.Running === true && /^[a-f0-9]{64}$/u.test(value.Id ?? '') && /postgres:16/u.test(value.Config?.Image ?? ''), 'reviewed production PG16 container unavailable')
  const networks = Object.values(value.NetworkSettings?.Networks ?? {}).map(item => item.IPAddress).filter(Boolean)
  check(networks.length === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(networks[0]), 'production Postgres network ambiguous')
  const config = Object.fromEntries((value.Config.Env ?? []).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  check(config.POSTGRES_DB && config.POSTGRES_USER && config.POSTGRES_PASSWORD, 'production database credentials unavailable')
  return { host: networks[0], port: 5432, user: config.POSTGRES_USER, password: config.POSTGRES_PASSWORD, database: config.POSTGRES_DB, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 }
}
export async function runProtectedPlanSigner(args) {
  const { mode, values } = argsOf(args), releaseId = values['--release-id'], gitSha = values['--git-sha']
  assertInstalled()
  candidateIdentity(releaseId, gitSha)
  const client = new pg.Client(liveSource())
  await client.connect()
  let observed
  try { observed = await collectFrozenPlanCatalog(client, undefined, 242) }
  finally { await client.end() }
  const policyBytes = Buffer.from(`${JSON.stringify(observed.source_policy)}\n`)
  const policySha = sha(policyBytes), planSha = sha(Buffer.from(JSON.stringify(observed.table_plan)))
  if (mode === 'inspect') {
    process.stdout.write(`${JSON.stringify({ schema_version: 'pg17-frozen-plan-inspection/1', release_id: releaseId, release_git_sha: gitSha, source_policy_sha256: policySha, table_plan_sha256: planSha, migration_version: 242, table_count: observed.table_plan.length, table_plan: observed.table_plan, database_mutations: false })}\n`)
    return
  }
}
if (process.argv[1] && basename(process.argv[1]) === 'attest-pg17-frozen-plan' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runProtectedPlanSigner(process.argv.slice(2)).catch(error => { process.stderr.write(`PG17 frozen plan rejected: ${error.message}\n`); process.exitCode = 1 })
}
