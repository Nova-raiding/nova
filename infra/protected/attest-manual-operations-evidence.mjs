#!/usr/bin/env node
// Install as a digest-pinned, root-owned control outside the repository.
// The private key stays in the protected host trust boundary.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { constants, closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX = /^[a-f0-9]{64}$/u
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const REQUIRED_CHECKS = ['tenant_scope', 'manual_report', 'merchant_visibility']
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
function readRegular(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const st = fstatSync(fd); assert(st.isFile() && st.size > 0 && st.size <= maxBytes, 'unsafe input file'); return readFileSync(fd) } finally { closeSync(fd) }
}
function instant(value) { return typeof value === 'string' && UTC.test(value) ? Date.parse(value) : Number.NaN }

export function validateManualCandidate(value, binding, now = new Date()) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'manual candidate must be a JSON object')
  assert(!['signature_base64', 'key_id', 'image_set_digest', 'manifest_sha256', 'release_git_sha', 'deployment_nonce'].some(key => key in value), 'candidate already contains signer fields')
  assert(value.schema_version === 'manual-operations-evidence/1' && value.release_id === binding.releaseId, 'candidate release or schema mismatch')
  assert(value.environment === 'production' && value.workflow === 'public_import_manual_publish' && value.official_api_receipt === false && value.simulated === false && value.tenant_isolation_verified === true, 'candidate manual workflow boundary mismatch')
  assert(typeof value.workspace_id === 'string' && value.workspace_id.trim() && typeof value.isolation_probe_workspace_id === 'string' && value.isolation_probe_workspace_id.trim() && value.workspace_id !== value.isolation_probe_workspace_id, 'candidate tenant scope incomplete')
  assert(typeof value.manual_publish_report_id === 'string' && value.manual_publish_report_id.trim() && typeof value.verified_by === 'string' && value.verified_by.trim(), 'candidate report or verifier missing')
  const generated = instant(value.generated_at), expires = instant(value.expires_at)
  assert(Number.isFinite(generated) && generated <= now.getTime() + 300_000 && now.getTime() - generated <= 86_400_000, 'candidate generated_at is invalid or stale')
  assert(Number.isFinite(expires) && expires > now.getTime() && expires > generated && expires <= generated + 86_400_000, 'candidate expires_at is invalid')
  assert(Array.isArray(value.checks) && value.checks.length === REQUIRED_CHECKS.length, 'candidate requires exactly three workflow checks')
  const names = new Set()
  for (const check of value.checks) {
    assert(check && typeof check === 'object' && !Array.isArray(check) && Object.keys(check).every(key => ['name', 'status', 'observation'].includes(key)), 'candidate contains invalid workflow check fields')
    assert(check.status === 'pass' && typeof check.name === 'string' && typeof check.observation === 'string', 'candidate workflow check is incomplete')
    names.add(check.name)
  }
  assert(names.size === REQUIRED_CHECKS.length && REQUIRED_CHECKS.every(name => names.has(name)), 'candidate workflow checks are incomplete')
  assert(value.checks.find(check => check.name === 'tenant_scope')?.observation === 'foreign_workspace_rejected', 'tenant isolation observation mismatch')
  assert(value.checks.find(check => check.name === 'manual_report')?.observation === 'human_evidence_boundary_preserved', 'manual report observation mismatch')
  assert(value.checks.find(check => check.name === 'merchant_visibility')?.observation === 'expected_report_visible', 'merchant visibility observation mismatch')
  const allowed = new Set(['schema_version', 'release_id', 'environment', 'workflow', 'workspace_id', 'isolation_probe_workspace_id', 'manual_publish_report_id', 'official_api_receipt', 'tenant_isolation_verified', 'simulated', 'generated_at', 'expires_at', 'verified_by', 'checks'])
  assert(Object.keys(value).every(key => allowed.has(key)), 'candidate contains unknown fields')
  return value
}

export function signManualCandidate(value, binding, privatePem, publicPem, now = new Date()) {
  validateManualCandidate(value, binding, now)
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  assert(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519', 'trust keys must be Ed25519')
  assert(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'protected private key does not match trust anchor')
  const signed = { ...value, image_set_digest: binding.imageSetDigest, manifest_sha256: binding.manifestSha256, release_git_sha: binding.releaseGitSha, deployment_nonce: binding.deploymentNonce, key_id: binding.keyId }
  const payload = Buffer.from(canonical(signed))
  signed.signature_base64 = sign(null, payload, privateKey).toString('base64')
  assert(verify(null, payload, publicKey, Buffer.from(signed.signature_base64, 'base64')), 'self-verification failed')
  return signed
}

function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
function main(args) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'protected attester must run as root')
  assert(args[0] === 'attest', 'attest subcommand required')
  const input = option(args, '--input'), output = option(args, '--output')
  const binding = { releaseId: option(args, '--release-id'), imageSetDigest: option(args, '--image-set-digest'), manifestSha256: option(args, '--manifest-sha256'), releaseGitSha: option(args, '--release-git-sha'), deploymentNonce: option(args, '--deployment-nonce') }
  assert(input && output && /^[A-Za-z0-9._:-]{1,128}$/u.test(binding.releaseId ?? '') && /^sha256:[a-f0-9]{64}$/u.test(binding.imageSetDigest ?? '') && HEX.test(binding.manifestSha256 ?? '') && GIT.test(binding.releaseGitSha ?? '') && NONCE.test(binding.deploymentNonce ?? ''), 'release binding is invalid')
  const root = realpathSync(dirname(output))
  assert(root === resolve(dirname(output)) && !lstatSync(root).isSymbolicLink() && (statSync(root).mode & 0o022) === 0, 'output artifact root must be canonical and protected')
  assert(resolve(input) !== resolve(output), 'input and output must differ')
  const trust = '/run/release-security/evidence-trust'
  const privatePath = '/var/lib/merchant-release-security/production-capability-private.pem'
  const privateStat = lstatSync(privatePath)
  assert(privateStat.isFile() && !privateStat.isSymbolicLink() && privateStat.uid === 0 && (privateStat.mode & 0o777) === 0o600, 'protected private key must be root-owned 0600')
  binding.keyId = readRegular(resolve(trust, 'production-evidence-key-id'), 128).toString('utf8').trim()
  assert(/^[A-Za-z0-9._:-]{1,128}$/u.test(binding.keyId), 'trusted key ID invalid')
  const candidate = JSON.parse(readRegular(input, 1024 * 1024).toString('utf8'))
  const signed = signManualCandidate(candidate, binding, readRegular(privatePath, 8192), readRegular(resolve(trust, 'production-evidence-public.pem'), 8192))
  const temp = `${output}.${process.pid}.tmp`, old = process.umask(0o077)
  try { writeFileSync(temp, `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); linkSync(temp, output) }
  finally { try { unlinkSync(temp) } catch {} process.umask(old) }
  process.stdout.write('protected manual operations attestation written\n')
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`manual attestation rejected: ${error.message}\n`); process.exitCode = 1 }
}
