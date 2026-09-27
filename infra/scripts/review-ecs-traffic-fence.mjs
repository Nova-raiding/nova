#!/usr/bin/env node
// A review-only contract for a maintenance traffic fence. No Docker, network,
// gateway reload, worker signal, or database mutation is reachable here.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const SHA256 = /^[a-f0-9]{64}$/u
const ID = /^[a-f0-9]{64}$/u
const nonnegative = x => Number.isSafeInteger(x) && x >= 0
const fail = (reasons, code, condition) => { if (!condition) reasons.push(code) }

/**
 * `verify` is a protected host trust port. It must verify the signature,
 * signer scope, expiry, and binding to the supplied SHA and gateway ID.
 * This module intentionally never infers trust from `signed: true` fields.
 */
export function reviewEcsTrafficFence(evidence, { verify } = {}) {
  const reasons = []
  const gateway = evidence?.gateway ?? {}
  const fence = evidence?.fence ?? {}
  const callback = evidence?.callback_policy ?? {}
  const recovery = evidence?.recovery ?? {}
  const observations = evidence?.drain_observations
  fail(reasons, 'GATEWAY_IDENTITY_MISSING', ID.test(gateway.container_id ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(gateway.image_id ?? '')
    && gateway.compose_project === 'merchant-demo-85575f9c'
    && gateway.compose_service === 'pilot-gateway'
    && gateway.host_ports?.includes(80) && gateway.host_ports?.includes(443)
    && SHA256.test(gateway.inspect_sha256 ?? ''))
  fail(reasons, 'FENCE_NOT_REVERSIBLE', fence.mode === 'gateway_reload'
    && fence.gateway_container_id === gateway.container_id
    && fence.keep_public_listeners === true
    && fence.deny_new_business_requests === true
    && SHA256.test(fence.before_config_sha256 ?? '')
    && SHA256.test(fence.fenced_config_sha256 ?? '')
    && fence.before_config_sha256 !== fence.fenced_config_sha256
    && fence.restore_config_sha256 === fence.before_config_sha256
    && fence.nginx_test_passed === true && fence.rollback_test_passed === true)
  fail(reasons, 'CALLBACK_POLICY_MISSING', callback.gateway_container_id === gateway.container_id
    && callback.keep_payment_callbacks === true
    && callback.keep_provider_callbacks === true
    && Array.isArray(callback.exact_routes) && callback.exact_routes.length > 0
    && callback.exact_routes.every(x => typeof x === 'string' && x.startsWith('/') && !x.includes('*'))
    && SHA256.test(callback.route_manifest_sha256 ?? ''))
  fail(reasons, 'RECOVERY_CAPSULE_MISSING', recovery.gateway_container_id === gateway.container_id
    && recovery.old_image_id === gateway.image_id
    && recovery.before_config_sha256 === fence.before_config_sha256
    && recovery.db_prefix === 242
    && SHA256.test(recovery.capsule_sha256 ?? ''))
  fail(reasons, 'PROTECTED_SIGNATURE_UNVERIFIED', typeof verify === 'function'
    && ['gateway', 'fence', 'callback_policy', 'recovery'].every(kind => verify(kind, evidence[kind]) === true))
  fail(reasons, 'DRAIN_OBSERVATIONS_MISSING', Array.isArray(observations) && observations.length >= 2)
  if (Array.isArray(observations) && observations.length >= 2) {
    const first = observations[0], last = observations.at(-1)
    fail(reasons, 'DRAIN_WINDOW_INVALID', Number.isSafeInteger(first?.at_ms)
      && Number.isSafeInteger(last?.at_ms) && last.at_ms - first.at_ms >= 30_000
      && observations.every(x => x?.fence_config_sha256 === fence.fenced_config_sha256
        && x?.gateway_container_id === gateway.container_id && x?.ingress_fenced === true))
    fail(reasons, 'WORK_NOT_DRAINED', observations.every(x =>
      ['in_flight_requests', 'active_worker_cycles', 'active_outbox_leases',
        'provider_started_unresolved', 'unknown_outcomes', 'unpublished_outbox_events']
        .every(key => nonnegative(x?.[key]) && x[key] === 0)))
    fail(reasons, 'DRAIN_EVIDENCE_UNVERIFIED', typeof verify === 'function'
      && observations.every(x => verify('drain_observation', x) === true))
  }
  return {
    review_only_ready: reasons.length === 0,
    deployment_allowed: false,
    reasons,
  }
}

// Local CLI can expose only a list of failed gates. It has no trust port, so
// its result cannot authorize production mutation even with plausible JSON.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('one evidence path required')
    const evidence = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    const result = reviewEcsTrafficFence(evidence)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = 1
  } catch {
    process.stderr.write('traffic-fence review failed; no production action taken\n')
    process.exitCode = 1
  }
}
