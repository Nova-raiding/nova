#!/usr/bin/env node
// Install verbatim as /usr/local/libexec/merchant/ecs-preidentity-recovery.
// This file is deliberately dependency-free and must never import mutable repo code.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const FIXED_PATH = '/usr/local/libexec/merchant/ecs-preidentity-recovery'
const TRUST_DIR = '/run/release-security/evidence-trust'
const DIGEST_PATH = `${TRUST_DIR}/production-preidentity-recovery-sha256`
const PUBLIC_KEY_PATH = `${TRUST_DIR}/production-evidence-public.pem`
const KEY_ID_PATH = `${TRUST_DIR}/production-evidence-key-id`
const PRIVATE_KEY_PATH = '/var/lib/merchant-release-security/production-capability-private.pem'
const NONCE_LEDGER = '/var/lib/merchant-release-security/production-nonces.sqlite3'
const BIN = Object.freeze({ docker: '/usr/bin/docker', psql: '/usr/bin/psql', flock: '/usr/bin/flock', curl: '/usr/bin/curl' })
const TRANSITIONS = Object.freeze({ captured: ['nonce_consumed'], nonce_consumed: ['migration_started'], migration_started: ['migration_complete', 'recovery_started'], migration_complete: ['runtime_cutover_started', 'recovery_started'], runtime_cutover_started: ['runtime_identity_verified'], recovery_started: ['recovery_verified'], runtime_identity_verified: [], recovery_verified: [] })
const HEX = /^[a-f0-9]{64}$/u, IMAGE = /^sha256:[a-f0-9]{64}$/u, GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

function assert(value, message) { if (!value) throw new Error(message) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function signDocument(value, privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519', 'recovery trust keys must be Ed25519')
  assert(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'capability private key does not match production trust')
  const signed = structuredClone(value)
  signed.signature_base64 = sign(null, Buffer.from(canonical(signed)), privateKey).toString('base64')
  assert(verifyDocument(signed, publicPem), 'snapshot self-verification failed')
  return signed
}
function verifyDocument(value, publicPem) {
  try { return verify(null, Buffer.from(canonical(value)), createPublicKey(publicPem), Buffer.from(value.signature_base64, 'base64')) } catch { return false }
}
function normalizedContainers(containers) {
  assert(Array.isArray(containers) && containers.length > 0, 'reviewed workload must contain at least one actual container')
  const normalized = containers.map(item => {
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(item.service ?? ''), 'invalid reviewed service')
    assert(/^[a-f0-9]{12,64}$/u.test(item.id ?? ''), `invalid container id for ${item.service}`)
    assert(IMAGE.test(item.imageId ?? ''), `immutable image id missing for ${item.service}`)
    assert(HEX.test(item.configHash ?? ''), `config hash missing for ${item.service}`)
    assert(item.state === 'running', `reviewed service is not running: ${item.service}`)
    return { service: item.service, id: item.id, image_id: item.imageId, config_hash: item.configHash, state: item.state }
  }).sort((a, b) => a.service.localeCompare(b.service))
  assert(new Set(normalized.map(item => item.service)).size === normalized.length, 'reviewed services must be unique')
  return normalized
}
function workloadDigest(containers) { return `sha256:${digest(Buffer.from(canonical(normalizedContainers(containers))))}` }
function inventoryDigest(containers) { return `sha256:${digest(Buffer.from(canonical(containers)))}` }
function validateRelease(value, label) {
  assert(value && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.releaseId ?? ''), `${label} release id is invalid`)
  assert(GIT.test(value.gitSha ?? '') && HEX.test(value.manifestSha256 ?? '') && IMAGE.test(value.imageSetDigest ?? ''), `${label} identity is invalid`)
}

export function createSignedSnapshot(observed, binding, privatePem, publicPem, now = new Date()) {
  validateRelease(binding.candidate, 'candidate'); validateRelease(binding.recovery, 'recovery')
  assert(/^[A-Za-z0-9_-]{16,128}$/u.test(binding.attemptId ?? '') && /^[A-Za-z0-9_-]{22,128}$/u.test(binding.deploymentNonce ?? ''), 'attempt or nonce is invalid')
  assert(Number.isInteger(observed.database?.version) && observed.database.version > 0 && HEX.test(observed.database.historySha256 ?? ''), 'observed database prefix is invalid')
  assert((observed.database.invalidConcurrentIndexes ?? []).length === 0, 'invalid concurrent index requires manual recovery')
  assert(Number.isInteger(binding.recovery.migrationTail) && binding.recovery.migrationTail >= observed.database.version, 'recovery target cannot read the observed database prefix')
  assert(binding.recovery.allowedPrefixSha256 && Object.entries(binding.recovery.allowedPrefixSha256).every(([version, value]) => Number(version) >= observed.database.version && Number(version) <= binding.recovery.migrationTail && HEX.test(value)), 'recovery prefix allowlist is invalid')
  assert(binding.recovery.allowedPrefixSha256[observed.database.version] === observed.database.historySha256, 'observed database is not an approved recovery prefix')
  assert(Array.isArray(binding.recovery.services) && binding.recovery.services.length > 0 && binding.recovery.services.every(value => /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)), 'recovery service list is invalid')
  for (const field of ['composeSha256', 'envSha256', 'imageDigestsSha256']) assert(HEX.test(binding.recovery[field] ?? ''), `recovery ${field} is invalid`)
  const containers = normalizedContainers(observed.containers)
  assert(Array.isArray(observed.inventory) && observed.inventory.length > 0, 'complete Docker inventory is required')
  assert(Array.isArray(observed.candidateImageIds) && observed.candidateImageIds.length > 0 && observed.candidateImageIds.every(value => IMAGE.test(value)), 'candidate image IDs must be independently resolved')
  const oldImageIds = new Set(containers.map(value => value.image_id))
  const candidateExclusiveImageIds = [...new Set(observed.candidateImageIds)].filter(value => !oldImageIds.has(value)).sort()
  assert(observed.candidateExclusiveRunning !== true, 'candidate-exclusive container is already running during capture')
  assert(observed.candidateIdentityRunning !== true, 'candidate release identity is already running during capture')
  const document = {
    schema_version: 'ecs-preidentity-recovery/1', attempt_id: binding.attemptId, compose_project: observed.composeProject,
    captured_at: now.toISOString(), expires_at: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(), phase: 'captured',
    candidate: { release_id: binding.candidate.releaseId, release_git_sha: binding.candidate.gitSha, manifest_sha256: binding.candidate.manifestSha256, image_set_digest: binding.candidate.imageSetDigest, exclusive_image_ids: candidateExclusiveImageIds },
    deployment_nonce_sha256: digest(binding.deploymentNonce),
    predeployment_workload: { services: containers, container_set_digest: workloadDigest(observed.containers), inventory_digest: inventoryDigest(observed.inventory) },
    database_before: { migration_version: observed.database.version, migration_history_sha256: observed.database.historySha256 },
    recovery_target: { release_id: binding.recovery.releaseId, release_git_sha: binding.recovery.gitSha, manifest_sha256: binding.recovery.manifestSha256, image_set_digest: binding.recovery.imageSetDigest, compose_sha256: binding.recovery.composeSha256, env_sha256: binding.recovery.envSha256, image_digests_sha256: binding.recovery.imageDigestsSha256, migration_tail: binding.recovery.migrationTail, allowed_prefix_sha256: binding.recovery.allowedPrefixSha256, services: [...new Set(binding.recovery.services)].sort() },
    database_policy: { strategy: 'forward_only', minimum_version: observed.database.version, maximum_version: binding.recovery.migrationTail, target_version: binding.recovery.migrationTail, schema_downgrade: false },
    key_id: binding.keyId,
  }
  return signDocument(document, privatePem, publicPem)
}

export function transitionJournal(document, nextPhase, privatePem, publicPem, now = new Date()) {
  assert(verifyDocument(document, publicPem), 'journal signature is invalid')
  assert(TRANSITIONS[document.phase]?.includes(nextPhase), 'journal phase transition is not monotonic')
  assert(Date.parse(document.expires_at) > now.getTime(), 'journal is expired')
  return signDocument({ ...document, phase: nextPhase, updated_at: now.toISOString(), signature_base64: undefined }, privatePem, publicPem)
}

export function verifyRecoveryAuthorization(document, input, publicPem, now = new Date()) {
  assert(verifyDocument(document, publicPem), 'journal signature is invalid')
  assert(['migration_started', 'migration_complete'].includes(document.phase), 'journal phase does not permit pre-identity recovery')
  assert(Date.parse(document.expires_at) > now.getTime(), 'journal is expired')
  assert(digest(input.deploymentNonce) === document.deployment_nonce_sha256, 'deployment nonce does not match journal')
  assert(input.candidateContainersRunning !== true, 'candidate or partial runtime cutover detected')
  assert(workloadDigest(input.observed.containers) === document.predeployment_workload.container_set_digest, 'predeployment containers changed or are incomplete')
  assert(inventoryDigest(input.observed.inventory) === document.predeployment_workload.inventory_digest, 'complete Docker inventory changed; concurrent or partial cutover detected')
  assert(input.observed.composeProject === document.compose_project, 'Compose project changed')
  const expected = document.recovery_target, actual = input.recovery
  assert(actual.releaseId === expected.release_id && actual.gitSha === expected.release_git_sha && actual.manifestSha256 === expected.manifest_sha256 && actual.imageSetDigest === expected.image_set_digest, 'recovery release identity mismatch')
  assert(actual.composeSha256 === expected.compose_sha256 && actual.envSha256 === expected.env_sha256 && actual.imageDigestsSha256 === expected.image_digests_sha256 && actual.migrationTail === expected.migration_tail, 'recovery capsule mismatch')
  assert(canonical(actual.allowedPrefixSha256) === canonical(expected.allowed_prefix_sha256) && canonical([...new Set(actual.services)].sort()) === canonical(expected.services), 'recovery policy changed')
  assert((input.database.invalidConcurrentIndexes ?? []).length === 0, `invalid concurrent index requires manual recovery: ${(input.database.invalidConcurrentIndexes ?? []).join(',')}`)
  assert(Number.isInteger(input.database.version) && input.database.version >= document.database_policy.minimum_version && input.database.version <= document.database_policy.maximum_version, 'database version is outside forward-only recovery bounds')
  assert(expected.allowed_prefix_sha256?.[input.database.version] === input.database.historySha256, 'database history is not an approved recovery prefix')
  return { authorized: true, targetMigration: document.database_policy.target_version }
}

function readRegular(path, maximum = 4 * 1024 * 1024) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const st = fstatSync(fd); assert(st.isFile() && st.size > 0 && st.size <= maximum, `unsafe file: ${path}`); return readFileSync(fd) } finally { closeSync(fd) } }
function parseOptions(args, specification) {
  const result = {}; assert(args.length % 2 === 0, 'every option requires one value')
  for (let index = 0; index < args.length; index += 2) { const name = args[index], value = args[index + 1]; assert(Object.hasOwn(specification, name), `unknown option: ${name}`); assert(!Object.hasOwn(result, name), `duplicate option: ${name}`); assert(value && !value.startsWith('--'), `missing value for ${name}`); result[name] = value }
  for (const [name, required] of Object.entries(specification)) if (required) assert(Object.hasOwn(result, name), `${name} is required`)
  return result
}
function protectChain(path, label) {
  let cursor = realpathSync(path); assert(cursor === resolve(path), `${label} path must be canonical`)
  while (cursor !== '/') { const st = lstatSync(cursor); assert(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, `${label} path chain must be root-owned and protected: ${cursor}`); cursor = dirname(cursor) }
}
function protectedPath(path, label, mode) { assert(path, `${label} path is required`); protectChain(path, label); const st = lstatSync(path); if (mode) assert((st.mode & 0o777) === mode, `${label} has unsafe mode`) }
function assertRuntime() {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'preidentity recovery must run as root')
  assert(realpathSync(process.argv[1]) === FIXED_PATH, `preidentity recovery must run from ${FIXED_PATH}`)
  protectedPath(FIXED_PATH, 'helper'); protectedPath(DIGEST_PATH, 'helper digest'); protectedPath(TRUST_DIR, 'trust directory')
  const expected = readRegular(DIGEST_PATH, 128).toString('utf8').trim()
  assert(HEX.test(expected) && digest(readRegular(FIXED_PATH)) === expected, 'preidentity recovery self digest mismatch')
  protectedPath(PRIVATE_KEY_PATH, 'capability private key', 0o600); protectedPath(PUBLIC_KEY_PATH, 'production public key'); protectedPath(KEY_ID_PATH, 'production key id')
}
function writeAtomic(path, value, replace = false) {
  const parent = realpathSync(dirname(path)); assert(parent === dirname(path), 'journal parent must be canonical'); protectedPath(parent, 'journal parent')
  const temp = `${path}.${process.pid}.tmp`, fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  try { if (replace) renameSync(temp, path); else { linkSync(temp, path); unlinkSync(temp) } } catch (error) { try { unlinkSync(temp) } catch {} throw error }
  const parentFd = openSync(parent, constants.O_RDONLY); try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
}
function cleanExec(command, args, options = {}) { assert(Object.values(BIN).includes(command), `unapproved executable: ${command}`); return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: options.env ?? {}, input: options.input }) }
function jsonCommand(command, args, input, env = {}) { return JSON.parse(cleanExec(command, args, { input, env })) }
function collectContainers(mapPath) {
  const mappings = JSON.parse(readRegular(mapPath).toString('utf8'))
  assert(Array.isArray(mappings) && mappings.length > 0, 'reviewed service map must be a non-empty array')
  return mappings.map(mapping => {
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(mapping.service ?? '') && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(mapping.container ?? ''), 'invalid reviewed service mapping')
    const listed = cleanExec(BIN.docker, ['ps', '--filter', `name=^/${mapping.container}$`, '--format', '{{.ID}}']).trim().split(/\s+/u).filter(Boolean)
    assert(listed.length === 1, `reviewed service mapping must resolve exactly one running container: ${mapping.service}`)
    const inspect = jsonCommand(BIN.docker, ['inspect', listed[0]])[0]
    assert(inspect?.State?.Running === true && inspect.Id && inspect.Image, `reviewed container is not running: ${mapping.service}`)
    const configHash = digest(Buffer.from(canonical({ image: inspect.Config?.Image, env: [...(inspect.Config?.Env ?? [])].sort(), entrypoint: inspect.Config?.Entrypoint ?? null, cmd: inspect.Config?.Cmd ?? null, mounts: (inspect.Mounts ?? []).map(({ Destination, Type, RW }) => ({ Destination, Type, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) })))
    return { service: mapping.service, id: inspect.Id, imageId: inspect.Image, configHash, state: 'running' }
  })
}
function collectInventory() {
  const ids = cleanExec(BIN.docker, ['ps', '-q', '--no-trunc']).trim().split(/\s+/u).filter(Boolean)
  assert(ids.length > 0, 'Docker running-container inventory is empty')
  return ids.map(id => {
    const value = jsonCommand(BIN.docker, ['inspect', id])[0]; assert(value?.Id && value?.Image && value?.State?.Running, 'Docker inventory contains an unreadable or stopped container')
    return { id: value.Id, name: String(value.Name ?? '').replace(/^\//u, ''), image_id: value.Image, config_hash: digest(Buffer.from(canonical({ image: value.Config?.Image, env: [...(value.Config?.Env ?? [])].sort(), entrypoint: value.Config?.Entrypoint ?? null, cmd: value.Config?.Cmd ?? null, mounts: (value.Mounts ?? []).map(({ Destination, Type, RW }) => ({ Destination, Type, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) }))) }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
function collectCandidateImageIds(path) {
  const values = Object.values(JSON.parse(readRegular(path).toString('utf8')))
  assert(values.length > 0 && values.every(value => typeof value === 'string' && /@sha256:[a-f0-9]{64}$/u.test(value)), 'candidate image digest map is invalid')
  return [...new Set(values.map(value => {
    const id = cleanExec(BIN.docker, ['image', 'inspect', '--format', '{{.Id}}', value]).trim(); assert(IMAGE.test(id), `candidate image is unavailable locally: ${value}`); return id
  }))].sort()
}
function candidateContainersRunning(candidateImageIds) {
  const ids = cleanExec(BIN.docker, ['ps', '-q', '--no-trunc']).trim().split(/\s+/u).filter(Boolean)
  return ids.some(id => { const value = jsonCommand(BIN.docker, ['inspect', id])[0]; return candidateImageIds.includes(value?.Image) })
}
function candidateIdentityRunning(candidate) {
  const ids = cleanExec(BIN.docker, ['ps', '-q', '--no-trunc']).trim().split(/\s+/u).filter(Boolean)
  return ids.some(id => {
    const value = jsonCommand(BIN.docker, ['inspect', id])[0], env = Object.fromEntries((value?.Config?.Env ?? []).map(item => { const at = item.indexOf('='); return at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)] }))
    return env.RELEASE_ID === candidate.release_id || env.RELEASE_GIT_SHA === candidate.release_git_sha || env.RELEASE_MANIFEST_SHA256 === candidate.manifest_sha256 || env.RELEASE_IMAGE_SET_DIGEST === candidate.image_set_digest
  })
}
function collectDatabase(databaseUrl) {
  const url = new URL(databaseUrl); assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1, 'database URL is invalid')
  const pgEnv = { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') || 'prefer' }
  const sql = `SELECT json_build_object('version',coalesce(max(version),0),'history',coalesce(json_agg(json_build_array(version,name,checksum) ORDER BY version),'[]'::json)) FROM schema_migrations;`
  const value = JSON.parse(cleanExec(BIN.psql, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: pgEnv }).trim())
  assert(Number.isInteger(Number(value.version)) && Array.isArray(value.history) && value.history.length === Number(value.version) && value.history.every((row, index) => Array.isArray(row) && Number(row[0]) === index + 1 && typeof row[1] === 'string' && HEX.test(row[2] ?? '')), 'database migration history is not a checksummed contiguous prefix')
  const invalidSql = `SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json) FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname IN ('rule_audit_events_workspace_occurred_id_idx','ops_incident_timeline_workspace_created_id_idx','workspace_support_ticket_events_workspace_created_id_idx') AND NOT i.indisvalid;`
  const invalid = JSON.parse(cleanExec(BIN.psql, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', invalidSql], { env: pgEnv }).trim())
  return { version: Number(value.version), historySha256: digest(Buffer.from(canonical(value.history))), invalidConcurrentIndexes: invalid }
}
function parsePlan(path) {
  const plan = JSON.parse(readRegular(path).toString('utf8')), target = plan.target
  assert(plan.kind === 'ecs-compose-rollback-capsule' && plan.database?.strategy === 'forward_only' && plan.database?.schema_downgrade === false, 'recovery plan is not forward-only')
  return { releaseId: target.release_id, gitSha: target.git_sha, manifestSha256: target.manifest_sha256, imageSetDigest: target.image_set_digest, composeSha256: target.compose_sha256, envSha256: target.env_sha256, imageDigestsSha256: target.image_digests_sha256, migrationTail: plan.database.target_migration_tail, allowedPrefixSha256: plan.database.allowed_prefix_sha256, services: plan.target.services }
}
function verifyNonceLedger(nonce, candidate) {
  protectedPath(NONCE_LEDGER, 'nonce ledger', 0o600)
  const ledger = new DatabaseSync(NONCE_LEDGER, { readOnly: true })
  try {
    const row = ledger.prepare('SELECT release_id,image_digest,manifest_sha256,release_git_sha FROM consumed_nonces WHERE namespace=? AND nonce=?').get('merchant-production-deploy', nonce)
    assert(row && row.release_id === candidate.release_id && row.image_digest === candidate.image_set_digest && row.manifest_sha256 === candidate.manifest_sha256 && row.release_git_sha === candidate.release_git_sha, 'nonce is not consumed with the candidate binding')
  } finally { ledger.close() }
}
function assertInheritedLock(lockPath) {
  protectedPath(lockPath, 'production mutation lock')
  const opened = fstatSync(9), expected = statSync(lockPath)
  assert(opened.dev === expected.dev && opened.ino === expected.ino && opened.isFile(), 'FD 9 is not the canonical production mutation lock')
  const stdio = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9]
  const result = spawnSync(BIN.flock, ['-n', '9'], { env: {}, stdio })
  assert(result.status === 0, 'production mutation lock is held by another process')
}
const COMMON = { '--state': true, '--lock-path': true }
const SPECS = Object.freeze({
  capture: { ...COMMON, '--attempt-id': true, '--service-map': true, '--compose-project': true, '--candidate-release-id': true, '--candidate-git-sha': true, '--candidate-manifest-sha256': true, '--candidate-image-set-digest': true, '--candidate-image-digests': true, '--deployment-nonce': true, '--recovery-plan': true },
  phase: { ...COMMON, '--phase': true },
  verify: { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true },
  recover: { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--recovery-compose': true, '--recovery-env': true, '--recovery-image-digests': true, '--production-api-base-url': true, '--wait-timeout': false },
})
function main(args) {
  assertRuntime(); const command = args[0]; assert(Object.hasOwn(SPECS, command), 'expected capture, phase, verify, or recover'); const options = parseOptions(args.slice(1), SPECS[command]); const get = name => options[name]; const statePath = get('--state'); assertInheritedLock(get('--lock-path'))
  const privatePem = readRegular(PRIVATE_KEY_PATH, 8192), publicPem = readRegular(PUBLIC_KEY_PATH, 8192)
  if (command === 'capture') {
    const planPath = get('--recovery-plan'), mapPath = get('--service-map'), candidateDigestsPath = get('--candidate-image-digests')
    protectedPath(planPath, 'recovery plan'); protectedPath(mapPath, 'reviewed service map'); protectedPath(candidateDigestsPath, 'candidate image digests')
    const recovery = parsePlan(planPath)
    const containers = collectContainers(mapPath), candidateImageIds = collectCandidateImageIds(candidateDigestsPath)
    const oldImageIds = new Set(containers.map(value => value.imageId)), exclusive = candidateImageIds.filter(value => !oldImageIds.has(value))
    const binding = { attemptId: get('--attempt-id'), deploymentNonce: get('--deployment-nonce'), keyId: readRegular(KEY_ID_PATH, 128).toString('utf8').trim(), candidate: { releaseId: get('--candidate-release-id'), gitSha: get('--candidate-git-sha'), manifestSha256: get('--candidate-manifest-sha256'), imageSetDigest: get('--candidate-image-set-digest') }, recovery }
    const candidateIdentity = { release_id: binding.candidate.releaseId, release_git_sha: binding.candidate.gitSha, manifest_sha256: binding.candidate.manifestSha256, image_set_digest: binding.candidate.imageSetDigest }
    assert(canonical(containers.map(value => value.service).sort()) === canonical(recovery.services), 'reviewed service map must exactly match the frozen recovery runtime services')
    const observed = { composeProject: get('--compose-project'), containers, inventory: collectInventory(), candidateImageIds, candidateExclusiveRunning: candidateContainersRunning(exclusive), candidateIdentityRunning: candidateIdentityRunning(candidateIdentity), database: collectDatabase(process.env.DATABASE_URL) }
    writeAtomic(statePath, createSignedSnapshot(observed, binding, privatePem, publicPem)); process.stdout.write('preidentity snapshot captured\n'); return
  }
  protectedPath(statePath, 'preidentity journal', 0o600)
  const document = JSON.parse(readRegular(statePath).toString('utf8'))
  if (command === 'phase') { writeAtomic(statePath, transitionJournal(document, get('--phase'), privatePem, publicPem), true); process.stdout.write(`preidentity phase recorded: ${get('--phase')}\n`); return }
  const planPath = get('--recovery-plan'), mapPath = get('--service-map')
  protectedPath(planPath, 'recovery plan'); protectedPath(mapPath, 'reviewed service map')
  const nonce = get('--deployment-nonce'), recovery = parsePlan(planPath)
  verifyNonceLedger(nonce, document.candidate)
  const containers = collectContainers(mapPath); assert(canonical(containers.map(value => value.service).sort()) === canonical(recovery.services), 'reviewed service map must exactly match the frozen recovery runtime services')
  const observed = { composeProject: get('--compose-project'), containers, inventory: collectInventory() }
  const database = collectDatabase(process.env.DATABASE_URL)
  verifyRecoveryAuthorization(document, { observed, database, deploymentNonce: nonce, recovery, candidateContainersRunning: candidateContainersRunning(document.candidate.exclusive_image_ids) || candidateIdentityRunning(document.candidate) }, publicPem)
  if (command === 'verify') { process.stdout.write('preidentity forward recovery authorized\n'); return }
  writeAtomic(statePath, transitionJournal(document, 'recovery_started', privatePem, publicPem), true)
  assert(database.invalidConcurrentIndexes.length === 0, 'invalid concurrent index requires manual recovery')
  const compose = get('--recovery-compose'), env = get('--recovery-env'), digests = get('--recovery-image-digests')
  for (const [path, label] of [[compose, 'recovery Compose'], [env, 'recovery environment'], [digests, 'recovery image digests']]) protectedPath(path, label)
  assert(digest(readRegular(compose)) === recovery.composeSha256 && digest(readRegular(env)) === recovery.envSha256 && digest(readRegular(digests)) === recovery.imageDigestsSha256, 'recovery artifacts changed')
  const project = get('--compose-project'), timeout = get('--wait-timeout') ?? '300'; assert(/^(?:[3-9][0-9]|[1-8][0-9]{2}|900)$/u.test(timeout), 'wait timeout must be 30-900 seconds')
  const migration = spawnSync(BIN.docker, ['compose', '-p', project, '--env-file', env, '-f', compose, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate'], { stdio: 'inherit', env: {} })
  assert(migration.status === 0, 'forward recovery migration failed; manual recovery required')
  const after = collectDatabase(process.env.DATABASE_URL); assert(after.invalidConcurrentIndexes.length === 0 && after.version === recovery.migrationTail && after.historySha256 === recovery.allowedPrefixSha256[recovery.migrationTail], 'forward recovery did not reach a valid target prefix; manual recovery required')
  const up = spawnSync(BIN.docker, ['compose', '-p', project, '--env-file', env, '-f', compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', timeout, ...document.recovery_target.services], { stdio: 'inherit', env: {} })
  assert(up.status === 0, 'forward recovery runtime failed; manual recovery required')
  const baseUrl = new URL(get('--production-api-base-url')); assert(baseUrl.protocol === 'https:' && baseUrl.origin === baseUrl.href.replace(/\/$/u, ''), 'production API base URL must be an exact HTTPS origin')
  cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${baseUrl.origin}/livez`])
  cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${baseUrl.origin}/readyz`])
  const release = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${baseUrl.origin}/releasez`])
  const identity = release.data?.release ?? release.release
  assert(identity?.release_id === recovery.releaseId && identity?.release_git_sha === recovery.gitSha && identity?.manifest_sha256 === recovery.manifestSha256 && identity?.image_set_digest === recovery.imageSetDigest, 'recovery runtime release identity mismatch; manual recovery required')
  const recoveryStarted = JSON.parse(readRegular(statePath).toString('utf8'))
  writeAtomic(statePath, transitionJournal(recoveryStarted, 'recovery_verified', privatePem, publicPem), true)
  process.stdout.write('preidentity forward recovery verified\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`preidentity recovery rejected: ${error.message}\n`); process.exitCode = 1 }
}
