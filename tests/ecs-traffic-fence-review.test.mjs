import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewEcsTrafficFence } from '../infra/scripts/review-ecs-traffic-fence.mjs'

const hash = x => x.repeat(64)
const gatewayId = hash('a')
const imageId = `sha256:${hash('b')}`
const observed = at_ms => ({
  at_ms, gateway_container_id: gatewayId, fence_config_sha256: hash('d'),
  ingress_fenced: true, in_flight_requests: 0, active_worker_cycles: 0,
  active_outbox_leases: 0, provider_started_unresolved: 0,
  unknown_outcomes: 0, unpublished_outbox_events: 0,
})
const fixture = () => ({
  gateway: { container_id: gatewayId, image_id: imageId,
    compose_project: 'merchant-demo-85575f9c', compose_service: 'pilot-gateway',
    host_ports: [80, 443], inspect_sha256: hash('c') },
  fence: { mode: 'gateway_reload', gateway_container_id: gatewayId,
    keep_public_listeners: true, deny_new_business_requests: true,
    before_config_sha256: hash('c'), fenced_config_sha256: hash('d'),
    restore_config_sha256: hash('c'), nginx_test_passed: true,
    rollback_test_passed: true },
  callback_policy: { gateway_container_id: gatewayId,
    keep_payment_callbacks: true, keep_provider_callbacks: true,
    exact_routes: ['/v1/payment/callback'], route_manifest_sha256: hash('e') },
  recovery: { gateway_container_id: gatewayId, old_image_id: imageId,
    before_config_sha256: hash('c'), db_prefix: 242, capsule_sha256: hash('f') },
  drain_observations: [observed(1_000), observed(31_000)],
})

test('isolated complete fixture is reviewable, never deploy authorized', () => {
  const result = reviewEcsTrafficFence(fixture(), { verify: () => true })
  assert.deepEqual(result, { review_only_ready: true, deployment_allowed: false, reasons: [] })
})

test('unsigned evidence and current unresolved work fail closed', () => {
  const input = fixture()
  input.drain_observations[1].unpublished_outbox_events = 65
  input.drain_observations[1].unknown_outcomes = 1
  const result = reviewEcsTrafficFence(input)
  assert.equal(result.review_only_ready, false)
  assert.ok(result.reasons.includes('PROTECTED_SIGNATURE_UNVERIFIED'))
  assert.ok(result.reasons.includes('DRAIN_EVIDENCE_UNVERIFIED'))
  assert.ok(result.reasons.includes('WORK_NOT_DRAINED'))
})

test('public listener shutdown, callback gap, and nonmatching recovery reject', () => {
  const input = fixture()
  input.fence.keep_public_listeners = false
  input.callback_policy.exact_routes = ['/v1/*']
  input.recovery.gateway_container_id = hash('1')
  const result = reviewEcsTrafficFence(input, { verify: () => true })
  assert.ok(result.reasons.includes('FENCE_NOT_REVERSIBLE'))
  assert.ok(result.reasons.includes('CALLBACK_POLICY_MISSING'))
  assert.ok(result.reasons.includes('RECOVERY_CAPSULE_MISSING'))
})

test('single drain snapshot and stale gateway identity reject', () => {
  const input = fixture()
  input.gateway.container_id = hash('1')
  input.drain_observations.pop()
  const result = reviewEcsTrafficFence(input, { verify: () => true })
  assert.ok(result.reasons.includes('FENCE_NOT_REVERSIBLE'))
  assert.ok(result.reasons.includes('DRAIN_OBSERVATIONS_MISSING'))
})
