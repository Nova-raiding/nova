#!/usr/bin/env node
// Fixed-install catalog inspector and owner-digest-gated plan signer.
// Inspect is read-only; sign writes only a scoped source policy and plan file.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
export function signFrozenPlanFromObservedCatalog({ tablePlan, sourcePolicyBytes, releaseId, gitSha, migrationVersion, keyId, privateKeyPem, publicKeyPem, signedAt, expiresAt }) {
  check(Buffer.isBuffer(sourcePolicyBytes) && sourcePolicyBytes.length > 0 && sourcePolicyBytes.length <= 4096, 'source policy bytes invalid')
  const policy = JSON.parse(sourcePolicyBytes.toString('utf8'))
  const privateKey = createPrivateKey(privateKeyPem)
  check(privateKey.asymmetricKeyType === 'ed25519', 'plan signing key must be Ed25519')
  const unsigned = { schema_version: 'pg17-frozen-table-plan/1', kind: 'rowset_plan', release_id: releaseId, release_git_sha: gitSha, source_policy_sha256: sha(sourcePolicyBytes), source_database_id_sha256: policy.system_identifier_sha256, migration_version: migrationVersion, row_canonicalization: 'pg17-canonical-rows/1', rls_canonicalization: 'pg17-rls-policy/1', signed_at: signedAt, expires_at: expiresAt, key_id: keyId, table_plan: tablePlan }
  const payload = Buffer.concat([Buffer.from('merchant/pg17-frozen-table-plan/1\0'), Buffer.from(canonical(unsigned))])
  const planBytes = Buffer.from(`${canonical({ ...unsigned, signature_base64: sign(null, payload, privateKey).toString('base64') })}\n`)
  reviewOnlyVerifyFrozenPlan({ planBytes, sourcePolicyBytes, trustedPublicKey: publicKeyPem, trustedKeyId: keyId, expectedReleaseId: releaseId, expectedGitSha: gitSha, expectedMigrationVersion: migrationVersion, now: new Date(signedAt) })
  return planBytes
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
  check(mode === 'inspect' || mode === 'sign', 'inspect or sign mode required')
  const names = mode === 'inspect' ? ['--release-id', '--git-sha'] : ['--release-id', '--git-sha', '--attempt-id', '--approved-policy-sha256', '--approved-table-plan-sha256']
  check(args.length === 1 + names.length * 2, 'exact plan signing arguments required')
  const values = {}
  for (let i = 1; i < args.length; i += 2) { check(names.includes(args[i]) && !Object.hasOwn(values, args[i]) && args[i + 1], 'unknown or duplicate argument'); values[args[i]] = args[i + 1] }
  check(names.every(name => values[name]) && RELEASE.test(values['--release-id']) && /^[a-f0-9]{40}$/u.test(values['--git-sha']), 'candidate identity invalid')
  if (mode === 'sign') check(ATTEMPT.test(values['--attempt-id']) && HEX.test(values['--approved-policy-sha256']) && HEX.test(values['--approved-table-plan-sha256']), 'approved policy/plan digest invalid')
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
  assertInstalled()
  const { mode, values } = argsOf(args), releaseId = values['--release-id'], gitSha = values['--git-sha']
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
  check(policySha === values['--approved-policy-sha256'] && planSha === values['--approved-table-plan-sha256'], 'live source differs from owner-reviewed plan or policy')
  const publicPem = protectedPath(join(TRUST, 'production-evidence-public.pem'), 0o444)
  const privatePem = protectedPath(join(STATE, 'production-capability-private.pem'), 0o600)
  const keyId = protectedPath(join(TRUST, 'production-evidence-key-id')).toString('utf8').trim()
  const now = new Date(), signedAt = now.toISOString(), expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString()
  const bytes = signFrozenPlanFromObservedCatalog({ tablePlan: observed.table_plan, sourcePolicyBytes: policyBytes, releaseId, gitSha, migrationVersion: 242, keyId, privateKeyPem: privatePem, publicKeyPem: publicPem, signedAt, expiresAt })
  const policyPath = join(TRUST, `production-backup-source-${releaseId}.json`)
  try { check(protectedPath(policyPath, 0o444).equals(policyBytes), 'existing protected source policy changed') }
  catch (error) { if (error?.code !== 'ENOENT') throw error; writeFileSync(policyPath, policyBytes, { flag: 'wx', mode: 0o444 }) }
  const root = join(STATE, 'pg17-plans')
  try { mkdirSync(root, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  protectedDirectory(root)
  const output = join(root, `${releaseId}-${values['--attempt-id']}.json`)
  writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ status: 'signed_frozen_plan_written', release_id: releaseId, plan_sha256: sha(bytes), source_policy_sha256: policySha, table_count: observed.table_plan.length, final_production_evidence: false })}\n`)
}
if (process.argv[1] && basename(process.argv[1]) === 'attest-pg17-frozen-plan' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runProtectedPlanSigner(process.argv.slice(2)).catch(error => { process.stderr.write(`PG17 frozen plan rejected: ${error.message}\n`); process.exitCode = 1 })
}
