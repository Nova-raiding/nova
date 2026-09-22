#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'

function fail(message) { throw new Error(message) }
function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) fail(`${name} is required`)
  return process.argv[index + 1]
}
function regular(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
}
function immutable(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u.test(value)) fail(`${label} must be an immutable repository@sha256 reference`)
  return value.slice(value.lastIndexOf('@') + 1)
}
function atomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

const metadataPath = resolve(argument('--release-images'))
const identityPath = resolve(argument('--candidate-identity'))
const output = resolve(argument('--output'))
const migrationRef = argument('--migration-image-ref')
const clamavRef = argument('--clamav-image-ref')
regular(metadataPath, 'release image metadata')
regular(identityPath, 'candidate identity')
if (existsSync(output)) fail('output directory must not already exist')

const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
const identity = Object.fromEntries(readFileSync(identityPath, 'utf8').trim().split('\n').map(line => {
  const split = line.indexOf('=')
  return split > 0 ? [line.slice(0, split), line.slice(split + 1)] : fail('candidate identity is malformed')
}))
if (metadata.schema_version !== 1) fail('unsupported release image metadata schema')
if (metadata.release_id !== identity.release_id || metadata.release_git_sha !== identity.git_sha || metadata.source_sha256 !== identity.source_sha256) {
  fail('six-image metadata does not match the staged candidate identity')
}

const owned = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
if (Object.keys(metadata.image_digests ?? {}).sort().join('\n') !== [...owned].sort().join('\n')) fail('six-image digest set is incomplete or contains unknown artifacts')
if (Object.keys(metadata.image_references ?? {}).sort().join('\n') !== [...owned].sort().join('\n')) fail('six-image reference set is incomplete or contains unknown artifacts')
for (const artifact of owned) {
  const digest = immutable(metadata.image_references[artifact], `${artifact} reference`)
  if (digest !== metadata.image_digests[artifact]) fail(`${artifact} reference and digest disagree`)
}
const migrationDigest = immutable(migrationRef, 'migration image reference')
if (!/(?:^|\/)postgres:17-alpine@sha256:[0-9a-f]{64}$/u.test(migrationRef)) fail('migration image must be the reviewed PostgreSQL 17 alpine image')
const clamavDigest = immutable(clamavRef, 'ClamAV image reference')

const digests = { ...metadata.image_digests, 'postgres-migration': migrationDigest, clamav: clamavDigest }
const references = { ...metadata.image_references, 'postgres-migration': migrationRef, clamav: clamavRef }
const envNames = {
  'postgres-migration': 'MIGRATION_IMAGE_REF',
  'merchant-api': 'API_IMAGE_REF',
  'merchant-worker': 'WORKER_IMAGE_REF',
  'merchant-ui': 'UI_IMAGE_REF',
  'merchant-ops-ui': 'OPS_UI_IMAGE_REF',
  'payment-gateway': 'PAYMENT_GATEWAY_IMAGE_REF',
  'pilot-gateway': 'PILOT_GATEWAY_IMAGE_REF',
  clamav: 'CLAMAV_IMAGE_REF',
}
mkdirSync(output, { mode: 0o700 })
atomic(join(output, 'image-digests.json'), `${JSON.stringify(digests, null, 2)}\n`)
atomic(join(output, 'image-refs.env'), `${Object.entries(envNames).map(([artifact, name]) => `${name}=${references[artifact]}`).join('\n')}\n`)
atomic(join(output, 'eight-image-set.json'), `${JSON.stringify({
  schema_version: 1,
  release_id: metadata.release_id,
  release_git_sha: metadata.release_git_sha,
  source_sha256: metadata.source_sha256,
  image_digests: digests,
  image_references: references,
}, null, 2)}\n`)
console.log(`prepared immutable eight-image set for ${metadata.release_id}: ${output}`)
