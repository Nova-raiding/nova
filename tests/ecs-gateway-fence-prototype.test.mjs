import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { applyGatewayFencePrototype, renderGatewayFence, reviewGatewayDrainPair } from '../infra/protected/ecs-gateway-fence-prototype.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`, networkId = 'e'.repeat(64)
const baseline = `map $http_upgrade $connection_upgrade { default upgrade; }\nserver { listen 8080; server_name yxsona.com; }\nserver {\n  listen 8443 ssl;\n  server_name yxsona.com www.yxsona.com admin.yxsona.com ops.yxsona.com;\n  location ^~ /v1/ { proxy_pass http://pilot_api; }\n}\n`
const capsule = () => ({ gateway_id: id, image_id: image, project: 'merchant-demo-85575f9c',
  service: 'pilot-gateway', host_ports: [80, 443], network_id: networkId, config_sha256: sha(baseline),
  rollback: { gateway_id: id, config_sha256: sha(baseline), db_prefix: 242, archive_sha256: 'c'.repeat(64) } })
const callbacks = () => ({ gateway_id: id, exact_paths: ['/v1/billing/callback/alipay', '/v1/billing/callback/wechat'] })
const harness = ({ failAt } = {}) => {
  let config = baseline, reloads = 0, saved = false
  return {
    state: () => ({ config, reloads, saved }),
    port: {
      assertLock: async () => {},
      inspect: async () => ({ Id: id, Image: image, State: { Running: true }, Config: { Labels: {
        'com.docker.compose.project': 'merchant-demo-85575f9c', 'com.docker.compose.service': 'pilot-gateway' } },
      HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '80' }], '8443/tcp': [{ HostPort: '443' }] } },
      NetworkSettings: { Networks: { 'merchant-demo-85575f9c_default': { NetworkID: networkId } } } }),
      readConfig: async () => config,
      saveOriginal: async (text, digest) => { saved = text === baseline && digest === sha(baseline); return saved },
      writeConfig: async text => { config = text },
      nginxTest: async () => failAt === 'test' && config.includes('merchant_maintenance_block') ? false : true,
      reload: async () => { reloads += 1 },
      probe: async paths => ({ gateway_id: id, ports: [80, 443], new_business_status: 503,
        callback_paths: paths, callbacks_reached_api: failAt !== 'probe' }),
      probeBaseline: async () => config === baseline,
    },
  }
}

test('renders one exact server fence and preserves listener declarations', () => {
  const value = renderGatewayFence(baseline, callbacks().exact_paths)
  assert.match(value.config, /map "\$request_method:\$uri" \$merchant_maintenance_block/)
  assert.match(value.config, /"POST:\/v1\/billing\/callback\/alipay" 0;/)
  assert.match(value.config, /if \(\$merchant_maintenance_block\) \{ return 503; \}/)
  assert.equal(value.config.split('listen 8443 ssl;').length, 2)
  assert.equal(value.config.split('listen 8080;').length, 2)
  assert.throws(() => renderGatewayFence(baseline, ['/v1/*']), /CALLBACK_PATH_INVALID/)
})

test('fences via injected ports with durable rollback copy and no deployment authority', async () => {
  const h = harness()
  const result = await applyGatewayFencePrototype({ capsule: capsule(), callbacks: callbacks(),
    verify: () => true, port: h.port })
  assert.equal(result.status, 'fenced_review_only')
  assert.equal(result.deployment_allowed, false)
  assert.equal(h.state().saved, true)
  assert.equal(h.state().reloads, 1)
})

test('nginx validation failure restores exact original config', async () => {
  const h = harness({ failAt: 'test' })
  await assert.rejects(applyGatewayFencePrototype({ capsule: capsule(), callbacks: callbacks(),
    verify: () => true, port: h.port }), /NGINX_TEST_FAILED/)
  assert.equal(h.state().config, baseline)
  assert.equal(h.state().reloads, 1)
})

test('post-reload callback probe failure reloads original config', async () => {
  const h = harness({ failAt: 'probe' })
  await assert.rejects(applyGatewayFencePrototype({ capsule: capsule(), callbacks: callbacks(),
    verify: () => true, port: h.port }), /FENCE_PROBE_FAILED/)
  assert.equal(h.state().config, baseline)
  assert.equal(h.state().reloads, 2)
})

test('unsigned or stale capsule refuses before any write', async () => {
  const h = harness()
  await assert.rejects(applyGatewayFencePrototype({ capsule: capsule(), callbacks: callbacks(),
    verify: () => false, port: h.port }), /CAPSULE_SIGNATURE_INVALID/)
  assert.equal(h.state().saved, false)
  const wrong = capsule(); wrong.gateway_id = 'd'.repeat(64)
  await assert.rejects(applyGatewayFencePrototype({ capsule: wrong, callbacks: callbacks(),
    verify: () => true, port: h.port }), /CAPSULE_IDENTITY_MISMATCH/)
  assert.equal(h.state().saved, false)
})

test('signed double drain snapshot requires exact binding, interval, and zero counters', () => {
  const sample = at_ms => ({ gateway_id: id, fenced_sha256: 'd'.repeat(64), ingress_fenced: true,
    callbacks_reached_api: true, at_ms, in_flight_requests: 0, active_worker_cycles: 0,
    active_outbox_leases: 0, provider_started_unresolved: 0, unknown_outcomes: 0,
    unpublished_outbox_events: 0 })
  const first = sample(1000), second = sample(31000)
  assert.equal(reviewGatewayDrainPair({ first, second, fenced_sha256: 'd'.repeat(64), gateway_id: id,
    verify: () => true }).deployment_allowed, false)
  second.unknown_outcomes = 1
  assert.throws(() => reviewGatewayDrainPair({ first, second, fenced_sha256: 'd'.repeat(64),
    gateway_id: id, verify: () => true }), /WORK_NOT_DRAINED/)
})
