import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assess, inventoryWarnings } from '../infra/scripts/ecs-fast-status.mjs'
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
