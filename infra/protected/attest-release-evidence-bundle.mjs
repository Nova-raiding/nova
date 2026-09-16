#!/usr/bin/env node
// Install as a root-owned, digest-pinned executable outside the repository.
// The application and deployment runner must never receive this signer's key.
import { constants, closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash as hash, createPrivateKey as privateKey, createPublicKey as publicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVIDENCE_KINDS = ['capability','capacity','modelRelay','payment','restore','objectStorage','codexAppHost','canonicalCutover']
const HEX = /^[a-f0-9]{64}$/u, IMAGE = /^sha256:[a-f0-9]{64}$/u, GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const MAX_AGE_MS = 24 * 60 * 60_000
function assert(value, message) { if (!value) throw new Error(message) }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; return JSON.stringify(value) }
function readRegular(path, max = 4 * 1024 * 1024) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const st = fstatSync(fd); assert(st.isFile() && st.size > 0 && st.size <= max, 'unsafe evidence file'); return readFileSync(fd) } finally { closeSync(fd) } }
function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
function artifact(path, root, kind, releaseId, now) {
  assert(path, `${kind} evidence path is required`)
  const absolute = resolve(path), real = realpathSync(absolute), rootReal = realpathSync(root)
  assert(!lstatSync(absolute).isSymbolicLink() && real.startsWith(`${rootReal}${sep}`), `${kind} evidence escapes artifact root or is a symlink`)
  const name = relative(rootReal, real)
  assert(name && !name.split(sep).some(part => !part || part === '.' || part === '..'), `${kind} evidence path is invalid`)
  const bytes = readRegular(real), document = JSON.parse(bytes.toString('utf8'))
  assert((document.release_id ?? document.releaseId) === releaseId, `${kind} evidence release mismatch`)
  const timestamp = document.attested_at ?? document.generated_at ?? document.generatedAt ?? document.ended_at
  const instant = typeof timestamp === 'string' && UTC.test(timestamp) ? Date.parse(timestamp) : Number.NaN
  assert(Number.isFinite(instant) && instant <= now + 300_000 && now - instant <= MAX_AGE_MS, `${kind} evidence is stale or has an invalid timestamp`)
  return { kind, ref: `artifact://production/${name.split(sep).join('/')}#${hash('sha256').update(bytes).digest('hex')}` }
}

export function createBundle(paths, binding, root, privatePem, publicPem, now = new Date()) {
  const generatedAt = now.toISOString(), artifacts = EVIDENCE_KINDS.map(kind => artifact(paths[kind], root, kind, binding.releaseId, now.getTime()))
  assert(new Set(artifacts.map(item => item.ref)).size === EVIDENCE_KINDS.length, 'duplicate evidence references are forbidden')
  const key = privateKey(privatePem), pub = publicKey(publicPem)
  assert(key.asymmetricKeyType === 'ed25519' && pub.asymmetricKeyType === 'ed25519', 'trust keys must be Ed25519')
  assert(publicKey(key).export({type:'spki',format:'der'}).equals(pub.export({type:'spki',format:'der'})), 'protected private key does not match trust anchor')
  const bundle = { schema_version: 'release-evidence-bundle/1', release_id: binding.releaseId, image_set_digest: binding.imageSetDigest, manifest_sha256: binding.manifestSha256, release_git_sha: binding.releaseGitSha, deployment_nonce: binding.deploymentNonce, key_id: binding.keyId, generated_at: generatedAt, expires_at: new Date(now.getTime() + MAX_AGE_MS).toISOString(), artifacts }
  const payload = Buffer.from(canonical(bundle)); bundle.signature_base64 = signBytes(null, payload, key).toString('base64')
  assert(verifyBytes(null, payload, pub, Buffer.from(bundle.signature_base64, 'base64')), 'self-verification failed')
  return bundle
}

function main(args) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'protected attester must run as root')
  assert(args[0] === 'attest', 'attest subcommand required')
  const output = option(args,'--output'), root = output && realpathSync(dirname(output))
  const binding = { releaseId: option(args,'--release-id'), imageSetDigest: option(args,'--image-set-digest'), manifestSha256: option(args,'--manifest-sha256'), releaseGitSha: option(args,'--release-git-sha'), deploymentNonce: option(args,'--deployment-nonce') }
  assert(output && root === resolve(dirname(output)) && !lstatSync(root).isSymbolicLink() && (statSync(root).mode & 0o022) === 0, 'output artifact root must be canonical and protected')
  assert(/^[A-Za-z0-9._:-]{1,128}$/u.test(binding.releaseId ?? '') && IMAGE.test(binding.imageSetDigest ?? '') && HEX.test(binding.manifestSha256 ?? '') && GIT.test(binding.releaseGitSha ?? '') && NONCE.test(binding.deploymentNonce ?? ''), 'release binding is invalid')
  const trust = '/run/release-security/evidence-trust', privatePath = '/var/lib/merchant-release-security/production-evidence-bundle-private.pem'
  const privateStat = lstatSync(privatePath); assert(privateStat.isFile() && !privateStat.isSymbolicLink() && privateStat.uid === 0 && (privateStat.mode & 0o777) === 0o600, 'protected private key must be root-owned 0600')
  binding.keyId = readRegular(resolve(trust,'production-evidence-key-id'), 128).toString('utf8').trim()
  const paths = Object.fromEntries(EVIDENCE_KINDS.map(kind => [kind, option(args, `--${kind.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-evidence`)]))
  const bundle = createBundle(paths, binding, root, readRegular(privatePath,8192), readRegular(resolve(trust,'production-evidence-public.pem'),8192))
  const temp = `${output}.${process.pid}.tmp`, old = process.umask(0o077)
  try { writeFileSync(temp, `${JSON.stringify(bundle,null,2)}\n`, {flag:'wx',mode:0o600}); linkSync(temp, output) } finally { try { unlinkSync(temp) } catch {} process.umask(old) }
  process.stdout.write('protected release evidence bundle attestation written\n')
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) { try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`bundle attestation rejected: ${error.message}\n`); process.exitCode = 1 } }
