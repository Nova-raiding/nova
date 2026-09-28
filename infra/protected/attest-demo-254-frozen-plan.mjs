#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Fixed-install, root-only signer for the live 254 source. Inspect first;
// signing requires the exact owner-reviewed freeze digest and never edits DB.
import { createHash } from 'node:crypto'
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSnapshot } from './attest-postgres-backup.mjs'
import { observeDemo254Topology, assertDemo254LocalTarget, queryDemo254Migrations } from './attest-demo-254-backup.mjs'
import { signFrozenDemo254Plan } from './capture-demo-254-backup.mjs'
import { reviewDemo254BackupSource } from './review-demo-254-backup-source.mjs'

const TRUST = '/run/release-security/evidence-trust'
const INSTALLED = '/usr/local/libexec/merchant/attest-demo-254-frozen-plan'
const DIGEST = `${TRUST}/production-demo-254-plan-signer-sha256`
const PLAN = `${TRUST}/production-demo-254-backup-source-plan.json`
const PRIVATE = '/var/lib/merchant-release-security/production-capability-private.pem'
const PUBLIC = `${TRUST}/production-evidence-public.pem`
const KEY_ID = `${TRUST}/production-evidence-key-id`
const RELEASES = '/srv/merchant-releases'
const SHA = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`DEMO_254_PLAN_${message}`) }
const check = (value, message) => { if (!value) fail(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

function protectedFile(path, max = 8 * 1024 * 1024, mode) {
  check(path === resolve(path) && realpathSync(path) === path, 'PROTECTED_PATH_INVALID')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    check(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'PROTECTED_OWNER_INVALID')
    if (cursor === '/') break
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size > 0 && stat.size <= max && (mode === undefined || (stat.mode & 0o777) === mode), 'PROTECTED_FILE_INVALID')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function protectedDirectory(path) {
  check(path === resolve(path) && realpathSync(path) === path, 'PROTECTED_DIRECTORY_INVALID')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'PROTECTED_DIRECTORY_OWNER_INVALID')
    if (cursor === '/') break
  }
}
export function candidateDemo254Migrations(directory, read = protectedFile, list = readdirSync) {
  const names = list(directory).sort()
  check(names.length === 254 || names.length === 255, 'CANDIDATE_MIGRATION_COUNT_INVALID')
  for (let index = 0; index < names.length; index++) {
    check(new RegExp(`^${String(index + 1).padStart(3, '0')}_[a-z0-9][a-z0-9_]*\\.sql$`, 'u').test(names[index]), 'CANDIDATE_MIGRATION_NAME_INVALID')
  }
  return names.slice(0, 254).map((name, index) => {
    check(new RegExp(`^${String(index + 1).padStart(3, '0')}_[a-z0-9][a-z0-9_]*\\.sql$`, 'u').test(name), 'CANDIDATE_MIGRATION_NAME_INVALID')
    return { version: index + 1, name: name.slice(4, -4), checksum: sha(read(join(directory, name))) }
  })
}
export function freezeDemo254Source({ observation, database, migrations, systemIdentifier, databaseOid, databaseName }) {
  check(database?.system_identifier === systemIdentifier && database?.oid === databaseOid && database?.name === databaseName,
    'DATABASE_SNAPSHOT_IDENTITY_DRIFT')
  const historySha = sha(migrations.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
  const frozen = { schema_version: 'demo-254-backup-source-freeze/1', public_route: observation.public_route,
    gateway: observation.gateway, api_replica: observation.api_replica, postgres: observation.postgres,
    connections: observation.connections,
    database: { name: databaseName, oid: databaseOid, system_identifier_sha256: sha(systemIdentifier),
      server_version_num: database.server_version_num, history_sha256: historySha }, candidate_migrations: migrations }
  reviewDemo254BackupSource({ frozen, observed: { ...observation, database } })
  return { frozen, frozenSha256: sha(canonical(frozen)) }
}
function argsOf(args) {
  check(['inspect', 'sign'].includes(args[0]), 'MODE_INVALID')
  const names = args[0] === 'sign' ? ['--release-id', '--candidate-release-id', '--approved-freeze-sha256'] : ['--release-id', '--candidate-release-id']
  check(args.length === 1 + names.length * 2, 'EXACT_ARGS_REQUIRED')
  const values = new Map()
  for (let i = 1; i < args.length; i += 2) {
    check(names.includes(args[i]) && !values.has(args[i]), 'ARG_INVALID')
    values.set(args[i], args[i + 1])
  }
  check(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(values.get('--release-id') ?? '')
    && /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(values.get('--candidate-release-id') ?? '')
    && (args[0] !== 'sign' || SHA.test(values.get('--approved-freeze-sha256') ?? '')), 'ARG_VALUE_INVALID')
  return { mode: args[0], releaseId: values.get('--release-id'), candidateReleaseId: values.get('--candidate-release-id'), approvedSha: values.get('--approved-freeze-sha256') }
}
async function main(args) {
  check(process.getuid?.() === 0 && process.geteuid?.() === 0, 'ROOT_REQUIRED')
  assertDemo254LocalTarget()
  check(realpathSync(process.argv[1]) === INSTALLED, 'FIXED_INSTALL_REQUIRED')
  check(sha(protectedFile(INSTALLED)) === protectedFile(DIGEST, 128).toString('utf8').trim(), 'INSTALL_DIGEST_MISMATCH')
  protectedFile(process.execPath, 256 * 1024 * 1024)
  const { mode, releaseId, candidateReleaseId, approvedSha } = argsOf(args)
  const releaseRoot = join(RELEASES, candidateReleaseId)
  protectedDirectory(releaseRoot)
  const identity = Object.fromEntries(protectedFile(join(releaseRoot, '.candidate-identity')).toString('utf8').trim().split('\n').map(line => {
    const at = line.indexOf('='); check(at > 0, 'CANDIDATE_IDENTITY_INVALID'); return [line.slice(0, at), line.slice(at + 1)]
  }))
  check(identity.release_id === candidateReleaseId && /^[a-f0-9]{40}$/u.test(identity.git_sha ?? ''), 'CANDIDATE_IDENTITY_INVALID')
  const migrations = candidateDemo254Migrations(join(releaseRoot, 'packages/persistence/src/migrations'))
  const first = observeDemo254Topology()
  check(first.observation.public_route.release_id === releaseId, 'PUBLIC_RELEASE_DRIFT')
  Object.assign(process.env, first.pg)
  const held = await captureSnapshot()
  let result
  try {
    check(held.migrationVersion === 254, 'SOURCE_NOT_254')
    const database = queryDemo254Migrations(held.snapshot, first.pg)
    const second = observeDemo254Topology()
    check(canonical({ ...first.observation, observed_at: undefined }) === canonical({ ...second.observation, observed_at: undefined }), 'TOPOLOGY_DRIFT')
    result = freezeDemo254Source({ observation: second.observation, database, migrations,
      systemIdentifier: held.systemIdentifier, databaseOid: held.databaseOid, databaseName: held.databaseName })
  } finally { held.release() }
  if (mode === 'inspect') {
    process.stdout.write(`${JSON.stringify({ status: 'review_only', release_id: releaseId, candidate_release_id: candidateReleaseId,
      candidate_git_sha: identity.git_sha, frozen_sha256: result.frozenSha256,
      migration_version: 254, migration_history_sha256: result.frozen.database.history_sha256, source_database_id_sha256: result.frozen.database.system_identifier_sha256,
      database_mutations: false })}\n`)
    return
  }
  check(result.frozenSha256 === approvedSha, 'OWNER_APPROVED_FREEZE_DIGEST_MISMATCH')
  const privatePem = protectedFile(PRIVATE, 8192, 0o600), publicPem = protectedFile(PUBLIC)
  const keyId = protectedFile(KEY_ID, 128).toString('utf8').trim()
  const plan = signFrozenDemo254Plan(result.frozen, { privatePem, publicPem, keyId })
  protectedDirectory(TRUST)
  const fd = openSync(PLAN, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444)
  try { writeFileSync(fd, `${JSON.stringify(plan)}\n`); fchmodSync(fd, 0o444); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(TRUST, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(parent) } finally { closeSync(parent) }
  process.stdout.write(`${JSON.stringify({ plan_sha256: sha(protectedFile(PLAN)), candidate_release_id: candidateReleaseId,
    candidate_git_sha: identity.git_sha, frozen_sha256: result.frozenSha256,
    migration_version: 254, database_mutations: false })}\n`)
}
if (process.argv[1] && basename(process.argv[1]) === basename(INSTALLED) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`demo 254 plan rejected: ${error.message}\n`); process.exitCode = 1 })
}
