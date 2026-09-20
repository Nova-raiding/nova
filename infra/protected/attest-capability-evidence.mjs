#!/usr/bin/env node
// Install as a root-owned, digest-pinned executable outside the repository.
// Only the protected host process may read the organisation signing key.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORMS = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']
const CAPABILITIES = ['authorize', 'refresh', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload']
const OPERATIONS = ['refresh_credential', 'sync_products', 'create_product', 'update_product', 'query_write', 'upload_media', 'revoke']
const CAPABILITY_OPERATION = { authorize: 'exchange_code', refresh: 'refresh_credential', read: 'sync_products', full_sync: 'sync_products', incremental_sync: 'sync_products', create: 'create_product', update: 'update_product', query_status: 'query_write', revoke: 'revoke', media_upload: 'upload_media' }
const REF = /^artifact:\/\/production\/([A-Za-z0-9._-]+)#([a-f0-9]{64})$/u
const HEX = /^[a-f0-9]{64}$/u
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const SAFE_KEYS = new Set(['platform','operation','workspaceId','accountId','method','origin','status','observedAt','providerRequestId','errorCode','errorMessage','retryable','transport'])
const TOP_KEYS = new Set(['schema_version','release_id','platform','workspace_id','account_id','exchanges'])
const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

/**
 * The read transport each platform family is dispatched with, as a policy the
 * protected verifier holds itself.
 *
 * The decision belongs to exactly one runtime point:
 * `HttpPlatformConnector.syncProducts` reads
 * `RequestSigner.signedParametersCarryCredential` off the signer the production
 * configuration produced, and carries the body when that declaration is true.
 * The router-gateway signers (jd, taobao/tmall, pinduoduo) fold the access
 * token, app key and signature into one parameter set, so a bodyless method
 * would put that set in the request URL; the bearer signers (xiaohongshu,
 * douyin) keep the token in the `authorization` header, so their parameter set
 * is empty, nothing reaches the URL, and they keep the GET their platform was
 * already called with.
 *
 * This file deliberately does not import that code. It is the verifier of the
 * evidence that attests the connector, it is installed outside the repository
 * as a digest-pinned root-owned executable, and a verifier that certifies
 * whatever the code under attestation currently says cannot refuse it. So the
 * family policy is declared here and pinned to the implementation from the
 * repository side: `tests/platform-read-transport-agreement.test.ts` dispatches
 * a real read through the shipped signers for all six platforms and fails if the
 * method it observes stops matching this table — which is what makes a silent
 * divergence between the two impossible rather than unlikely.
 *
 * The tolerated body-carrying POST on a bearer read is deliberate: the bearer's
 * credential is not in the parameter set either way, so refusing that shape would
 * reject evidence without removing any exposure.
 */
export const PLATFORM_READ_METHODS = Object.freeze({
  jd: Object.freeze(['POST']),
  taobao: Object.freeze(['POST']),
  tmall: Object.freeze(['POST']),
  pinduoduo: Object.freeze(['POST']),
  xiaohongshu: Object.freeze(['GET', 'POST']),
  douyin: Object.freeze(['GET', 'POST']),
})

/** Whether `method` is a shape the shipped connector may dispatch for a read on
 * `platform`. Unknown platforms fail closed on the strict reading, because the
 * six-platform matrix is asserted before any transcript is read. */
export function readMethodAllowed(platform, method) {
  return (PLATFORM_READ_METHODS[platform] ?? ['POST']).includes(method)
}

export const PLATFORM_TRANSCRIPT_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60_000
export const PLATFORM_TRANSCRIPT_FUTURE_SKEW_MS = 5 * 60_000

function assert(condition, message) { if (!condition) throw new Error(message) }
function readRegular(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    assert(st.isFile() && st.size > 0 && st.size <= maxBytes, 'unsafe input file')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function transcript(entry, releaseId, root, generatedAt) {
  const match = REF.exec(entry.exchange_transcript_ref || '')
  assert(match, 'missing content-addressed provider transcript')
  const path = resolve(root, match[1])
  assert(dirname(path) === root, 'transcript escapes artifact root')
  const bytes = readRegular(path, 1024 * 1024)
  assert(createHash('sha256').update(bytes).digest('hex') === match[2], 'provider transcript hash mismatch')
  const value = JSON.parse(bytes.toString('utf8'))
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid provider transcript')
  assert(Object.keys(value).every(key => TOP_KEYS.has(key)), 'provider transcript contains disallowed fields')
  assert(value.schema_version === 'provider-exchanges/1' && value.release_id === releaseId && value.platform === entry.platform, 'provider transcript release mismatch')
  assert(value.workspace_id === entry.tenant_context.workspace_id && value.account_id === entry.tenant_context.account_id, 'provider transcript tenant mismatch')
  assert(Array.isArray(value.exchanges), 'provider transcript exchanges missing')
  const successes = new Set()
  const failures = []
  let previousObservedAt = Number.NEGATIVE_INFINITY
  for (const item of value.exchanges) {
    assert(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).every(key => SAFE_KEYS.has(key)), 'invalid provider exchange fields')
    assert(item.platform === entry.platform && item.workspaceId === entry.tenant_context.workspace_id && (item.accountId === undefined || item.accountId === entry.tenant_context.account_id), 'provider exchange tenant mismatch')
    assert(item.transport === 'fetch' && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599, 'invalid provider exchange status')
    // The read transport follows the platform's signer family — see
    // `PLATFORM_READ_METHODS` above for the table, why the decision belongs to
    // the connector rather than to this verifier, and how the two are pinned
    // together. A router gateway's read that a transcript records as a GET is
    // describing the request that published the signed set in the URL, and is
    // refused; the bearer platforms' reads are dispatched as GET and demanding a
    // body here rejected the only truthful transcript those two platforms can
    // produce. Every other exchange is signed and must carry its parameter set in
    // a body.
    const dispatchedRead = item.operation === 'sync_products'
    assert(dispatchedRead ? readMethodAllowed(item.platform, item.method) : item.method === 'POST', 'provider exchange method mismatch')
    const origin = new URL(item.origin)
    assert(origin.protocol === 'https:' && origin.origin === item.origin && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'provider exchange origin invalid')
    const observedAt = typeof item.observedAt === 'string' && STRICT_UTC_INSTANT.test(item.observedAt) ? Date.parse(item.observedAt) : Number.NaN
    assert(Number.isFinite(observedAt), 'provider exchange timestamp invalid')
    assert(observedAt >= previousObservedAt, 'provider exchange timestamps must be monotonic')
    assert(observedAt <= generatedAt, 'provider exchange timestamp is after candidate generation')
    assert(generatedAt - observedAt <= PLATFORM_TRANSCRIPT_CANDIDATE_MAX_AGE_MS, 'provider exchange timestamp is outside candidate generation window')
    previousObservedAt = observedAt
    if (item.status >= 200 && item.status < 300) successes.add(item.operation)
    else failures.push(item)
  }
  for (const operation of OPERATIONS) assert(successes.has(operation), `provider transcript missing ${operation} response`)
  return failures
}

export function validateCandidate(value, binding, root, now = new Date()) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'candidate must be JSON object')
  assert(value.schema_version === '1' && value.release_id === binding.releaseId && ['preproduction','production'].includes(value.environment) && value.simulated !== true, 'candidate release/environment mismatch')
  const generatedAt = typeof value.generated_at === 'string' && STRICT_UTC_INSTANT.test(value.generated_at) ? Date.parse(value.generated_at) : Number.NaN
  assert(Number.isFinite(generatedAt), 'candidate timestamp invalid')
  assert(generatedAt <= now.getTime() + PLATFORM_TRANSCRIPT_FUTURE_SKEW_MS, 'candidate timestamp is too far in the future')
  assert(now.getTime() - generatedAt <= PLATFORM_TRANSCRIPT_CANDIDATE_MAX_AGE_MS, 'candidate timestamp is outside the signing window')
  assert(!('signature_base64' in value) && !('key_id' in value) && !('deployment_nonce' in value), 'candidate already contains signer fields')
  function noSecrets(node) {
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      assert(!/secret|token|password|access[_-]?key|private[_-]?key/iu.test(key), 'candidate contains secret-like field')
      noSecrets(child)
    }
  }
  noSecrets(value)
  assert(Array.isArray(value.platforms) && value.platforms.length === PLATFORMS.length, 'six platform candidates required')
  const seen = new Set()
  for (const entry of value.platforms) {
    assert(entry && PLATFORMS.includes(entry.platform) && !seen.has(entry.platform), 'invalid or duplicate platform')
    seen.add(entry.platform)
    assert(entry.tenant_context && entry.tenant_context.workspace_id && entry.tenant_context.account_id && entry.application_id && entry.test_store_id, 'platform scope incomplete')
    const failures = transcript(entry, binding.releaseId, root, generatedAt)
    assert(entry.capabilities && Object.keys(entry.capabilities).length === CAPABILITIES.length, 'capability matrix incomplete')
    for (const name of CAPABILITIES) {
      const capability = entry.capabilities[name]
      assert(capability && capability.state === 'production_canary' && capability.evidence_ref && capability.verified_by && capability.verified_at && capability.api_version && capability.scope, `${name} production evidence incomplete`)
      assert(capability.protocol?.name && capability.protocol?.version, `${name} protocol evidence missing`)
      const error = capability.error_evidence
      assert(error && error.request_id && error.code && error.message && error.observed_at && typeof error.retryable === 'boolean', `${name} negative-path evidence missing`)
      assert(failures.some(item => item.operation === CAPABILITY_OPERATION[name] && item.providerRequestId === error.request_id && item.errorCode === error.code && item.errorMessage === error.message && item.observedAt === error.observed_at && item.retryable === error.retryable), `${name} negative-path evidence has no matching provider failure`)
    }
  }
  return value
}

export function signCandidate(value, binding, root, privatePem, publicPem) {
  validateCandidate(value, binding, root)
  const privateKey = createPrivateKey(privatePem)
  const publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519', 'trust keys must be Ed25519')
  assert(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'protected private key does not match trust anchor')
  const signed = { ...value, environment: 'production', simulated: false, release_id: binding.releaseId, image_set_digest: binding.imageSetDigest, manifest_sha256: binding.manifestSha256, release_git_sha: binding.releaseGitSha, deployment_nonce: binding.deploymentNonce, key_id: binding.keyId }
  const payload = Buffer.from(canonical(signed))
  signed.signature_base64 = sign(null, payload, privateKey).toString('base64')
  assert(verify(null, payload, publicKey, Buffer.from(signed.signature_base64, 'base64')), 'self-verification failed')
  return signed
}

function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
function main(args) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'protected attester must run as root')
  assert(args[0] === 'attest', 'attest subcommand required')
  const input = option(args,'--input'), output = option(args,'--output')
  const binding = { releaseId: option(args,'--release-id'), imageSetDigest: option(args,'--image-set-digest'), manifestSha256: option(args,'--manifest-sha256'), releaseGitSha: option(args,'--release-git-sha'), deploymentNonce: option(args,'--deployment-nonce') }
  assert(input && output && /^[A-Za-z0-9._:-]{1,128}$/u.test(binding.releaseId) && /^sha256:[a-f0-9]{64}$/u.test(binding.imageSetDigest) && HEX.test(binding.manifestSha256) && GIT.test(binding.releaseGitSha) && NONCE.test(binding.deploymentNonce), 'release binding is invalid')
  const root = realpathSync(dirname(output))
  assert(root === resolve(dirname(output)) && !lstatSync(root).isSymbolicLink(), 'artifact root must be canonical')
  assert((statSync(root).mode & 0o022) === 0, 'artifact root must not be group/other writable')
  assert(resolve(input) !== resolve(output), 'input and output must differ')
  const trust = '/run/release-security/evidence-trust'
  const privatePath = '/var/lib/merchant-release-security/production-capability-private.pem'
  const privateStat = lstatSync(privatePath)
  assert(privateStat.isFile() && privateStat.uid === 0 && (privateStat.mode & 0o777) === 0o600, 'protected private key must be root-owned 0600')
  const keyId = readRegular(join(trust,'production-evidence-key-id'), 128).toString('utf8').trim()
  assert(/^[A-Za-z0-9._:-]{1,128}$/u.test(keyId), 'trusted key ID invalid')
  binding.keyId = keyId
  const candidate = JSON.parse(readRegular(input, 1024 * 1024).toString('utf8'))
  const signed = signCandidate(candidate, binding, root, readRegular(privatePath, 8192), readRegular(join(trust,'production-evidence-public.pem'), 8192))
  const bytes = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`)
  const temp = `${output}.${process.pid}.tmp`
  const old = process.umask(0o077)
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, output) // atomic exclusive create; never replace existing signed evidence
  } finally { try { unlinkSync(temp) } catch {} process.umask(old) }
  process.stdout.write('protected capability attestation written\n')
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`attestation rejected: ${error.message}\n`); process.exitCode = 1 }
}
