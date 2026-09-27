#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Protected ordinary-release producer. The companion snapshot module is an
// independently pinned installed library; its review-only CLI is never run.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const TRUST = '/run/release-security/evidence-trust'
const OUTPUT_ROOT = '/var/lib/merchant-release-security/canonical-safe-state'
const INSTALLED = '/usr/local/libexec/merchant/attest-canonical-safe-state'
const LIBRARY = '/usr/local/libexec/merchant/canonical-safe-state-snapshot.mjs'
const PSQL = '/usr/pgsql-16/bin/psql'
const PRIVATE = '/var/lib/merchant-release-security/canonical-safe-state-private.pem'
const HEX = /^[a-f0-9]{64}$/u
const sha256 = value => createHash('sha256').update(value).digest('hex')
const assert = (value, message) => { if (!value) throw new Error(message) }
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)

function protectedPath(path, kind) {
  assert(path === resolve(path) && realpathSync(path) === path, 'protected path must be canonical and absolute')
  const { root } = parse(path); let current = root
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    assert(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'untrusted protected path component')
  }
  const stat = lstatSync(path)
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), 'protected path has wrong type')
  return stat
}
function readProtected(path, limit, mode) {
  protectedPath(path, 'file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    assert(stat.uid === 0 && (stat.mode & 0o022) === 0 && stat.size > 0 && stat.size <= limit, 'protected file owner, mode or size invalid')
    if (mode !== undefined) assert((stat.mode & 0o777) === mode, 'protected file mode invalid')
    const bytes = readFileSync(fd)
    assert(bytes.length === stat.size, 'protected file changed while reading')
    return bytes
  } finally { closeSync(fd) }
}
function readDigest(name) {
  const value = readProtected(join(TRUST, name), 128).toString('utf8').trim()
  assert(HEX.test(value), 'protected digest invalid')
  return value
}
function exactObject(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} fields invalid`)
}

export function validateSourcePolicy(bytes, collectorDigest, endpointDigest) {
  const value = JSON.parse(bytes.toString('utf8'))
  exactObject(value, ['schema_version', 'collector_sha256', 'database_identity'], 'source policy')
  exactObject(value.database_identity, ['system_identifier_sha256', 'database_oid', 'database_name_sha256', 'endpoint_sha256'], 'source database identity')
  assert(value.schema_version === 'canonical-safe-state-source-policy/1' && value.collector_sha256 === collectorDigest, 'source policy collector mismatch')
  for (const field of ['system_identifier_sha256', 'database_name_sha256', 'endpoint_sha256']) assert(HEX.test(value.database_identity[field]), `source policy ${field} invalid`)
  assert(Number.isSafeInteger(value.database_identity.database_oid) && value.database_identity.database_oid > 0, 'source policy database OID invalid')
  assert(value.database_identity.endpoint_sha256 === endpointDigest, 'protected database endpoint differs from reviewed policy')
  return { ...value, source_policy_sha256: sha256(bytes) }
}

export function endpointDigest(serviceBytes, serviceName) {
  assert(Buffer.isBuffer(serviceBytes) && serviceBytes.length > 0, 'protected service bytes required')
  assert(/^[A-Za-z0-9._-]{1,64}$/u.test(serviceName), 'protected service name invalid')
  return sha256(Buffer.concat([Buffer.from('canonical-safe-state-endpoint/1\0'), serviceBytes, Buffer.from('\0' + serviceName)]))
}

export function candidateBinding(environment) {
  const releaseId = environment.RELEASE_ID
  const git = environment.CANONICAL_EXPECTED_RELEASE_GIT_SHA
  const candidate = environment.CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256
  const manifest = environment.CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256
  const images = environment.CANONICAL_EXPECTED_IMAGE_SET_DIGEST
  const nonce = environment.DEPLOYMENT_NONCE
  assert(typeof releaseId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(releaseId), 'candidate release ID invalid')
  assert(typeof git === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(git), 'candidate Git SHA invalid')
  assert(HEX.test(candidate ?? '') && HEX.test(manifest ?? ''), 'candidate manifest digest invalid')
  assert(/^sha256:[a-f0-9]{64}$/u.test(images ?? ''), 'candidate image set digest invalid')
  assert(typeof nonce === 'string' && /^[A-Za-z0-9_-]{22,128}$/u.test(nonce), 'deployment nonce invalid')
  return {
    release_id: releaseId, release_git_sha: git, candidate_manifest_sha256: candidate,
    release_manifest_sha256: manifest, image_set_digest: images, deployment_nonce_sha256: sha256(nonce),
  }
}

export function buildCanonicalSafeStateEvidence({ snapshot, summary, binding, policy, collectorDigest, privatePem, publicPem, keyId, now = new Date() }) {
  assert(snapshot && summary && binding && policy && HEX.test(collectorDigest), 'verified collection inputs required')
  assert(Array.isArray(snapshot.workspaces) && summary.workspace_count === snapshot.workspaces.length && summary.workspace_count > 0, 'workspace coverage invalid')
  assert(summary.blockers?.length === 0 && summary.mode_counts?.legacy_shadow === summary.workspace_count
    && summary.mode_counts?.dual_verify === 0 && summary.mode_counts?.canonical_read === 0, 'one or more workspaces are not in legacy_shadow')
  assert(HEX.test(summary.workspace_id_set_sha256 ?? '') && HEX.test(policy.source_policy_sha256 ?? ''), 'source observation digest invalid')
  const identity = policy.database_identity
  assert(summary.system_identifier_sha256 === identity.system_identifier_sha256
    && summary.database_name_sha256 === identity.database_name_sha256
    && Number(summary.database_oid) === identity.database_oid, 'live database identity differs from reviewed policy')
  assert(typeof keyId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(keyId), 'protected signing key ID invalid')
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'protected signing keypair mismatch')
  const observed = Date.parse(summary.observed_at), generated = now.getTime()
  assert(Number.isFinite(observed) && Number.isFinite(generated) && generated >= observed && generated - observed <= 300_000, 'snapshot chronology invalid')
  const document = {
    schema_version: 'canonical-safe-state-attestation/1', evidence_purpose: 'ordinary_release_safe_state',
    environment: 'production', source: 'production_database', simulated: false,
    ...binding,
    source_policy_sha256: policy.source_policy_sha256, collector_sha256: collectorDigest,
    database_identity: identity, database_identity_sha256: sha256(canonical(identity)),
    observed_at: summary.observed_at, generated_at: now.toISOString(), expires_at: new Date(generated + 3_600_000).toISOString(),
    read_only_transaction: true, transaction_isolation: 'repeatable read', all_workspaces_included: true,
    cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false,
    workspace_count: summary.workspace_count, workspace_id_set_sha256: summary.workspace_id_set_sha256,
    mode_counts: summary.mode_counts, key_id: keyId,
  }
  document.signature_base64 = sign(null, Buffer.from(canonical(document)), privateKey).toString('base64')
  assert(verify(null, Buffer.from(canonical(document)), publicKey, Buffer.from(document.signature_base64, 'base64')), 'source signature self-check failed')
  return document
}

function parseOutput(args) {
  assert(args.length === 2 && args[0] === '--output', 'exact --output path required')
  const path = args[1]
  assert(path === resolve(path) && dirname(path) === OUTPUT_ROOT && /^[A-Za-z0-9._-]{1,128}\.json$/u.test(basename(path)), 'output must be a direct protected JSON child')
  protectedPath(OUTPUT_ROOT, 'directory')
  try { lstatSync(path); throw new Error('output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  return path
}
function writeExclusive(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset); fsyncSync(fd) }
  finally { closeSync(fd) }
  const dir = openSync(OUTPUT_ROOT, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(dir) } finally { closeSync(dir) }
}

async function main(args) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'canonical source attester requires root')
  assert(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'protected Node environment required')
  assert(realpathSync(process.argv[1]) === INSTALLED, 'fixed installed attester required')
  for (const path of [INSTALLED, LIBRARY, PSQL, process.execPath]) protectedPath(path, 'file')
  const collectorDigest = readDigest('canonical-safe-state-collector-sha256')
  assert(sha256(readProtected(INSTALLED, 2 * 1024 * 1024)) === collectorDigest, 'installed collector digest mismatch')
  assert(sha256(readProtected(LIBRARY, 2 * 1024 * 1024)) === readDigest('canonical-safe-state-library-sha256'), 'installed snapshot library digest mismatch')
  const output = parseOutput(args)
  const servicePath = process.env.PGSERVICEFILE
  assert(typeof servicePath === 'string' && servicePath.startsWith('/'), 'protected libpq service file required')
  const serviceBytes = readProtected(servicePath, 65_536, 0o600)
  const serviceName = process.env.CANONICAL_SAFE_STATE_PGSERVICE
  const policyBytes = readProtected(join(TRUST, 'canonical-safe-state-source-policy.json'), 16_384)
  const policy = validateSourcePolicy(policyBytes, collectorDigest, endpointDigest(serviceBytes, serviceName))
  const binding = candidateBinding(process.env)
  const { CAPTURE_SQL, summarizeCanonicalSafeState } = await import(pathToFileURL(LIBRARY).href)
  const result = spawnSync(PSQL, [`service=${serviceName}`, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${CAPTURE_SQL}`,
    env: { PATH: '/usr/bin:/bin', PGSERVICEFILE: servicePath, LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000,
  })
  assert(!result.error && result.status === 0, 'read-only production snapshot refused')
  const rows = result.stdout.trim().split(/\n/u).filter(Boolean)
  assert(rows.length === 1, 'production snapshot must contain exactly one JSON row')
  const snapshot = JSON.parse(rows[0]), summary = summarizeCanonicalSafeState(snapshot)
  const privatePem = readProtected(PRIVATE, 8_192, 0o600)
  const publicPem = readProtected(join(TRUST, 'canonical-safe-state-public.pem'), 8_192)
  const keyId = readProtected(join(TRUST, 'canonical-safe-state-key-id'), 128).toString('utf8').trim()
  const document = buildCanonicalSafeStateEvidence({ snapshot, summary, binding, policy, collectorDigest, privatePem, publicPem, keyId })
  writeExclusive(output, Buffer.from(`${JSON.stringify(document, null, 2)}\n`))
  process.stdout.write(`canonical safe-state production evidence written: ${basename(output)}\n`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === INSTALLED) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`canonical safe-state attestation refused: ${error.message}\n`); process.exitCode = 1 })
}
