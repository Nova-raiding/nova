import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assess, inventoryWarnings, isManagedDemoContainerName } from '../infra/scripts/ecs-fast-status.mjs'
const names = ['api', 'api-replica', 'ops-ui', 'pilot-gateway', 'postgres', 'redis']
function snapshot() {
  return { free_bytes: 10 * 1024 ** 3, services: names.map(service => ({ service, state: 'running', health: 'healthy', image: `registry/service@sha256:${'a'.repeat(64)}`, git_sha: ['postgres', 'redis'].includes(service) ? null : 'b'.repeat(40) })) }
}
test('healthy pinned live inventory does not require Git labels on upstream data services', () => {
  assert.deepEqual(assess(snapshot()), [])
  assert.deepEqual(inventoryWarnings(snapshot()), [])
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
  assert.match(source, /https:\/\/ops\.yxsona\.com\/healthz/u)
  assert.match(source, /probe\.status !== 200 \|\| !probe\.ready/u)
  assert.match(source, /release_approved: false/u)
})
