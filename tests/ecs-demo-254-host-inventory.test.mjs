import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireInventory, classifyInventory, DEMO_254_EXPECTED_SERVICES,
  DEMO_254_PROJECT, REMOTE_INVENTORY_PROGRAM, validateRemoteInventory } from '../infra/scripts/ecs-demo-254-host-inventory.mjs'

const sha = char => char.repeat(64)
const container = (id, service, overrides = {}) => ({
  id: sha(id), state: 'running', health: 'healthy',
  image_id: `sha256:${sha('b')}`,
  compose: { 'com.docker.compose.project': DEMO_254_PROJECT,
    'com.docker.compose.service': service, 'com.docker.compose.project.config_files': '/srv/merchant/compose.yml',
    'com.docker.compose.project.working_dir': '/srv/merchant' },
  networks: [{ name: `${DEMO_254_PROJECT}_default`, id: sha('d'), aliases: [service] }],
  ports: [], mounts: [{ type: 'volume', name: `${DEMO_254_PROJECT}_data`, destination: '/data', read_write: true }],
  env_sha256: sha('e'), config_sha256: sha('f'), host_config_sha256: sha('1'), mounts_sha256: sha('2'),
  ...overrides,
})
const snapshot = containers => ({ schema_version: 'ecs-demo-254-host-inventory/1', project: DEMO_254_PROJECT, containers })
const allExpected = () => DEMO_254_EXPECTED_SERVICES.map((service, index) => container(index.toString(16), service))

test('classifies exact demo project roles and always remains inventory-only', () => {
  const result = classifyInventory(snapshot(allExpected()))
  assert.deepEqual(result.blockers, [])
  assert.equal(result.release_approved, false)
  assert.equal(result.inventory_only, true)
  assert.deepEqual(result.expected_services, [...DEMO_254_EXPECTED_SERVICES])
  assert.ok(result.containers.every(item => item.classification === 'expected_demo_role'))
})

test('flags all non-demo and unexpected services as unclassified external consumers', () => {
  const unrelated = container('e', 'worker-scan', { compose: { ...container('f', 'api').compose,
    'com.docker.compose.project': 'merchant-production', 'com.docker.compose.service': 'worker-scan' } })
  const unlabeled = container('f', 'unknown', { compose: { 'com.docker.compose.project': '',
    'com.docker.compose.service': '', 'com.docker.compose.project.config_files': '',
    'com.docker.compose.project.working_dir': '' }, state: 'exited', health: 'absent' })
  const result = classifyInventory(snapshot([...allExpected(), unrelated, unlabeled]))
  assert.deepEqual(result.unclassified_external_consumer_ids, [unrelated.id, unlabeled.id])
  assert.ok(result.blockers.includes(`unclassified_external_consumer:${unrelated.id}`))
  assert.ok(result.blockers.includes(`unclassified_external_consumer:${unlabeled.id}`))
  assert.equal(result.release_approved, false)
})

test('reports missing, duplicate, stopped, and explicitly unhealthy expected roles', () => {
  const values = allExpected().filter(item => item.compose['com.docker.compose.service'] !== 'worker-sync')
  values.push(container('e', 'api'))
  values.find(item => item.compose['com.docker.compose.service'] === 'worker-publish').state = 'exited'
  values.find(item => item.compose['com.docker.compose.service'] === 'worker-publish').health = 'unhealthy'
  const result = classifyInventory(snapshot(values))
  assert.ok(result.blockers.includes('expected_service_missing:worker-sync'))
  assert.ok(result.blockers.includes('expected_service_duplicate:api'))
  assert.ok(result.blockers.includes('expected_service_not_running:worker-publish'))
  assert.ok(result.blockers.includes('expected_service_unhealthy:worker-publish'))
})

test('rejects malformed remote schemas, duplicate IDs, unknown fields, and invalid hashes', () => {
  assert.throws(() => validateRemoteInventory({ ...snapshot([]), secret: 'do-not-emit' }), /schema rejected/u)
  const duplicateId = container('a', 'api')
  assert.throws(() => validateRemoteInventory(snapshot([duplicateId, { ...duplicateId }])), /projection rejected/u)
  assert.throws(() => validateRemoteInventory(snapshot([container('a', 'api', { raw_env: 'secret' })])), /projection rejected/u)
  assert.throws(() => validateRemoteInventory(snapshot([container('a', 'api', { env_sha256: 'not-a-hash' })])), /projection rejected/u)
  assert.throws(() => validateRemoteInventory(snapshot([container('a', 'api', { mounts: [{ destination: '/x', source: '/secret' }] })])), /mount rejected/u)
})

test('uses only the fixed SSH target and passes the read-only collector via stdin', () => {
  let invocation
  const output = JSON.stringify(snapshot(allExpected()))
  const result = acquireInventory((...args) => { invocation = args; return { status: 0, stdout: output } })
  assert.deepEqual(invocation.slice(0, 2), ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '101', 'python3 -']])
  assert.equal(invocation[2].input, REMOTE_INVENTORY_PROGRAM)
  assert.equal(invocation[2].timeout, 60_000)
  assert.deepEqual(invocation[2].env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' })
  assert.equal(result.release_approved, false)
  assert.match(REMOTE_INVENTORY_PROGRAM, /ps','-a','-q','--no-trunc/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /call\('(?!ps'|inspect'|image')/u)
})

test('fails closed for SSH errors and malformed output without echoing remote data', () => {
  assert.throws(() => acquireInventory(() => ({ status: 255, stdout: 'secret-from-remote' })), /inventory failed/u)
  assert.throws(() => acquireInventory(() => ({ status: 0, stdout: 'secret-from-remote' })), /JSON rejected/u)
  const serialized = JSON.stringify(classifyInventory(snapshot([container('a', 'api')])))
  assert.doesNotMatch(serialized, /secret|DATABASE_URL|PASSWORD|Config\.Env|Cmd/u)
  assert.ok(serialized.includes(`sha256:${sha('b')}`))
})

test('remote collector hashes sensitive Docker structures but projects only approved fields', () => {
  assert.match(REMOTE_INVENTORY_PROGRAM, /universal_newlines=True/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /text=True/u)
  assert.match(REMOTE_INVENTORY_PROGRAM, /'env_sha256':digest\(env\)/u)
  assert.match(REMOTE_INVENTORY_PROGRAM, /'config_sha256':digest\(config\)/u)
  assert.match(REMOTE_INVENTORY_PROGRAM, /'host_config_sha256':digest\(host\)/u)
  assert.match(REMOTE_INVENTORY_PROGRAM, /'mounts_sha256':digest\(item\.get\('Mounts'\) or \[\]\)/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /'env'\s*:/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /'command'\s*:/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /'image_ref'|'image_labels'/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /json\.dumps\(item\)/u)
})
