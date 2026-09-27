#!/usr/bin/env node
// Static, fail-closed candidate cross-check for the independent 242→254 bridge.
// This never inspects the host, verifies production provenance, or authorizes a mutation.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspectBridge254Compose } from './inspect-ecs-bridge-254-rendered-compose.mjs'

const SHA = /^sha256:[a-f0-9]{64}$/u
const GIT = /^[a-f0-9]{40}$/u
const CHANGED = Object.freeze(['apps/api/src/server.ts', 'packages/persistence/src/commercial-catalog-repository.ts', 'packages/persistence/src/migration.ts'])
const RUNTIME = Object.freeze(['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'])
const blockers = Object.freeze([
  'PROTECTED_SOURCE_AND_IMAGE_PROVENANCE_UNVERIFIED',
  'PRODUCTION_NONCE_CONSUMER_AND_CONTROLLER_INSTALL_UNVERIFIED',
  'SIGNED_OLD_RUNTIME_CAPTURE_AND_RECOVERY_UNVERIFIED',
  'LIVE_242_RUNTIME_AND_OPS_PREFIX_UNVERIFIED',
  'MAINTENANCE_FENCE_DRAIN_AND_BACKUP_UNVERIFIED',
  'FORWARD_243_TO_254_RECOVERY_UNVERIFIED',
  'REAL_API_WORKER_MCP_AND_BUSINESS_EVIDENCE_MISSING',
])
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`

export function reviewBridge254CandidatePreflight(input) {
  assert(exact(input, ['overlay_manifest', 'rendered_compose', 'expected']), 'exact review inputs are required')
  const manifest = input.overlay_manifest, config = input.rendered_compose, expected = input.expected
  assert(exact(expected, ['bridge', 'bridge_base_commit', 'migration_commit', 'migration_tail',
    'source_review_tree_sha256', 'overlay_tree_sha256', 'rendered_compose_sha256', 'api_image', 'worker_image']),
  'independently frozen candidate expectation is incomplete')
  const identity = expected.bridge
  assert(exact(identity, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'])
    && /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(identity.release_id ?? '')
    && GIT.test(identity.git_sha ?? '') && /^[a-f0-9]{64}$/u.test(identity.manifest_sha256 ?? '')
    && SHA.test(identity.image_set_digest ?? ''), 'independent bridge release identity is invalid')
  assert(GIT.test(expected.bridge_base_commit ?? '') && GIT.test(expected.migration_commit ?? '')
    && expected.migration_tail === 254 && SHA.test(expected.source_review_tree_sha256 ?? '')
    && SHA.test(expected.overlay_tree_sha256 ?? '') && SHA.test(expected.rendered_compose_sha256 ?? '')
    && /^[^\s]+@sha256:[a-f0-9]{64}$/u.test(expected.api_image ?? '')
    && /^[^\s]+@sha256:[a-f0-9]{64}$/u.test(expected.worker_image ?? ''),
  'independent source, Compose, image, or migration identity is invalid')
  assert(exact(manifest, ['schema_version', 'status', 'deployable', 'runtime_verified', 'source_review_tree_sha256',
    'bridge_base_commit', 'migration_commit', 'changed_paths', 'changed_digests', 'overlay_tree_sha256', 'missing_proof'])
    && manifest.schema_version === 'ecs-bridge-254-compatibility-overlay/1'
    && manifest.status === 'review_only' && manifest.deployable === false && manifest.runtime_verified === false,
  'overlay manifest must remain the exact non-deployable review schema')
  assert(manifest.source_review_tree_sha256 === expected.source_review_tree_sha256
    && manifest.overlay_tree_sha256 === expected.overlay_tree_sha256
    && manifest.bridge_base_commit === expected.bridge_base_commit
    && manifest.migration_commit === expected.migration_commit,
  'overlay source or migration identity differs from independent expectation')
  assert(Array.isArray(manifest.changed_paths) && canonical([...manifest.changed_paths].sort()) === canonical([...CHANGED].sort())
    && exact(manifest.changed_digests, CHANGED)
    && Object.values(manifest.changed_digests).every(value => SHA.test(value))
    && Array.isArray(manifest.missing_proof) && manifest.missing_proof.length > 0,
  'overlay patch list or proof gap list changed')
  const inspected = inspectBridge254Compose(config)
  assert(digest(config) === expected.rendered_compose_sha256,
    'rendered Compose differs from independently frozen canonical bytes')
  assert(inspected.release_id === identity.release_id && inspected.release_git_sha === identity.git_sha,
    'rendered runtime release differs from independent bridge identity')
  for (const name of RUNTIME) {
    const environment = config.services[name].environment
    assert(environment.RELEASE_MANIFEST_SHA256 === identity.manifest_sha256
      && environment.RELEASE_IMAGE_SET_DIGEST === identity.image_set_digest,
    `${name} manifest or image-set identity differs from the frozen bridge`)
    assert(config.services[name].image === (name.startsWith('api') ? expected.api_image : expected.worker_image),
      `${name} immutable image differs from the independently frozen image`)
  }
  return Object.freeze({ schema_version: 'ecs-bridge-254-candidate-preflight-review/1', status: 'review_only',
    static_cross_checks_passed: true, deployable: false, production_authorized: false, runtime_verified: false,
    release_id: identity.release_id, overlay_tree_sha256: manifest.overlay_tree_sha256,
    rendered_compose_sha256: expected.rendered_compose_sha256, blockers: [...blockers] })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    assert(process.argv.length === 2, 'usage: review-ecs-bridge-254-candidate-preflight.mjs < review-input.json')
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(reviewBridge254CandidatePreflight(input))}\n`)
  } catch (error) {
    process.stderr.write(`bridge-254 candidate review rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
