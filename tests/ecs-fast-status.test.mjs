import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assess, collectPublicProbes, inventoryStatus, inventoryWarnings, isManagedDemoContainerName, publicProbeBlockers, PUBLIC_PROBE_URLS } from '../infra/scripts/ecs-fast-status.mjs'
const names = ['api', 'api-replica', 'ops-ui', 'pilot-gateway', 'postgres', 'redis']
function snapshot() {
  return { free_bytes: 10 * 1024 ** 3, services: names.map(service => ({ service, state: 'running', health: 'healthy', image: `registry/service@sha256:${'a'.repeat(64)}`, git_sha: ['postgres', 'redis'].includes(service) ? null : 'b'.repeat(40) })) }
}
test('healthy pinned live inventory does not require Git labels on upstream data services', () => {
  assert.deepEqual(assess(snapshot()), [])
  assert.deepEqual(inventoryWarnings(snapshot()), [])
})
test('inventory status distinguishes healthy demo runtime from formal production approval', () => {
  const result = inventoryStatus([])
  assert.deepEqual(result, {
    scope: 'inventory_only',
    demo_runtime_healthy: true,
    formal_production_approved: false,
    release_approved: false,
    next_step: 'Demo runtime healthy; formal production approval not evaluated. Freeze a target SHA; compare each component revision, verify migration compatibility and required release evidence before updating.',
  })
})
test('inventory blockers remain visible without evaluating formal production approval', () => {
  const result = inventoryStatus(['service_not_healthy:api'])
  assert.equal(result.scope, 'inventory_only')
  assert.equal(result.demo_runtime_healthy, false)
  assert.equal(result.formal_production_approved, false)
  assert.equal(result.release_approved, false)
  assert.equal(result.next_step, 'Demo runtime has inventory blockers; formal production approval not evaluated. Resolve the reported blockers before updating.')
})
test('mixed application Git revisions are surfaced without pretending health is release approval', () => {
  const value = snapshot()
  value.services.find(service => service.service === 'api-replica').git_sha = 'c'.repeat(40)
  assert.deepEqual(assess(value), [])
  assert.deepEqual(inventoryWarnings(value), ['application_services_have_mixed_source_revisions'])
})
test('an unhealthy replica is a blocker even when the API replica is present and pinned', () => {
  const value = snapshot()
  Object.assign(value.services.find(service => service.service === 'api-replica'), { state: 'running', health: 'unhealthy' })
  assert.deepEqual(assess(value), ['service_not_healthy:api-replica'])
})
test('data-service Git labels do not count as mixed application revisions', () => {
  const value = snapshot()
  value.services.find(service => service.service === 'postgres').git_sha = 'c'.repeat(40)
  value.services.find(service => service.service === 'redis').git_sha = 'd'.repeat(40)
  assert.deepEqual(inventoryWarnings(value), [])
})
test('missing replica, unhealthy API, mutable image, missing revision and low disk are reported together', () => {
  const value = snapshot()
  value.free_bytes = 1
  value.services = value.services.filter(s => s.service !== 'api-replica')
  Object.assign(value.services[0], { health: 'unhealthy', image: 'api:latest', git_sha: null })
  assert.deepEqual(assess(value).sort(), ['disk_free_below_8GiB', 'service_not_healthy:api', 'image_not_pinned:api', 'source_revision_missing:api', 'service_missing:api-replica'].sort())
})
test('an empty project cannot pass the inventory check', () => {
  assert.ok(assess({ free_bytes: 20 * 1024 ** 3, services: [] }).includes('live_project_missing'))
})

test('untouched database and Redis tag references are not application update blockers', () => {
  const value = snapshot()
  for (const service of value.services) if (['postgres', 'redis'].includes(service.service)) service.image = `${service.service}:stable`
  assert.deepEqual(assess(value), [])
})

test('an exact content-addressed local image ID is pinned, but mutable refs are not', () => {
  const value = snapshot()
  const gateway = value.services.find(service => service.service === 'pilot-gateway')
  gateway.image = `sha256:${'c'.repeat(64)}`
  gateway.image_id = gateway.image
  assert.deepEqual(assess(value), [])
  gateway.image = 'pilot-gateway:latest'
  assert.deepEqual(assess(value), ['image_not_pinned:pilot-gateway'])
  gateway.image = `sha256:${'d'.repeat(64)}`
  assert.deepEqual(assess(value), ['image_not_pinned:pilot-gateway'])
})

test('isolated candidate sidecars are excluded from the formal demo inventory', () => {
  assert.equal(isManagedDemoContainerName('merchant-demo-85575f9c-api-1'), true)
  assert.equal(isManagedDemoContainerName('merchant-demo-85575f9c-worker-scan-1'), true)
  assert.equal(isManagedDemoContainerName('merchant-candidate-api-ecs-20260930T133625Z-244933747f'), false)
  assert.equal(isManagedDemoContainerName('merchant-demo-85575f9c-api'), false)
})

test('fast status keeps liveness and readiness probes separate', () => {
  const source = readFileSync(fileURLToPath(new URL('../infra/scripts/ecs-fast-status.mjs', import.meta.url)), 'utf8')
  // /ops.yxsona.com/healthz is a liveness signal and /api/readyz is the
  // production readiness gate. A readiness 503 must remain visible even when
  // the liveness endpoint is 200; the report must not collapse them into one
  // boolean health result.
  assert.match(source, /https:\/\/yxsona\.com\/api\/readyz/u)
  assert.match(source, /https:\/\/yxsona\.com\/api\/healthz/u)
  assert.match(source, /DOCKER_CALL_TIMEOUT_SECONDS=45/u)
  assert.match(source, /timeout=DOCKER_CALL_TIMEOUT_SECONDS/u)
  assert.match(source, /https:\/\/ops\.yxsona\.com\/healthz/u)
  assert.match(source, /body\.data\?\.ready \?\? body\.data\?\.status === 'ok'/u)
  assert.match(source, /probe\.status !== 200 \|\| !probe\.ready/u)
  assert.match(source, /public_probe_failed:\$\{probe\.url\}/u)
  assert.match(source, /scope: 'inventory_only'/u)
  assert.match(source, /demo_runtime_healthy: demoRuntimeHealthy/u)
  assert.match(source, /formal_production_approved: false/u)
  assert.match(source, /formal production approval not evaluated/u)
  assert.match(source, /release_approved: false/u)
})

test('public API healthz probe is required and cannot grant release approval', async () => {
  const responses = new Map(PUBLIC_PROBE_URLS.map(url => [url, {
    status: 200,
    body: { data: url.endsWith('/releasez') ? { ready: true, release: { release_id: 'old-release' } } : { status: 'ok' } },
  }]))
  const fetchMock = async url => {
    const response = responses.get(url)
    if (response instanceof Error) throw response
    return { status: response.status, json: async () => response.body }
  }

  const healthy = await collectPublicProbes(fetchMock)
  assert.equal(healthy.find(probe => probe.url === 'https://yxsona.com/api/healthz')?.ready, true)
  assert.deepEqual(publicProbeBlockers(healthy), [])
  assert.equal(inventoryStatus([]).scope, 'inventory_only')
  assert.equal(inventoryStatus([]).release_approved, false)
  assert.equal(inventoryStatus([]).formal_production_approved, false)

  for (const failure of [
    new Error('endpoint unavailable'),
    { status: 503, body: { data: { status: 'ok' } } },
  ]) {
    responses.set('https://yxsona.com/api/healthz', failure)
    const probes = await collectPublicProbes(fetchMock)
    assert.ok(publicProbeBlockers(probes).includes('public_probe_failed:https://yxsona.com/api/healthz'))
    assert.equal(inventoryStatus(publicProbeBlockers(probes)).release_approved, false)
  }
})

test('a ready API does not hide an exited or unhealthy replica', () => {
  const value = snapshot()
  Object.assign(value.services.find(service => service.service === 'api-replica'), { state: 'exited', health: 'absent' })
  assert.deepEqual(assess(value), ['service_not_healthy:api-replica'])
})
