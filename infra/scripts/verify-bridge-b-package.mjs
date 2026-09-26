#!/usr/bin/env node
// Read-only bridge B handoff gate. It checks immutable build outputs and the
// code-only 242 rollback capsule; it neither creates evidence nor deploys.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const OLD_GIT_SHA = 'ec3d69e37809c0d622c8f38057a072245217004f'
const OWNED = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
const ALL = [...OWNED, 'postgres-migration', 'clamav']
const SHA = /^[0-9a-f]{64}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u
const ROOT = resolve(import.meta.dirname, '../..')

function fail(message) { throw new Error(message) }
function args() {
  const result = {}
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (!key?.startsWith('--') || !value || result[key]) fail(`invalid or duplicate argument: ${key}`)
    result[key] = value
  }
  const required = ['--candidate-identity', '--source-archive', '--release-images', '--eight-image-set', '--rendered-compose', '--rollback-plan', '--old-runtime-evidence', '--old-image-archive']
  for (const key of required) if (!result[key]) fail(`${key} is required`)
  if (Object.keys(result).length !== required.length) fail('unknown argument')
  return result
}
function file(value, label) {
  const path = resolve(value)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
  return path
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function fileHash(path) { return hash(readFileSync(path)) }
function json(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { fail(`${label} is not valid JSON`) }
}
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')) fail(`${label} key set is not exact`)
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function rubyDigest(compose, digests, mode) {
  return execFileSync('ruby', [resolve(ROOT, 'infra/scripts/validate-ecs-compose-release.rb'), compose, JSON.stringify(digests), mode], { encoding: 'utf8' }).trim()
}
function identity(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const entries = lines.map(line => {
    const separator = line.indexOf('=')
    if (separator < 1) fail('candidate identity is malformed')
    return [line.slice(0, separator), line.slice(separator + 1)]
  })
  const value = Object.fromEntries(entries)
  if (Object.keys(value).length !== entries.length) fail('candidate identity contains duplicate keys')
  return value
}
function same(actual, expected, label) { if (actual !== expected) fail(`${label} mismatch`) }

try {
  const input = args()
  const paths = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, file(value, key)]))
  const candidate = identity(paths['--candidate-identity'])
  same(candidate.schema_version, 'candidate-identity/2', 'cloud-only candidate identity schema')
  if (!/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(candidate.release_id ?? '')) fail('bridge release ID is invalid')
  if (!/^[0-9a-f]{40}$/u.test(candidate.git_sha ?? '') || candidate.git_sha === OLD_GIT_SHA) fail('bridge Git SHA must be a new full commit')
  for (const field of ['plugin_darwin_descriptor_sha256', 'plugin_darwin_test_sha256', 'plugin_win32_descriptor_sha256', 'plugin_win32_test_sha256']) {
    if (!DIGEST.test(candidate[field] ?? '')) fail(`cloud-only ${field} is missing or invalid`)
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(candidate.plugin_key_id ?? '')) fail('cloud-only plugin trust key ID is missing or invalid')
  same(candidate.source_sha256, `sha256:${fileHash(paths['--source-archive'])}`, 'candidate source digest')

  const images = json(paths['--release-images'], 'six-image metadata')
  const eight = json(paths['--eight-image-set'], 'eight-image set')
  const rollback = json(paths['--rollback-plan'], 'rollback capsule')
  const oldEvidence = json(paths['--old-runtime-evidence'], 'old runtime evidence')
  for (const record of [images, eight]) {
    same(record.schema_version, 1, 'image metadata schema')
    same(record.release_id, candidate.release_id, 'image release ID')
    same(record.release_git_sha, candidate.git_sha, 'image Git SHA')
    same(record.source_sha256, candidate.source_sha256, 'image source digest')
  }
  exactKeys(images.image_digests, OWNED, 'six-image digests')
  exactKeys(images.image_references, OWNED, 'six-image references')
  exactKeys(eight.image_digests, ALL, 'eight-image digests')
  exactKeys(eight.image_references, ALL, 'eight-image references')
  for (const artifact of ALL) {
    const digest = eight.image_digests[artifact]
    const reference = eight.image_references[artifact]
    if (!DIGEST.test(digest ?? '') || !REF.test(reference ?? '') || !reference.endsWith(`@${digest}`)) fail(`${artifact} digest/reference is not immutable and consistent`)
    if (OWNED.includes(artifact)) {
      same(images.image_digests[artifact], digest, `${artifact} six/eight digest`)
      same(images.image_references[artifact], reference, `${artifact} six/eight reference`)
    }
  }
  if (!/(?:^|\/)postgres:17-alpine@sha256:[0-9a-f]{64}$/u.test(eight.image_references['postgres-migration'])) fail('migration image must be pinned PostgreSQL 17 Alpine')

  // The Ruby release validator is authoritative for service/image binding.
  const imageSetDigest = rubyDigest(paths['--rendered-compose'], eight.image_digests, '--print-image-set-digest')
  const manifestSha = rubyDigest(paths['--rendered-compose'], eight.image_digests, '--print-manifest-sha256')
  execFileSync('ruby', [resolve(ROOT, 'infra/scripts/validate-ecs-compose-release.rb'), paths['--rendered-compose'], JSON.stringify(eight.image_digests)], {
    encoding: 'utf8', env: { ...process.env, RELEASE_ID: candidate.release_id, RELEASE_GIT_SHA: candidate.git_sha },
  })
  // Refuse a rendered bridge Compose whose runtime mode was omitted. The
  // exact service set must all carry the same explicit compatibility flag.
  const services = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
  const modeCheck = 'require "yaml"; d=YAML.safe_load(File.read(ARGV[0]), aliases: true); names=ARGV[1..]; abort "bridge schema mode missing" unless names.all? { |n| d.dig("services",n,"environment","BRIDGE_SCHEMA_COMPATIBILITY_MODE")=="prefix_242_or_244" }'
  execFileSync('ruby', ['-e', modeCheck, paths['--rendered-compose'], ...services], { encoding: 'utf8' })

  same(rollback.schema_version, '1', 'rollback schema')
  same(rollback.kind, 'ecs-unlabeled-id-recovery-capsule', 'rollback kind')
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(rollback.compose_project ?? '')) fail('rollback Compose project is invalid')
  same(rollback.current?.release_id, candidate.release_id, 'rollback current release')
  same(rollback.current?.git_sha, candidate.git_sha, 'rollback current Git SHA')
  same(rollback.current?.manifest_sha256, manifestSha, 'rollback current manifest')
  same(rollback.current?.image_set_digest, imageSetDigest, 'rollback current image set')
  same(rollback.target?.git_sha, OLD_GIT_SHA, 'rollback target old live Git SHA')
  same(JSON.stringify(rollback.target?.services), JSON.stringify(['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']), 'old seven-service target')
  same(oldEvidence.schema_version, 'ecs-bridge-old-runtime/1', 'old runtime evidence schema')
  same(oldEvidence.signed, false, 'old runtime evidence authority')
  same(oldEvidence.cutover_authorized, false, 'old runtime evidence cutover authority')
  same(oldEvidence.runtime?.source_git_sha, OLD_GIT_SHA, 'frozen old Git SHA')
  same(rollback.old_runtime?.evidence_sha256, fileHash(paths['--old-runtime-evidence']), 'old runtime evidence digest')
  const archiveHash = execFileSync('shasum', ['-a', '256', paths['--old-image-archive']], { encoding: 'utf8' }).trim().split(/\s+/u)[0]
  same(rollback.old_runtime?.archive_sha256, archiveHash, 'old image archive digest')
  same(oldEvidence.backup?.kind, 'docker-save-three-image', 'old Docker save archive kind')
  same(oldEvidence.backup?.archive_sha256, archiveHash, 'old Docker save archive evidence digest')
  same(canonical(rollback.old_runtime?.image_ids), canonical(oldEvidence.runtime?.preserved_image_ids), 'old image IDs')
  same(rollback.old_runtime?.gateway_id, oldEvidence.runtime?.gateway?.id, 'old external gateway ID')
  same(canonical(rollback.old_runtime?.container_ids), canonical(Object.fromEntries(oldEvidence.runtime.services.map(item => [item.service, item.id]))), 'old seven-container IDs')
  same(canonical(rollback.old_runtime?.config_sha256), canonical(Object.fromEntries(oldEvidence.runtime.services.map(item => [item.service, item.config_sha256]))), 'old seven-container configurations')
  exactKeys(rollback.old_runtime?.container_ids, ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync'], 'old seven container IDs')
  for (const id of Object.values(rollback.old_runtime.container_ids)) if (!SHA.test(id)) fail('old container ID must be full length')
  same(rollback.database?.strategy, 'forward_only', 'rollback database strategy')
  same(rollback.database?.schema_downgrade, false, 'rollback schema downgrade flag')
  same(rollback.database?.live_migration_version, 242, 'code-only cutover live migration version')
  same(rollback.database?.target_migration_tail, 242, 'old rollback image migration tail')
  if (!SHA.test(rollback.database?.allowed_prefix_sha256?.[242] ?? '') || Object.keys(rollback.database.allowed_prefix_sha256).length !== 1) fail('old recovery must allow only checksummed schema 242')
  same(rollback.volumes?.preserve, true, 'rollback volume preservation')
  if (!SHA.test(rollback.target?.manifest_sha256 ?? '') || !DIGEST.test(rollback.target?.image_set_digest ?? '')) fail('old public release identity is invalid')
  const created = Date.parse(rollback.created_at ?? '')
  const expires = Date.parse(rollback.expires_at ?? '')
  if (!Number.isFinite(created) || !Number.isFinite(expires) || rollback.created_at !== new Date(created).toISOString() || rollback.expires_at !== new Date(expires).toISOString() || created > Date.now() + 300_000 || expires <= Date.now() || expires - created > 86_400_000) fail('rollback capsule time window is invalid')
  if (!SHA.test(manifestSha) || !DIGEST.test(imageSetDigest)) fail('bridge release identity digest is invalid')
  console.log(JSON.stringify({ status: 'bridge-b-package-verified', release_id: candidate.release_id, git_sha: candidate.git_sha, source_sha256: candidate.source_sha256, manifest_sha256: manifestSha, image_set_digest: imageSetDigest, rollback_target_git_sha: OLD_GIT_SHA, rollback_live_migration_version: 242 }))
} catch (error) {
  console.error(`bridge B package verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
