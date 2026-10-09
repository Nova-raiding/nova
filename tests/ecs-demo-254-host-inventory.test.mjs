import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireInventory, classifyInventory, DEMO_254_EXPECTED_SERVICES,
  DEMO_254_PROJECT, REMOTE_INVENTORY_PROGRAM, validateRemoteInventory } from '../infra/scripts/ecs-demo-254-host-inventory.mjs'

const sha = char => char.repeat(64)
const registryImageId = 'sha256:26b2eb03618e749084668eaff68cff8f81dda12d06ac641be7a6398b82a6f25b'
const registryContainerId = 'a77f0da8b0ee8a6607d521ed35c9dd40e3a70a8116b31f3cdffc451a93ada03f'
const registryNetworkId = 'afd13a439d098d2ae47fcbe9e458f2abcb4404f9c9961eebd60f808010b36f80'
const registryHashes = {
  env_sha256: '1c24775fadba31bd348800df91e54a100f1b2e4936bd629e5a36e89c5c8f51f7',
  config_sha256: '89790dac8b307c7a5e60af741f0035cfdcba0b370faae1e662e322dc30400804',
  host_config_sha256: '932f3cb9597e5cd6883a65a0600020bf34061cd76681ac789dc0b09374d9afc6',
  mounts_sha256: '20e1cf2546f240a0d7b8aaed46714c7f5d5a00cbe79c2859863e642282439e06',
}
const container = (id, service, overrides = {}) => ({
  id: sha(id), name: `/${service}`, state: 'running', health: 'healthy',
  image_id: `sha256:${sha('b')}`,
  compose: { 'com.docker.compose.project': DEMO_254_PROJECT,
    'com.docker.compose.service': service, 'com.docker.compose.project.config_files': '/srv/merchant/compose.yml',
    'com.docker.compose.project.working_dir': '/srv/merchant' },
  networks: [{ name: `${DEMO_254_PROJECT}_default`, id: sha('d'), aliases: [service] }],
  ports: [], mounts: [{ type: 'volume', name: `${DEMO_254_PROJECT}_data`, destination: '/data', read_write: true }],
  env_sha256: sha('e'), config_sha256: sha('f'), host_config_sha256: sha('1'), mounts_sha256: sha('2'),
  ...overrides,
})
const snapshot = containers => ({ schema_version: 'ecs-demo-254-host-inventory/2', project: DEMO_254_PROJECT, containers })
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

test('recognizes only the reviewed loopback shared registry fingerprint and keeps it visible', () => {
  const registry = container('e', 'registry', {
    id: registryContainerId,
    name: '/storenova-registry', image_id: registryImageId,
    state: 'running', health: 'absent',
    ...registryHashes,
    compose: { 'com.docker.compose.project': '', 'com.docker.compose.service': '',
      'com.docker.compose.project.config_files': '', 'com.docker.compose.project.working_dir': '' },
    networks: [{ name: 'bridge', id: registryNetworkId, aliases: [] }],
    ports: [{ container_port: '5000/tcp', host_ip: '127.0.0.1', host_port: '5000' }],
    mounts: [{ type: 'volume', name: 'storenova-registry-data', destination: '/var/lib/registry', read_write: true }],
    health: 'absent',
  })
  const result = classifyInventory(snapshot([...allExpected(), registry]))
  assert.equal(result.containers.at(-1).classification, 'shared_build_infrastructure')
  assert.deepEqual(result.shared_build_infrastructure_ids, [registry.id])
  assert.deepEqual(result.unclassified_external_consumer_ids, [])
  assert.ok(result.warnings.includes(`shared_build_infrastructure_consumer_policy_requires_review:${registry.id}`))
  assert.deepEqual(result.blockers, [])
  assert.equal(result.inventory_only, true)
  assert.equal(result.release_approved, false)
})

test('a registry-like container with any changed fingerprint remains an external consumer', () => {
  const base = container('e', 'registry', {
    id: registryContainerId,
    name: '/storenova-registry', image_id: registryImageId,
    state: 'running', health: 'absent',
    ...registryHashes,
    compose: { 'com.docker.compose.project': '', 'com.docker.compose.service': '',
      'com.docker.compose.project.config_files': '', 'com.docker.compose.project.working_dir': '' },
    networks: [{ name: 'bridge', id: registryNetworkId, aliases: [] }],
    ports: [{ container_port: '5000/tcp', host_ip: '127.0.0.1', host_port: '5000' }],
    mounts: [{ type: 'volume', name: 'storenova-registry-data', destination: '/var/lib/registry', read_write: true }],
    health: 'absent',
  })
  for (const override of [
    { id: sha('d') },
    { name: '/renamed-registry' }, { image_id: `sha256:${sha('9')}` },
    { state: 'exited' }, { health: 'unhealthy' },
    { networks: [{ name: 'merchant-demo-85575f9c_default', id: registryNetworkId, aliases: [] }] },
    { networks: [{ name: 'bridge', id: sha('c'), aliases: [] }] },
    { networks: [{ name: 'bridge', id: registryNetworkId, aliases: ['merchant-registry'] }] },
    { networks: [{ name: 'bridge', id: registryNetworkId, aliases: [] }, { name: 'other', id: sha('d'), aliases: [] }] },
    { ports: [{ container_port: '5000/tcp', host_ip: '0.0.0.0', host_port: '5000' }] },
    { ports: [{ container_port: '5000/tcp', host_ip: '127.0.0.1', host_port: '5000' }, { container_port: '5001/tcp', host_ip: '127.0.0.1', host_port: '5001' }] },
    { mounts: [{ type: 'volume', name: 'storenova-registry-data', destination: '/other', read_write: true }] },
    { mounts: [{ type: 'volume', name: 'storenova-registry-data', destination: '/var/lib/registry', read_write: false }] },
    { mounts: [{ type: 'volume', name: 'other-volume', destination: '/var/lib/registry', read_write: true }] },
    { env_sha256: sha('9') }, { config_sha256: sha('9') },
    { host_config_sha256: sha('9') }, { mounts_sha256: sha('9') },
    { compose: { ...base.compose, 'com.docker.compose.project.working_dir': '/srv/registry' } },
  ]) {
    const changed = { ...base, ...override }
    const result = classifyInventory(snapshot([...allExpected(), changed]))
    assert.ok(result.blockers.includes(`unclassified_external_consumer:${changed.id}`))
    assert.equal(result.release_approved, false)
  }
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

test('does not treat starting or absent Docker health as healthy for an expected role', () => {
  for (const health of ['starting', 'absent']) {
    const values = allExpected()
    values.find(item => item.compose['com.docker.compose.service'] === 'api').health = health
    const result = classifyInventory(snapshot(values))
    assert.ok(result.blockers.includes('expected_service_unhealthy:api'), `health=${health}`)
    assert.equal(result.release_approved, false)
  }
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
  assert.match(REMOTE_INVENTORY_PROGRAM, /'name':container_name if isinstance\(container_name,str\) else ''/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /'env'\s*:/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /'command'\s*:/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /'image_ref'|'image_labels'/u)
  assert.doesNotMatch(REMOTE_INVENTORY_PROGRAM, /json\.dumps\(item\)/u)
})
