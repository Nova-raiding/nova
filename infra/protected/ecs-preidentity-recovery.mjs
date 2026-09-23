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
const BIN = Object.freeze({ docker: '/usr/bin/docker', psql: '/usr/bin/psql', flock: '/usr/bin/flock', curl: '/usr/bin/curl', sha256sum: '/usr/bin/sha256sum' })
const TRANSITIONS = Object.freeze({ captured: ['nonce_consumed'], nonce_consumed: ['migration_started'], migration_started: ['migration_complete', 'recovery_started'], migration_complete: ['runtime_cutover_started', 'recovery_started'], runtime_cutover_started: ['runtime_identity_verified'], recovery_started: ['recovery_verified'], runtime_identity_verified: [], recovery_verified: [] })
const BRIDGE_TRANSITIONS = Object.freeze({ captured: ['nonce_consumed'], nonce_consumed: ['bridge_cutover_started'], bridge_cutover_started: ['bridge_identity_verified', 'bridge_recovery_started'], bridge_recovery_started: ['bridge_recovery_verified'], bridge_identity_verified: [], bridge_recovery_verified: [] })
const BRIDGE_UNLABELED_TRANSITIONS = Object.freeze({ captured: ['nonce_consumed'], nonce_consumed: ['bridge_cutover_started'], bridge_cutover_started: ['bridge_identity_verified', 'bridge_recovery_started'], bridge_recovery_started: ['bridge_runtime_recovery_verified'], bridge_runtime_recovery_verified: ['bridge_recovery_verified'], bridge_identity_verified: [], bridge_recovery_verified: [] })
const HEX = /^[a-f0-9]{64}$/u, IMAGE = /^sha256:[a-f0-9]{64}$/u, GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const UNLABELED_SERVICES = Object.freeze(['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync'])

function assert(value, message) { if (!value) throw new Error(message) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function canonicalDocker(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalDocker).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalDocker(item)}`).join(',')}}`
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
export function productionApiBaseUrl(value) {
  assert(typeof value === 'string' && value.length <= 2048, 'production API base URL is invalid')
  const url = new URL(value)
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'production API base URL must be HTTPS without credentials, query, or fragment')
  assert(url.pathname === '/' || /^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(url.pathname), 'production API path prefix is unsafe')
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '')
  const canonicalValue = `${url.origin}${prefix}`
  assert(value === canonicalValue || value === `${canonicalValue}/`, 'production API base URL must be canonical')
  return canonicalValue
}
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
  if (['bridge_code_only', 'bridge_unlabeled_code_only'].includes(binding.mode)) assert(observed.database.version === 242 && binding.recovery.migrationTail === 242, 'bridge code cutover must preserve the exact 242 schema')
  else assert(binding.mode === undefined, 'unknown deployment mode')
  assert(Array.isArray(binding.recovery.services) && binding.recovery.services.length > 0 && binding.recovery.services.every(value => /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)), 'recovery service list is invalid')
  if (binding.mode === 'bridge_unlabeled_code_only') {
    assert(HEX.test(binding.recovery.planSha256 ?? '') && HEX.test(binding.recovery.evidenceSha256 ?? '') && HEX.test(binding.recovery.archiveSha256 ?? ''), 'unlabeled recovery plan/evidence/archive digest is invalid')
  } else for (const field of ['composeSha256', 'envSha256', 'imageDigestsSha256']) assert(HEX.test(binding.recovery[field] ?? ''), `recovery ${field} is invalid`)
  const containers = normalizedContainers(observed.containers)
  assert(Array.isArray(observed.inventory) && observed.inventory.length > 0, 'complete Docker inventory is required')
  assert(Array.isArray(observed.candidateImageIds) && observed.candidateImageIds.length > 0 && observed.candidateImageIds.every(value => IMAGE.test(value)), 'candidate image IDs must be independently resolved')
  if (['bridge_code_only', 'bridge_unlabeled_code_only'].includes(binding.mode)) assert(observed.candidateServiceImageIds && containers.every(item => IMAGE.test(observed.candidateServiceImageIds[item.service] ?? '')), 'bridge candidate image IDs must cover every reviewed service')
  if (binding.mode === 'bridge_unlabeled_code_only') {
    assert(canonical(containers.map(item => item.service)) === canonical(UNLABELED_SERVICES), 'unlabeled takeover must contain only the seven reviewed API/worker services')
    assert(Array.isArray(observed.unlabeledTakeover) && observed.unlabeledTakeover.length === UNLABELED_SERVICES.length, 'seven frozen unlabeled container pairs are required')
    assert(canonical(observed.unlabeledTakeover.map(item => item.service)) === canonical(UNLABELED_SERVICES), 'unlabeled takeover service set changed')
    for (const pair of observed.unlabeledTakeover) {
      assert(pair.old.id === containers.find(item => item.service === pair.service)?.id && pair.old.image_id === containers.find(item => item.service === pair.service)?.image_id, `old unlabeled identity mismatch: ${pair.service}`)
      assert(pair.candidate.image_id === observed.candidateServiceImageIds[pair.service], `candidate unlabeled image mismatch: ${pair.service}`)
      for (const side of [pair.old, pair.candidate]) {
        assert(HEX.test(side.id) && IMAGE.test(side.image_id) && HEX.test(side.config_sha256) && HEX.test(side.host_sha256), `unlabeled container fingerprint is invalid: ${pair.service}`)
        assert(Array.isArray(side.networks) && side.networks.length > 0 && side.networks.every(net => typeof net.name === 'string' && HEX.test(net.id) && Array.isArray(net.aliases)), `unlabeled network identity is invalid: ${pair.service}`)
      }
    }
    assert(observed.unlabeledGateway && HEX.test(observed.unlabeledGateway.id) && HEX.test(observed.unlabeledGateway.nginx_config_sha256) && observed.inventory.some(item => item.id === observed.unlabeledGateway.id) && !containers.some(item => item.id === observed.unlabeledGateway.id), 'running external gateway and its effective routing configuration must be distinct and frozen in the signed Docker inventory')
  }
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
    recovery_target: { release_id: binding.recovery.releaseId, release_git_sha: binding.recovery.gitSha, manifest_sha256: binding.recovery.manifestSha256, image_set_digest: binding.recovery.imageSetDigest, ...(binding.mode === 'bridge_unlabeled_code_only' ? { plan_sha256: binding.recovery.planSha256, evidence_sha256: binding.recovery.evidenceSha256, archive_sha256: binding.recovery.archiveSha256 } : { compose_sha256: binding.recovery.composeSha256, env_sha256: binding.recovery.envSha256, image_digests_sha256: binding.recovery.imageDigestsSha256 }), migration_tail: binding.recovery.migrationTail, allowed_prefix_sha256: binding.recovery.allowedPrefixSha256, services: [...new Set(binding.recovery.services)].sort() },
    database_policy: { strategy: 'forward_only', minimum_version: observed.database.version, maximum_version: binding.recovery.migrationTail, target_version: binding.recovery.migrationTail, schema_downgrade: false },
    key_id: binding.keyId,
    ...(['bridge_code_only', 'bridge_unlabeled_code_only'].includes(binding.mode) ? { deployment_mode: binding.mode, predeployment_inventory: observed.inventory, candidate_service_image_ids: observed.candidateServiceImageIds } : {}),
    ...(binding.mode === 'bridge_unlabeled_code_only' ? { unlabeled_takeover: observed.unlabeledTakeover, unlabeled_gateway: observed.unlabeledGateway } : {}),
  }
  return signDocument(document, privatePem, publicPem)
}

export function transitionJournal(document, nextPhase, privatePem, publicPem, now = new Date()) {
  assert(verifyDocument(document, publicPem), 'journal signature is invalid')
  const transitions = document.deployment_mode === 'bridge_unlabeled_code_only' ? BRIDGE_UNLABELED_TRANSITIONS : document.deployment_mode === 'bridge_code_only' ? BRIDGE_TRANSITIONS : TRANSITIONS
  assert(transitions[document.phase]?.includes(nextPhase), 'journal phase transition is not monotonic')
  assert(Date.parse(document.expires_at) > now.getTime(), 'journal is expired')
  return signDocument({ ...document, phase: nextPhase, updated_at: now.toISOString(), signature_base64: undefined }, privatePem, publicPem)
}

export function verifyBridgeRecoveryAuthorization(document, input, publicPem, now = new Date()) {
  assert(verifyDocument(document, publicPem), 'bridge journal signature is invalid')
  assert(['bridge_code_only', 'bridge_unlabeled_code_only'].includes(document.deployment_mode) && ['bridge_cutover_started', 'bridge_recovery_started', 'bridge_runtime_recovery_verified'].includes(document.phase), 'journal phase does not permit bridge recovery')
  assert(Date.parse(document.expires_at) > now.getTime(), 'bridge journal is expired')
  assert(digest(input.deploymentNonce) === document.deployment_nonce_sha256, 'deployment nonce does not match bridge journal')
  assert(input.observed.composeProject === document.compose_project, 'Compose project changed')
  const expected = document.recovery_target, actual = input.recovery
  assert(actual.releaseId === expected.release_id && actual.gitSha === expected.release_git_sha && actual.manifestSha256 === expected.manifest_sha256 && actual.imageSetDigest === expected.image_set_digest, 'bridge recovery release identity mismatch')
  assert((document.deployment_mode === 'bridge_unlabeled_code_only'
    ? actual.planSha256 === expected.plan_sha256 && actual.evidenceSha256 === expected.evidence_sha256 && actual.archiveSha256 === expected.archive_sha256
    : actual.composeSha256 === expected.compose_sha256 && actual.envSha256 === expected.env_sha256 && actual.imageDigestsSha256 === expected.image_digests_sha256) && actual.migrationTail === 242, 'bridge recovery capsule mismatch')
  assert(canonical(actual.allowedPrefixSha256) === canonical(expected.allowed_prefix_sha256) && canonical([...new Set(actual.services)].sort()) === canonical(expected.services), 'bridge recovery policy changed')
  assert(input.database.version === 242 && input.database.historySha256 === document.database_before.migration_history_sha256 && (input.database.invalidConcurrentIndexes ?? []).length === 0, 'bridge recovery requires unchanged checksummed schema 242')
  const original = document.predeployment_workload.services
  const current = [...input.observed.containers].sort((a, b) => a.service.localeCompare(b.service))
  assert(canonical(current.map(item => item.service)) === canonical(original.map(item => item.service)), 'bridge reviewed service set changed')
  for (let index = 0; index < current.length; index += 1) {
    const before = original[index], after = current[index]
    if (after.missing === true) continue
    assert(/^[a-f0-9]{12,64}$/u.test(after.id ?? '') && IMAGE.test(after.imageId ?? '') && HEX.test(after.configHash ?? '') && ['running', 'stopped'].includes(after.state), `invalid bridge container observation: ${after.service}`)
    if (after.id === before.id && after.imageId === before.image_id && after.configHash === before.config_hash) continue
    if (document.phase === 'bridge_recovery_started' && after.imageId === before.image_id && after.configHash === before.config_hash) continue
    assert(document.candidate_service_image_ids?.[after.service] === after.imageId, `bridge service is neither original nor its reviewed candidate: ${after.service}`)
    if (after.service === 'api' || after.service === 'api-replica') {
      const identity = after.releaseIdentity
      assert(identity && identity.release_id === document.candidate.release_id && identity.release_git_sha === document.candidate.release_git_sha && identity.manifest_sha256 === document.candidate.manifest_sha256 && identity.image_set_digest === document.candidate.image_set_digest, `bridge candidate identity mismatch: ${after.service}`)
    }
  }
  const beforeInventory = document.predeployment_inventory, afterInventory = input.observed.inventory
  assert(Array.isArray(beforeInventory) && Array.isArray(afterInventory), 'complete bridge inventory is required')
  const beforeByName = new Map(beforeInventory.map(item => [item.name, item]))
  const afterByName = new Map(afterInventory.map(item => [item.name, item]))
  assert(beforeByName.size === beforeInventory.length && afterByName.size === afterInventory.length, 'bridge inventory has duplicate names')
  const reviewedIds = new Set(original.map(item => item.id))
  const reviewedNames = new Set(beforeInventory.filter(item => reviewedIds.has(item.id)).map(item => item.name))
  assert([...afterByName.keys()].every(name => beforeByName.has(name)), 'bridge inventory gained an unknown running container')
  for (let index = 0; index < current.length; index += 1) {
    const before = original[index], after = current[index]
    const name = beforeInventory.find(item => item.id === before.id)?.name
    assert(name && reviewedNames.has(name), `reviewed bridge container is absent from signed inventory: ${before.service}`)
    const running = afterByName.get(name)
    if (after.missing === true || after.state === 'stopped') assert(!running, `stopped bridge service remains in running inventory: ${before.service}`)
    else assert(running?.id === after.id && running?.image_id === after.imageId && running?.config_hash === after.configHash, `bridge service inspection and inventory disagree: ${before.service}`)
  }
  for (const [name, before] of beforeByName) {
    const after = afterByName.get(name)
    if (reviewedNames.has(name)) continue
    assert(after, `bridge inventory lost unreviewed container: ${name}`)
    if (!reviewedIds.has(before.id)) assert(canonical(after) === canonical(before), `unreviewed container changed during bridge cutover: ${name}`)
  }
  return { authorized: true, targetMigration: 242 }
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
    const environment = Object.fromEntries((inspect.Config?.Env ?? []).map(item => { const at = item.indexOf('='); return at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)] }))
    const releaseIdentity = { release_id: environment.RELEASE_ID, release_git_sha: environment.RELEASE_GIT_SHA, manifest_sha256: environment.RELEASE_MANIFEST_SHA256, image_set_digest: environment.RELEASE_IMAGE_SET_DIGEST }
    return { service: mapping.service, id: inspect.Id, imageId: inspect.Image, configHash, state: 'running', releaseIdentity }
  })
}
function collectBridgeContainers(mapPath) {
  const mappings = JSON.parse(readRegular(mapPath).toString('utf8'))
  assert(Array.isArray(mappings) && mappings.length > 0, 'bridge service map must be a non-empty array')
  assert(new Set(mappings.map(item => item.service)).size === mappings.length, 'bridge service map contains duplicates')
  return mappings.map(mapping => {
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(mapping.service ?? '') && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(mapping.container ?? ''), 'invalid bridge service mapping')
    const listed = cleanExec(BIN.docker, ['ps', '--all', '--filter', `name=^/${mapping.container}$`, '--format', '{{.ID}}']).trim().split(/\s+/u).filter(Boolean)
    assert(listed.length <= 1, `ambiguous bridge container: ${mapping.service}`)
    if (listed.length === 0) return { service: mapping.service, missing: true }
    const inspect = jsonCommand(BIN.docker, ['inspect', listed[0]])[0]
    assert(inspect?.Id && IMAGE.test(inspect.Image ?? ''), `invalid bridge container: ${mapping.service}`)
    const configHash = digest(Buffer.from(canonical({ image: inspect.Config?.Image, env: [...(inspect.Config?.Env ?? [])].sort(), entrypoint: inspect.Config?.Entrypoint ?? null, cmd: inspect.Config?.Cmd ?? null, mounts: (inspect.Mounts ?? []).map(({ Destination, Type, RW }) => ({ Destination, Type, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) })))
    const environment = Object.fromEntries((inspect.Config?.Env ?? []).map(item => { const at = item.indexOf('='); return at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)] }))
    return { service: mapping.service, id: inspect.Id, imageId: inspect.Image, configHash, state: inspect.State?.Running ? 'running' : 'stopped', releaseIdentity: { release_id: environment.RELEASE_ID, release_git_sha: environment.RELEASE_GIT_SHA, manifest_sha256: environment.RELEASE_MANIFEST_SHA256, image_set_digest: environment.RELEASE_IMAGE_SET_DIGEST } }
  })
}
function inspectExactContainer(id) {
  assert(HEX.test(id), 'full Docker container ID is required')
  const value = jsonCommand(BIN.docker, ['inspect', id])[0]
  assert(value?.Id === id && IMAGE.test(value.Image ?? '') && typeof value.Name === 'string', 'Docker container ID or image drifted')
  return value
}
function immutableContainerSpec(value) {
  const networks = Object.entries(value.NetworkSettings?.Networks ?? {}).map(([name, net]) => ({
    name, id: net.NetworkID, aliases: [...(net.Aliases ?? [])].sort(),
  })).sort((a, b) => a.name.localeCompare(b.name))
  assert(networks.length > 0 && networks.every(net => /^[a-zA-Z0-9_.-]+$/u.test(net.name) && HEX.test(net.id) && net.aliases.every(alias => typeof alias === 'string')), 'container network bindings are invalid')
  return { id: value.Id, image_id: value.Image, config_sha256: digest(Buffer.from(canonicalDocker(value.Config))), host_sha256: digest(Buffer.from(canonicalDocker(value.HostConfig))), networks }
}
function readServiceMap(path) {
  protectedPath(path, 'unlabeled service map')
  const value = JSON.parse(readRegular(path).toString('utf8'))
  assert(Array.isArray(value) && value.length === UNLABELED_SERVICES.length && canonical(value.map(item => item.service).sort()) === canonical(UNLABELED_SERVICES), 'unlabeled service map must contain exactly seven services')
  assert(value.every(item => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(item.container ?? '')) && new Set(value.map(item => item.container)).size === value.length, 'unlabeled container names are invalid or duplicate')
  return value.sort((a, b) => a.service.localeCompare(b.service))
}
function collectUnlabeledTakeover(oldMapPath, candidateMapPath, imageIds, candidate) {
  const oldMap = readServiceMap(oldMapPath), candidateMap = readServiceMap(candidateMapPath)
  const pairs = oldMap.map((oldMapping, index) => {
    const nextMapping = candidateMap[index]
    assert(oldMapping.container === `merchant-production-${oldMapping.service}-1`, `historical gateway/API service graph name changed: ${oldMapping.service}`)
    const old = jsonCommand(BIN.docker, ['inspect', oldMapping.container])[0]
    const next = jsonCommand(BIN.docker, ['inspect', nextMapping.container])[0]
    assert(old?.Name === `/${oldMapping.container}` && next?.Name === `/${nextMapping.container}` && HEX.test(old?.Id ?? '') && HEX.test(next?.Id ?? '') && old.Id !== next.Id, `unlabeled service identity is invalid: ${oldMapping.service}`)
    assert(old.State?.Running === true && next.State?.Running === false, `unlabeled old/candidate running state is invalid: ${oldMapping.service}`)
    assert(!old.Config?.Labels?.['com.docker.compose.project'] && !old.Config?.Labels?.['com.docker.compose.service'], `old service unexpectedly has Compose ownership: ${oldMapping.service}`)
    assert(next.Image === imageIds[oldMapping.service], `candidate fixed image differs from reviewed Compose: ${oldMapping.service}`)
    const env = Object.fromEntries((next.Config?.Env ?? []).map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)] }))
    assert(env.BRIDGE_SCHEMA_COMPATIBILITY_MODE === 'prefix_242_or_244', `candidate bridge schema mode missing: ${oldMapping.service}`)
    if (oldMapping.service === 'api-replica') assert(env.RELEASE_ID === candidate.releaseId && env.RELEASE_GIT_SHA === candidate.gitSha && env.RELEASE_MANIFEST_SHA256 === candidate.manifestSha256 && env.RELEASE_IMAGE_SET_DIGEST === candidate.imageSetDigest, 'candidate API release identity is invalid')
    const oldSpec = immutableContainerSpec(old), candidateSpec = immutableContainerSpec(next)
    assert(oldMapping.container_id === oldSpec.id && oldMapping.image_id === oldSpec.image_id
      && oldMapping.config_sha256 === oldSpec.config_sha256 && oldMapping.host_sha256 === oldSpec.host_sha256
      && oldMapping.networks_sha256 === digest(Buffer.from(canonical(oldSpec.networks))),
    `historical root-only rollback fingerprint drifted: ${oldMapping.service}`)
    assert(canonical(oldSpec.networks.map(net => [net.name, net.id])) === canonical(candidateSpec.networks.map(net => [net.name, net.id])), `candidate network topology differs from old: ${oldMapping.service}`)
    const parkedName = `${oldMapping.container}.parked.${candidate.releaseId}`
    assert(parkedName.length <= 127 && /^[A-Za-z0-9][A-Za-z0-9_.-]+$/u.test(parkedName), 'parked container name is unsafe')
    return { service: oldMapping.service, old_name: oldMapping.container, candidate_name: nextMapping.container, parked_name: parkedName, old: oldSpec, candidate: candidateSpec }
  })
  assert(new Set(pairs.flatMap(item => [item.old_name, item.candidate_name, item.parked_name])).size === pairs.length * 3, 'unlabeled takeover names must be globally unique')
  return pairs
}
function validateUnlabeledPair(pair) {
  const old = inspectExactContainer(pair.old.id), candidate = inspectExactContainer(pair.candidate.id)
  for (const [actual, expected, label] of [[old, pair.old, 'old'], [candidate, pair.candidate, 'candidate']]) {
    const spec = immutableContainerSpec(actual)
    assert(spec.id === expected.id && spec.image_id === expected.image_id && spec.config_sha256 === expected.config_sha256 && spec.host_sha256 === expected.host_sha256, `${label} unlabeled container configuration drifted: ${pair.service}`)
    assert(canonical(spec.networks) === canonical(expected.networks), `${label} unlabeled container network or alias drifted: ${pair.service}`)
  }
  return { old, candidate }
}
function collectUnlabeledGateway(id) {
  const gateway = inspectExactContainer(id)
  assert(gateway.State?.Running === true, 'external gateway is not running')
  const bindings = Object.values(gateway.HostConfig?.PortBindings ?? {}).flatMap(values => values ?? []).map(value => String(value.HostPort))
  assert(bindings.includes('80') && bindings.includes('443'), 'external gateway does not own public 80/443')
  const spec = immutableContainerSpec(gateway)
  assert(spec.networks.some(net => net.name === 'merchant-production_default'), 'external gateway is not attached to the reviewed API network')
  const config = cleanExec(BIN.docker, ['exec', id, 'nginx', '-T'])
  const upstream = /^\s*upstream\s+pilot_api\s*\{([^}]*)\}/mu.exec(config)?.[1]
  const servers = [...(upstream ?? '').matchAll(/^\s*server\s+([^;]+);\s*$/gmu)].map(match => match[1].trim())
  assert(servers.length === 1 && servers[0] === 'merchant-production-api-replica-1:8787 resolve' && /^\s*proxy_pass\s+http:\/\/pilot_api(?:\/[^;\s]*)?;\s*$/mu.test(config), 'external gateway does not route to the reviewed historical API DNS name')
  return { ...spec, nginx_config_sha256: digest(Buffer.from(config)) }
}
function validateUnlabeledGateway(document) {
  if (document.deployment_mode !== 'bridge_unlabeled_code_only') return
  const observed = collectUnlabeledGateway(document.unlabeled_gateway?.id)
  assert(canonical(observed) === canonical(document.unlabeled_gateway), 'external gateway Docker identity or network changed')
}
export function switchUnlabeledPairs(pairs, actions) {
  for (const pair of pairs) {
    actions.stop(pair.old.id)
    actions.rename(pair.old.id, pair.parked_name)
    actions.rename(pair.candidate.id, pair.old_name)
    actions.start(pair.candidate.id)
  }
}
export function recoverUnlabeledPairs(pairs, actions) {
  for (const pair of [...pairs].reverse()) {
    let candidate = actions.inspect(pair.candidate.id)
    let old = actions.inspect(pair.old.id)
    assert([pair.candidate_name, pair.old_name].includes(candidate.name) && [pair.old_name, pair.parked_name].includes(old.name) && candidate.name !== old.name, `unlabeled recovery name is outside signed pair: ${pair.service}`)
    if (candidate.running) actions.stop(pair.candidate.id)
    candidate = actions.inspect(pair.candidate.id)
    if (candidate.name === pair.old_name) actions.rename(pair.candidate.id, pair.candidate_name)
    old = actions.inspect(pair.old.id)
    if (old.name === pair.parked_name) actions.rename(pair.old.id, pair.old_name)
    old = actions.inspect(pair.old.id)
    if (!old.running) actions.start(pair.old.id)
  }
}
function collectInventory(allowEmpty = false) {
  const ids = cleanExec(BIN.docker, ['ps', '-q', '--no-trunc']).trim().split(/\s+/u).filter(Boolean)
  assert(allowEmpty || ids.length > 0, 'Docker running-container inventory is empty')
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
function collectCandidateServiceImageIds(composePath, project, services) {
  const document = jsonCommand(BIN.docker, ['compose', '-p', project, '-f', composePath, 'config', '--format', 'json'])
  const mapping = document?.services
  assert(mapping && Object.getPrototypeOf(mapping) === Object.prototype, 'candidate Compose service map is invalid')
  const result = {}
  for (const service of services) {
    const ref = mapping[service]?.image
    assert(typeof ref === 'string' && /@sha256:[a-f0-9]{64}$/u.test(ref), `candidate Compose image reference missing for ${service}`)
    const imageId = cleanExec(BIN.docker, ['image', 'inspect', '--format', '{{.Id}}', ref]).trim()
    assert(IMAGE.test(imageId), `candidate image ID invalid for ${service}`)
    result[service] = imageId
  }
  return result
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
function parseUnlabeledPlan(path, evidencePath, archivePath) {
  protectedPath(path, 'unlabeled recovery plan')
  assert((lstatSync(path).mode & 0o077) === 0, 'unlabeled recovery plan must be root-only')
  const planBytes = readRegular(path)
  const plan = JSON.parse(planBytes.toString('utf8')), target = plan.target, old = plan.old_runtime
  assert(plan.schema_version === '1' && plan.kind === 'ecs-unlabeled-id-recovery-capsule' && plan.compose_project === 'merchant-production', 'dedicated unlabeled recovery plan is required')
  const created = Date.parse(plan.created_at ?? ''), expires = Date.parse(plan.expires_at ?? '')
  assert(Number.isFinite(created) && Number.isFinite(expires) && plan.created_at === new Date(created).toISOString() && plan.expires_at === new Date(expires).toISOString() && created <= Date.now() + 300_000 && expires > Date.now() && expires - created <= 86_400_000, 'unlabeled recovery capsule is expired or exceeds 24 hours')
  assert(plan.database?.strategy === 'forward_only' && plan.database?.schema_downgrade === false && plan.database?.live_migration_version === 242 && plan.database?.target_migration_tail === 242 && plan.volumes?.preserve === true, 'unlabeled recovery must preserve schema 242 and volumes')
  assert(canonical([...target.services].sort()) === canonical(UNLABELED_SERVICES), 'unlabeled recovery services differ from the historical seven')
  assert(HEX.test(old?.evidence_sha256 ?? '') && HEX.test(old?.archive_sha256 ?? ''), 'unlabeled evidence/archive digest is missing')
  protectedPath(evidencePath, 'old runtime evidence')
  protectedPath(archivePath, 'old image archive')
  assert((lstatSync(evidencePath).mode & 0o077) === 0 && (lstatSync(archivePath).mode & 0o077) === 0, 'old runtime evidence and archive must be root-only')
  assert(statSync(archivePath).size > 0 && statSync(archivePath).size <= 8 * 1024 ** 3, 'old image archive size is outside the reviewed bound')
  const evidenceBytes = readRegular(evidencePath, 1024 * 1024)
  assert(digest(evidenceBytes) === old.evidence_sha256, 'old runtime evidence changed')
  const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  assert(evidence.schema_version === 'ecs-bridge-old-runtime/1' && evidence.signed === false && evidence.cutover_authorized === false, 'old runtime evidence authority is invalid')
  assert(evidence.runtime?.source_git_sha === target.git_sha, 'old runtime evidence Git SHA differs from recovery target')
  assert(evidence.backup?.archive_sha256 === old.archive_sha256 && evidence.backup?.kind === 'docker-save-three-image', 'old image archive differs from frozen evidence')
  const archiveHash = cleanExec(BIN.sha256sum, [archivePath]).trim().split(/\s+/u)[0]
  assert(archiveHash === old.archive_sha256, 'old image archive changed')
  assert(canonical(old.container_ids) === canonical(Object.fromEntries(evidence.runtime.services.map(item => [item.service, item.id]))) && canonical(old.config_sha256) === canonical(Object.fromEntries(evidence.runtime.services.map(item => [item.service, item.config_sha256]))), 'old seven-container identity/config differs from frozen evidence')
  assert(old.gateway_id === evidence.runtime.gateway.id && canonical(old.image_ids) === canonical(evidence.runtime.preserved_image_ids), 'old gateway or image IDs differ from frozen evidence')
  return { releaseId: target.release_id, gitSha: target.git_sha, manifestSha256: target.manifest_sha256, imageSetDigest: target.image_set_digest, planSha256: digest(planBytes), evidenceSha256: old.evidence_sha256, archiveSha256: old.archive_sha256, migrationTail: 242, allowedPrefixSha256: plan.database.allowed_prefix_sha256, services: target.services, oldRuntime: old, evidence, current: plan.current }
}
function assertUnlabeledCaptureEvidence(recovery, takeover, gateway) {
  assert(recovery.evidence.runtime.gateway.id === gateway.id && recovery.oldRuntime.gateway_id === gateway.id, 'signed external gateway differs from frozen old runtime')
  for (const pair of takeover) {
    const expected = recovery.evidence.runtime.services.find(item => item.service === pair.service)
    assert(expected && pair.old.id === expected.id && pair.old.image_id === expected.image_id && pair.old.config_sha256 === expected.config_sha256 && pair.old.host_sha256 === expected.host_sha256 && canonical(pair.old.networks) === canonical(expected.networks), `frozen old runtime mismatch: ${pair.service}`)
  }
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
  capture: { ...COMMON, '--attempt-id': true, '--service-map': true, '--candidate-service-map': false, '--external-gateway-id': false, '--old-runtime-evidence': false, '--old-image-archive': false, '--compose-project': true, '--candidate-release-id': true, '--candidate-git-sha': true, '--candidate-manifest-sha256': true, '--candidate-image-set-digest': true, '--candidate-image-digests': true, '--candidate-compose': false, '--deployment-nonce': true, '--recovery-plan': true, '--mode': false },
  phase: { ...COMMON, '--phase': true },
  verify: { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true },
  recover: { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--recovery-compose': true, '--recovery-env': true, '--recovery-image-digests': true, '--production-api-base-url': true, '--wait-timeout': false },
  'bridge-begin': { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--old-runtime-evidence': false, '--old-image-archive': false, '--production-api-base-url': true },
  'bridge-verify': { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': false, '--old-runtime-evidence': false, '--old-image-archive': false, '--production-api-base-url': true },
  'bridge-recover': { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--recovery-compose': true, '--recovery-env': true, '--recovery-image-digests': true, '--production-api-base-url': true, '--wait-timeout': false },
  'bridge-finalize': { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--old-runtime-evidence': false, '--old-image-archive': false, '--production-api-base-url': true },
  'bridge-switch-unlabeled': { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--old-runtime-evidence': true, '--old-image-archive': true, '--production-api-base-url': true },
  'bridge-recover-unlabeled': { ...COMMON, '--service-map': true, '--compose-project': true, '--deployment-nonce': true, '--recovery-plan': true, '--old-runtime-evidence': false, '--old-image-archive': false, '--production-api-base-url': true },
})
function main(args) {
  assertRuntime(); const command = args[0]; assert(Object.hasOwn(SPECS, command), 'expected capture, phase, verify, or recover'); const options = parseOptions(args.slice(1), SPECS[command]); const get = name => options[name]; const statePath = get('--state'); assertInheritedLock(get('--lock-path'))
  const productionBase = ['recover', 'bridge-begin', 'bridge-verify', 'bridge-recover', 'bridge-finalize', 'bridge-switch-unlabeled', 'bridge-recover-unlabeled'].includes(command) ? productionApiBaseUrl(get('--production-api-base-url')) : undefined
  const privatePem = readRegular(PRIVATE_KEY_PATH, 8192), publicPem = readRegular(PUBLIC_KEY_PATH, 8192)
  if (command === 'capture') {
    const planPath = get('--recovery-plan'), mapPath = get('--service-map'), candidateDigestsPath = get('--candidate-image-digests')
    protectedPath(planPath, 'recovery plan'); protectedPath(mapPath, 'reviewed service map'); protectedPath(candidateDigestsPath, 'candidate image digests')
    const recovery = get('--mode') === 'bridge_unlabeled_code_only' ? parseUnlabeledPlan(planPath, get('--old-runtime-evidence'), get('--old-image-archive')) : parsePlan(planPath)
    const containers = collectContainers(mapPath)
    if (['bridge_code_only', 'bridge_unlabeled_code_only'].includes(get('--mode'))) protectedPath(get('--candidate-compose'), 'bridge candidate Compose')
    const candidateServiceImageIds = ['bridge_code_only', 'bridge_unlabeled_code_only'].includes(get('--mode')) ? collectCandidateServiceImageIds(get('--candidate-compose'), get('--compose-project'), containers.map(item => item.service)) : undefined
    const candidateImageIds = candidateServiceImageIds ? Object.values(candidateServiceImageIds) : collectCandidateImageIds(candidateDigestsPath)
    const oldImageIds = new Set(containers.map(value => value.imageId)), exclusive = candidateImageIds.filter(value => !oldImageIds.has(value))
    const binding = { attemptId: get('--attempt-id'), deploymentNonce: get('--deployment-nonce'), keyId: readRegular(KEY_ID_PATH, 128).toString('utf8').trim(), candidate: { releaseId: get('--candidate-release-id'), gitSha: get('--candidate-git-sha'), manifestSha256: get('--candidate-manifest-sha256'), imageSetDigest: get('--candidate-image-set-digest') }, recovery, ...(get('--mode') ? { mode: get('--mode') } : {}) }
    if (get('--mode') === 'bridge_unlabeled_code_only') assert(recovery.current?.release_id === binding.candidate.releaseId && recovery.current?.git_sha === binding.candidate.gitSha && recovery.current?.manifest_sha256 === binding.candidate.manifestSha256 && recovery.current?.image_set_digest === binding.candidate.imageSetDigest, 'unlabeled capsule current identity differs from candidate')
    const candidateIdentity = { release_id: binding.candidate.releaseId, release_git_sha: binding.candidate.gitSha, manifest_sha256: binding.candidate.manifestSha256, image_set_digest: binding.candidate.imageSetDigest }
    assert(canonical(containers.map(value => value.service).sort()) === canonical(recovery.services), 'reviewed service map must exactly match the frozen recovery runtime services')
    const unlabeledTakeover = get('--mode') === 'bridge_unlabeled_code_only' ? collectUnlabeledTakeover(mapPath, get('--candidate-service-map'), candidateServiceImageIds, binding.candidate) : undefined
    const unlabeledGateway = get('--mode') === 'bridge_unlabeled_code_only' ? collectUnlabeledGateway(get('--external-gateway-id')) : undefined
    if (unlabeledTakeover) assertUnlabeledCaptureEvidence(recovery, unlabeledTakeover, unlabeledGateway)
    const observed = { composeProject: get('--compose-project'), containers, inventory: collectInventory(), candidateImageIds, ...(candidateServiceImageIds ? { candidateServiceImageIds } : {}), ...(unlabeledTakeover ? { unlabeledTakeover, unlabeledGateway } : {}), candidateExclusiveRunning: candidateContainersRunning(exclusive), candidateIdentityRunning: candidateIdentityRunning(candidateIdentity), database: collectDatabase(process.env.DATABASE_URL) }
    writeAtomic(statePath, createSignedSnapshot(observed, binding, privatePem, publicPem)); process.stdout.write('preidentity snapshot captured\n'); return
  }
  protectedPath(statePath, 'preidentity journal', 0o600)
  const document = JSON.parse(readRegular(statePath).toString('utf8'))
  if (command === 'phase') { assert(!['bridge_code_only', 'bridge_unlabeled_code_only'].includes(document.deployment_mode) || get('--phase') === 'nonce_consumed', 'bridge transitions require observed CLI checks'); writeAtomic(statePath, transitionJournal(document, get('--phase'), privatePem, publicPem), true); process.stdout.write(`preidentity phase recorded: ${get('--phase')}\n`); return }
  if (command.startsWith('bridge-')) {
    assert(['bridge_code_only', 'bridge_unlabeled_code_only'].includes(document.deployment_mode) && verifyDocument(document, publicPem), 'signed bridge journal is required')
    assert(Date.parse(document.expires_at) > Date.now(), 'bridge journal is expired')
    validateUnlabeledGateway(document)
    protectedPath(get('--service-map'), 'bridge reviewed service map')
    if (command !== 'bridge-verify') protectedPath(get('--recovery-plan'), 'bridge recovery plan')
    verifyNonceLedger(get('--deployment-nonce'), document.candidate)
    const partialObservation = ['bridge-recover', 'bridge-recover-unlabeled'].includes(command)
    const containers = partialObservation ? collectBridgeContainers(get('--service-map')) : collectContainers(get('--service-map'))
    const observed = { composeProject: get('--compose-project'), containers, inventory: collectInventory(partialObservation) }
    const database = collectDatabase(process.env.DATABASE_URL)
    if (command === 'bridge-begin') {
      assert(document.phase === 'nonce_consumed', 'bridge cutover has already begun or nonce is not consumed')
      const recovery = document.deployment_mode === 'bridge_unlabeled_code_only' ? parseUnlabeledPlan(get('--recovery-plan'), get('--old-runtime-evidence'), get('--old-image-archive')) : parsePlan(get('--recovery-plan'))
      assert(database.version === 242 && database.historySha256 === document.database_before.migration_history_sha256 && database.invalidConcurrentIndexes.length === 0, 'bridge begin requires unchanged checksummed schema 242')
      assert(workloadDigest(containers) === document.predeployment_workload.container_set_digest && inventoryDigest(observed.inventory) === document.predeployment_workload.inventory_digest, 'bridge begin requires unchanged complete Docker inventory')
      assert(recovery.migrationTail === 242 && recovery.releaseId === document.recovery_target.release_id && recovery.gitSha === document.recovery_target.release_git_sha && recovery.manifestSha256 === document.recovery_target.manifest_sha256 && recovery.imageSetDigest === document.recovery_target.image_set_digest && (document.deployment_mode === 'bridge_unlabeled_code_only' ? recovery.planSha256 === document.recovery_target.plan_sha256 && recovery.evidenceSha256 === document.recovery_target.evidence_sha256 && recovery.archiveSha256 === document.recovery_target.archive_sha256 : recovery.composeSha256 === document.recovery_target.compose_sha256 && recovery.envSha256 === document.recovery_target.env_sha256 && recovery.imageDigestsSha256 === document.recovery_target.image_digests_sha256) && canonical(recovery.allowedPrefixSha256) === canonical(document.recovery_target.allowed_prefix_sha256) && canonical([...new Set(recovery.services)].sort()) === canonical(document.recovery_target.services), 'bridge begin recovery target changed')
      const currentRelease = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/releasez`])
      const identity = currentRelease.data?.release ?? currentRelease.release
      assert(identity?.release_id === recovery.releaseId && identity?.release_git_sha === recovery.gitSha && identity?.manifest_sha256 === recovery.manifestSha256 && identity?.image_set_digest === recovery.imageSetDigest, 'bridge begin requires old public release identity')
      writeAtomic(statePath, transitionJournal(document, 'bridge_cutover_started', privatePem, publicPem), true)
      process.stdout.write('bridge code cutover authorized; schema remains 242\n'); return
    }
    if (command === 'bridge-verify') {
      if (document.deployment_mode === 'bridge_unlabeled_code_only') {
        const recovery = parseUnlabeledPlan(get('--recovery-plan'), get('--old-runtime-evidence'), get('--old-image-archive'))
        assert(recovery.planSha256 === document.recovery_target.plan_sha256 && recovery.evidenceSha256 === document.recovery_target.evidence_sha256 && recovery.archiveSha256 === document.recovery_target.archive_sha256, 'bridge verify recovery capsule changed')
      }
      assert(document.phase === 'bridge_cutover_started', 'bridge verification phase is invalid')
      assert(database.version === 242 && database.historySha256 === document.database_before.migration_history_sha256 && database.invalidConcurrentIndexes.length === 0, 'bridge cutover changed schema 242')
      assert(canonical(containers.map(item => item.service).sort()) === canonical(document.predeployment_workload.services.map(item => item.service)), 'bridge reviewed service set changed')
      assert(canonical(observed.inventory.map(item => item.name).sort()) === canonical(document.predeployment_inventory.map(item => item.name).sort()), 'bridge container inventory changed')
      const reviewedIds = new Set(document.predeployment_workload.services.map(item => item.id))
      const currentByName = new Map(observed.inventory.map(item => [item.name, item]))
      for (const item of document.predeployment_inventory) if (!reviewedIds.has(item.id)) assert(canonical(currentByName.get(item.name)) === canonical(item), `unreviewed container changed during bridge cutover: ${item.name}`)
      for (const item of containers) {
        assert(item.imageId === document.candidate_service_image_ids[item.service], `bridge candidate image mismatch: ${item.service}`)
        if (document.deployment_mode === 'bridge_unlabeled_code_only') assert(item.id === document.unlabeled_takeover.find(value => value.service === item.service)?.candidate.id, `bridge candidate container ID mismatch: ${item.service}`)
        if (item.service === 'api' || item.service === 'api-replica') assert(item.releaseIdentity.release_id === document.candidate.release_id && item.releaseIdentity.release_git_sha === document.candidate.release_git_sha && item.releaseIdentity.manifest_sha256 === document.candidate.manifest_sha256 && item.releaseIdentity.image_set_digest === document.candidate.image_set_digest, `bridge API identity mismatch: ${item.service}`)
      }
      cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/livez`])
      cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/readyz`])
      const release = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/releasez`])
      const identity = release.data?.release ?? release.release
      assert(identity?.release_id === document.candidate.release_id && identity?.release_git_sha === document.candidate.release_git_sha && identity?.manifest_sha256 === document.candidate.manifest_sha256 && identity?.image_set_digest === document.candidate.image_set_digest, 'bridge public release identity mismatch')
      writeAtomic(statePath, transitionJournal(document, 'bridge_identity_verified', privatePem, publicPem), true)
      process.stdout.write('bridge code cutover verified\n'); return
    }
    const recovery = document.deployment_mode === 'bridge_unlabeled_code_only' ? parseUnlabeledPlan(get('--recovery-plan'), get('--old-runtime-evidence'), get('--old-image-archive')) : parsePlan(get('--recovery-plan'))
    if (command === 'bridge-switch-unlabeled') {
      assert(document.deployment_mode === 'bridge_unlabeled_code_only' && document.phase === 'bridge_cutover_started', 'signed unlabeled takeover has not been authorized')
      verifyBridgeRecoveryAuthorization(document, { observed, database, deploymentNonce: get('--deployment-nonce'), recovery }, publicPem)
      assert(workloadDigest(containers) === document.predeployment_workload.container_set_digest && inventoryDigest(observed.inventory) === document.predeployment_workload.inventory_digest, 'unlabeled takeover requires unchanged old workload and Docker inventory')
      for (const pair of document.unlabeled_takeover) {
        const { old, candidate } = validateUnlabeledPair(pair)
        assert(old.Name === `/${pair.old_name}` && old.State?.Running === true && candidate.Name === `/${pair.candidate_name}` && candidate.State?.Running === false, `unlabeled pair is not in the captured initial state: ${pair.service}`)
      }
      const oldRelease = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/releasez`])
      const oldIdentity = oldRelease.data?.release ?? oldRelease.release
      assert(oldIdentity?.release_id === recovery.releaseId && oldIdentity?.release_git_sha === recovery.gitSha && oldIdentity?.manifest_sha256 === recovery.manifestSha256 && oldIdentity?.image_set_digest === recovery.imageSetDigest, 'unlabeled takeover requires the original public release')
      switchUnlabeledPairs(document.unlabeled_takeover, {
        stop: id => cleanExec(BIN.docker, ['stop', '--time', '30', id]),
        rename: (id, name) => cleanExec(BIN.docker, ['rename', id, name]),
        start: id => cleanExec(BIN.docker, ['start', id]),
      })
      process.stdout.write('seven fixed B containers acquired historical names; public identity verification remains required\n'); return
    }
    if (command === 'bridge-recover-unlabeled') {
      assert(document.deployment_mode === 'bridge_unlabeled_code_only', 'unlabeled recovery requires its dedicated signed journal')
      verifyBridgeRecoveryAuthorization(document, { observed, database, deploymentNonce: get('--deployment-nonce'), recovery }, publicPem)
      for (const pair of document.unlabeled_takeover) {
        const { old, candidate } = validateUnlabeledPair(pair)
        assert([`/${pair.old_name}`, `/${pair.parked_name}`].includes(old.Name) && [`/${pair.old_name}`, `/${pair.candidate_name}`].includes(candidate.Name), `unlabeled container name is outside the signed handoff: ${pair.service}`)
        assert(!(old.Name === `/${pair.old_name}` && candidate.Name === `/${pair.old_name}`), `ambiguous unlabeled service name: ${pair.service}`)
      }
      if (document.phase === 'bridge_cutover_started') writeAtomic(statePath, transitionJournal(document, 'bridge_recovery_started', privatePem, publicPem), true)
      recoverUnlabeledPairs(document.unlabeled_takeover, {
        inspect: id => { const value = inspectExactContainer(id); return { name: value.Name.slice(1), running: value.State?.Running === true } },
        stop: id => cleanExec(BIN.docker, ['stop', '--time', '30', id]),
        rename: (id, name) => cleanExec(BIN.docker, ['rename', id, name]),
        start: id => cleanExec(BIN.docker, ['start', id]),
      })
      const restored = collectContainers(get('--service-map')), inventory = collectInventory(), after = collectDatabase(process.env.DATABASE_URL)
      assert(after.version === 242 && after.historySha256 === document.database_before.migration_history_sha256 && after.invalidConcurrentIndexes.length === 0, 'unlabeled recovery changed checksummed schema 242')
      assert(restored.every(item => { const pair = document.unlabeled_takeover.find(value => value.service === item.service); return item.id === pair.old.id && item.imageId === pair.old.image_id && item.configHash === document.predeployment_workload.services.find(value => value.service === item.service)?.config_hash }), 'unlabeled recovery did not restore the original container IDs and configurations')
      assert(inventoryDigest(inventory) === document.predeployment_workload.inventory_digest, 'unlabeled recovery did not restore the exact running Docker inventory')
      for (const pair of document.unlabeled_takeover) validateUnlabeledPair(pair)
      const started = JSON.parse(readRegular(statePath).toString('utf8'))
      if (started.phase === 'bridge_recovery_started') writeAtomic(statePath, transitionJournal(started, 'bridge_runtime_recovery_verified', privatePem, publicPem), true)
      process.stdout.write('seven historical container IDs restored; public old identity still requires finalization\n'); return
    }
    if (command === 'bridge-finalize') {
      assert(document.phase === 'bridge_runtime_recovery_verified', 'bridge public recovery requires verified old runtime first')
      verifyBridgeRecoveryAuthorization(document, { observed, database, deploymentNonce: get('--deployment-nonce'), recovery }, publicPem)
      assert(containers.every(item => { const before = document.predeployment_workload.services.find(value => value.service === item.service); return item.imageId === before?.image_id && item.configHash === before?.config_hash }), 'bridge finalization requires original service images and runtime configuration')
      if (document.deployment_mode === 'bridge_unlabeled_code_only') assert(containers.every(item => item.id === document.unlabeled_takeover.find(value => value.service === item.service)?.old.id), 'bridge finalization requires the original historical container IDs')
      const originalInventory = document.predeployment_inventory, restoredInventory = observed.inventory
      assert(canonical(restoredInventory.map(item => item.name).sort()) === canonical(originalInventory.map(item => item.name).sort()), 'bridge finalization changed running container names')
      const reviewedIds = new Set(document.predeployment_workload.services.map(item => item.id))
      const restoredByName = new Map(restoredInventory.map(item => [item.name, item]))
      for (const item of originalInventory) if (!reviewedIds.has(item.id)) assert(canonical(restoredByName.get(item.name)) === canonical(item), `unreviewed container changed during bridge finalization: ${item.name}`)
      cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/livez`])
      cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/readyz`])
      const release = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/releasez`])
      const identity = release.data?.release ?? release.release
      assert(identity?.release_id === recovery.releaseId && identity?.release_git_sha === recovery.gitSha && identity?.manifest_sha256 === recovery.manifestSha256 && identity?.image_set_digest === recovery.imageSetDigest, 'bridge recovery public identity mismatch; signed journal remains retryable')
      writeAtomic(statePath, transitionJournal(document, 'bridge_recovery_verified', privatePem, publicPem), true)
      process.stdout.write('bridge public old identity verified after runtime recovery\n'); return
    }
    verifyBridgeRecoveryAuthorization(document, { observed, database, deploymentNonce: get('--deployment-nonce'), recovery }, publicPem)
    const compose = get('--recovery-compose'), env = get('--recovery-env'), digests = get('--recovery-image-digests')
    for (const [path, label] of [[compose, 'bridge recovery Compose'], [env, 'bridge recovery environment'], [digests, 'bridge recovery image digests']]) protectedPath(path, label)
    assert(digest(readRegular(compose)) === recovery.composeSha256 && digest(readRegular(env)) === recovery.envSha256 && digest(readRegular(digests)) === recovery.imageDigestsSha256, 'bridge recovery artifacts changed')
    const targetImageIds = Object.values(collectCandidateServiceImageIds(compose, get('--compose-project'), document.recovery_target.services))
    assert(document.predeployment_workload.services.every(item => targetImageIds.includes(item.image_id)), 'original bridge recovery image is not locally available')
    const timeout = get('--wait-timeout') ?? '300'; assert(/^(?:[3-9][0-9]|[1-8][0-9]{2}|900)$/u.test(timeout), 'wait timeout must be 30-900 seconds')
    if (document.phase === 'bridge_cutover_started') writeAtomic(statePath, transitionJournal(document, 'bridge_recovery_started', privatePem, publicPem), true)
    const up = spawnSync(BIN.docker, ['compose', '-p', get('--compose-project'), '--env-file', env, '-f', compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', timeout, ...document.recovery_target.services], { stdio: 'inherit', env: {} })
    assert(up.status === 0, 'bridge code recovery runtime failed; signed journal remains retryable')
    const after = collectDatabase(process.env.DATABASE_URL)
    assert(after.version === 242 && after.historySha256 === document.database_before.migration_history_sha256 && after.invalidConcurrentIndexes.length === 0, 'bridge code recovery changed schema 242')
    const restored = collectContainers(get('--service-map'))
    assert(restored.every(item => { const before = document.predeployment_workload.services.find(value => value.service === item.service); return item.imageId === before?.image_id && item.configHash === before?.config_hash }), 'bridge recovery did not restore original service images and runtime configuration')
    const restoredInventory = collectInventory()
    assert(canonical(restoredInventory.map(item => item.name).sort()) === canonical(document.predeployment_inventory.map(item => item.name).sort()), 'bridge recovery changed running container names')
    const reviewedIds = new Set(document.predeployment_workload.services.map(item => item.id))
    const restoredByName = new Map(restoredInventory.map(item => [item.name, item]))
    for (const item of document.predeployment_inventory) if (!reviewedIds.has(item.id)) assert(canonical(restoredByName.get(item.name)) === canonical(item), `unreviewed container changed during bridge recovery: ${item.name}`)
    cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/livez`])
    cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/readyz`])
    const release = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/releasez`])
    const identity = release.data?.release ?? release.release
    assert(identity?.release_id === recovery.releaseId && identity?.release_git_sha === recovery.gitSha && identity?.manifest_sha256 === recovery.manifestSha256 && identity?.image_set_digest === recovery.imageSetDigest, 'bridge recovery public identity mismatch; signed journal remains retryable')
    const started = JSON.parse(readRegular(statePath).toString('utf8'))
    writeAtomic(statePath, transitionJournal(started, 'bridge_recovery_verified', privatePem, publicPem), true)
    process.stdout.write('bridge code recovery verified without migration\n'); return
  }
  const planPath = get('--recovery-plan'), mapPath = get('--service-map')
  protectedPath(planPath, 'recovery plan'); protectedPath(mapPath, 'reviewed service map')
  const nonce = get('--deployment-nonce'), recovery = parsePlan(planPath)
  verifyNonceLedger(nonce, document.candidate)
  const containers = collectContainers(mapPath); assert(canonical(containers.map(value => value.service).sort()) === canonical(recovery.services), 'reviewed service map must exactly match the frozen recovery runtime services')
  const observed = { composeProject: get('--compose-project'), containers, inventory: collectInventory() }
  const database = collectDatabase(process.env.DATABASE_URL)
  verifyRecoveryAuthorization(document, { observed, database, deploymentNonce: nonce, recovery, candidateContainersRunning: candidateContainersRunning(document.candidate.exclusive_image_ids) || candidateIdentityRunning(document.candidate) }, publicPem)
  if (command === 'verify') { process.stdout.write('preidentity forward recovery authorized\n'); return }
  const compose = get('--recovery-compose'), env = get('--recovery-env'), digests = get('--recovery-image-digests')
  for (const [path, label] of [[compose, 'recovery Compose'], [env, 'recovery environment'], [digests, 'recovery image digests']]) protectedPath(path, label)
  assert(digest(readRegular(compose)) === recovery.composeSha256 && digest(readRegular(env)) === recovery.envSha256 && digest(readRegular(digests)) === recovery.imageDigestsSha256, 'recovery artifacts changed')
  const project = get('--compose-project'), timeout = get('--wait-timeout') ?? '300'; assert(/^(?:[3-9][0-9]|[1-8][0-9]{2}|900)$/u.test(timeout), 'wait timeout must be 30-900 seconds')
  assert(database.invalidConcurrentIndexes.length === 0, 'invalid concurrent index requires manual recovery')
  writeAtomic(statePath, transitionJournal(document, 'recovery_started', privatePem, publicPem), true)
  const migration = spawnSync(BIN.docker, ['compose', '-p', project, '--env-file', env, '-f', compose, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate'], { stdio: 'inherit', env: {} })
  assert(migration.status === 0, 'forward recovery migration failed; manual recovery required')
  const after = collectDatabase(process.env.DATABASE_URL); assert(after.invalidConcurrentIndexes.length === 0 && after.version === recovery.migrationTail && after.historySha256 === recovery.allowedPrefixSha256[recovery.migrationTail], 'forward recovery did not reach a valid target prefix; manual recovery required')
  const up = spawnSync(BIN.docker, ['compose', '-p', project, '--env-file', env, '-f', compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', timeout, ...document.recovery_target.services], { stdio: 'inherit', env: {} })
  assert(up.status === 0, 'forward recovery runtime failed; manual recovery required')
  cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/livez`])
  cleanExec(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/readyz`])
  const release = jsonCommand(BIN.curl, ['--fail', '--silent', '--show-error', '--max-time', '15', `${productionBase}/releasez`])
  const identity = release.data?.release ?? release.release
  assert(identity?.release_id === recovery.releaseId && identity?.release_git_sha === recovery.gitSha && identity?.manifest_sha256 === recovery.manifestSha256 && identity?.image_set_digest === recovery.imageSetDigest, 'recovery runtime release identity mismatch; manual recovery required')
  const recoveryStarted = JSON.parse(readRegular(statePath).toString('utf8'))
  writeAtomic(statePath, transitionJournal(recoveryStarted, 'recovery_verified', privatePem, publicPem), true)
  process.stdout.write('preidentity forward recovery verified\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`preidentity recovery rejected: ${error.message}\n`); process.exitCode = 1 }
}
