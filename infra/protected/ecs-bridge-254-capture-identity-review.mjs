#!/usr/bin/env node
// Read-only live comparison for a proposed 242→254 old-runtime capture.
// The caller's capture/plan is not a trust anchor; this never signs or mutates it.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBridge254FrozenCapture } from './ecs-bridge-254-maintenance-core.mjs'

const NAMES = Object.freeze({
  'api-replica': 'merchant-production-api-replica-1',
  'worker-sync': 'merchant-production-worker-sync-1',
  'worker-generation': 'merchant-production-worker-generation-1',
  'worker-publish': 'merchant-production-worker-publish-1',
  'worker-reconcile': 'merchant-production-worker-reconcile-1',
  'worker-automation': 'merchant-production-worker-automation-1',
  'worker-scan': 'merchant-production-worker-scan-1',
  'external-gateway': 'merchant-demo-85575f9c-pilot-gateway-1',
})
const SHA = /^[a-f0-9]{64}$/u
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const sha = value => createHash('sha256').update(canonical(value)).digest('hex')
function requireValue(value, message) { if (!value) throw new Error(message) }
function exactIdentity(value) {
  const identity = value?.data?.release ?? value?.release
  requireValue(identity && typeof identity === 'object' && !Array.isArray(identity), 'public release identity is absent')
  return {
    release_id: identity.release_id,
    git_sha: identity.release_git_sha,
    manifest_sha256: identity.manifest_sha256,
    image_set_digest: identity.image_set_digest,
  }
}

export function reviewBridge254LiveCaptureIdentity({ capture, expected, run = execFileSync }) {
  const captureSha = assertBridge254FrozenCapture(capture, expected)
  requireValue(!expected.old_runtime || canonical(expected.old_runtime) === canonical(expected.oldRuntime),
    'maintenance and signed-state old identities differ')
  const blockers = []
  const add = (ok, code) => { if (!ok) blockers.push(code) }
  const names = Object.values(NAMES)
  const inspected = JSON.parse(run('docker', ['inspect', ...names], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  requireValue(Array.isArray(inspected) && inspected.length === names.length, 'live Docker inspect did not return all eight containers')
  const actual = new Map(inspected.map(item => [item?.Name?.replace(/^\//u, ''), item]))
  requireValue(actual.size === names.length && names.every(name => actual.has(name)), 'live Docker container names differ from the fixed old runtime')
  for (const item of capture.containers) {
    const current = actual.get(NAMES[item.role])
    requireValue(current, 'capture contains an unknown old runtime role')
    const networks = current.NetworkSettings?.Networks
    add(current.Id === item.id && SHA.test(current.Id ?? ''), `OLD_${item.role}_ID_CHANGED`)
    add(current.Image === item.image_id && /^sha256:[a-f0-9]{64}$/u.test(current.Image ?? ''), `OLD_${item.role}_IMAGE_CHANGED`)
    add(current.State?.Running === true && item.running === true, `OLD_${item.role}_NOT_RUNNING`)
    add(networks && Object.keys(networks).length > 0 && sha(networks) === item.network_sha256, `OLD_${item.role}_NETWORK_CHANGED`)
    add(sha(current) === item.inspect_sha256, `OLD_${item.role}_INSPECT_CHANGED`)
  }
  const gateway = actual.get(NAMES['external-gateway'])
  const bindings = gateway.NetworkSettings?.Ports ?? {}
  add(Object.values(bindings).flat().some(port => port?.HostPort === '80' && port?.HostIp === '0.0.0.0')
    && Object.values(bindings).flat().some(port => port?.HostPort === '443' && port?.HostIp === '0.0.0.0'),
  'PUBLIC_GATEWAY_PORTS_CHANGED')
  const publicResult = JSON.parse(run('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', 'https://yxsona.com/api/releasez'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }))
  const publicIdentity = exactIdentity(publicResult)
  add(canonical(publicIdentity) === canonical(capture.public_release), 'PUBLIC_RELEASE_DIFFERS_FROM_CAPTURE')
  add(canonical(publicIdentity) === canonical(expected.oldRuntime), 'PUBLIC_RELEASE_DIFFERS_FROM_APPROVED_OLD_RUNTIME')
  return {
    schema_version: 'ecs-bridge-254-live-capture-identity-review/1',
    status: blockers.length ? 'blocked' : 'review_only',
    capture_sha256: captureSha,
    docker_and_public_identity_consistent: blockers.length === 0,
    database_roles_verified: false, recovery_capsule_verified: false, trusted_source_verified: false,
    production_authorized: false, deployable: false,
    blockers: [...blockers, 'DATABASE_RUNTIME_AND_OPS_PREFIX_NOT_INDEPENDENTLY_VERIFIED',
      'RECOVERY_CAPSULE_AND_TRUSTED_CAPTURE_NOT_VERIFIED'],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length === 4 && process.argv[2] === '--input', 'usage: ecs-bridge-254-capture-identity-review.mjs --input <review JSON>')
    const input = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    const result = reviewBridge254LiveCaptureIdentity(input)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status === 'blocked') process.exitCode = 2
  } catch (error) {
    process.stderr.write(`bridge 254 live capture review rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
