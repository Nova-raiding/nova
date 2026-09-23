// Explicit local Docker test only; never run on a production host.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const image = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const networks = ['merchant-production_default', 'storenova-demo-e0']
const run = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
assert.equal(process.platform, 'darwin', 'this Docker-name test is limited to the local macOS host')
assert.equal(run('context', 'show'), 'colima', 'this Docker-name test requires the local Colima daemon')
const ownedContainers = [], ownedNetworks = []
const directory = mkdtempSync(join(tmpdir(), 'bridge-old-map-'))
try {
  for (const name of networks) {
    assert.equal(run('network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'), '', `refuse to touch existing network ${name}`)
    run('network', 'create', name)
    ownedNetworks.push(name)
  }
  for (const service of services) {
    const id = run('run', '-d', '--rm', '--pull=never', '--name', `merchant-production-${service}-1`, '--network', networks[0], image, 'sleep', '600')
    assert.match(id, /^[0-9a-f]{64}$/u)
    ownedContainers.push(id)
    if (service === 'api-replica') run('network', 'connect', networks[1], id)
  }
  const gateway = run('run', '-d', '--rm', '--pull=never', '--name', `bridge-old-gateway-${process.pid}`,
    '--network', networks[0], '-p', '127.0.0.1:80:8080', '-p', '127.0.0.1:443:8443', image, 'sleep', '600')
  assert.match(gateway, /^[0-9a-f]{64}$/u)
  ownedContainers.push(gateway)
  const output = join(directory, 'old-map.json')
  execFileSync('node', ['infra/scripts/create-ecs-bridge-old-map.mjs', output, gateway], { stdio: 'pipe' })
  const map = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(map.map(({ service, container }) => ({ service, container })), services.map(service => ({ service, container: `merchant-production-${service}-1` })))
  for (const [index, entry] of map.entries()) {
    assert.equal(entry.container_id, ownedContainers[index])
    for (const field of ['image_id', 'config_sha256', 'host_sha256', 'networks_sha256']) {
      assert.match(entry[field], field === 'image_id' ? /^sha256:[0-9a-f]{64}$/u : /^[0-9a-f]{64}$/u)
    }
    assert.equal(JSON.stringify(entry).includes('Env'), false, 'old map must not serialize environment values')
  }
  assert.equal(statSync(output).mode & 0o777, 0o600)
  assert.notEqual(execFileSync('docker', ['inspect', '--format', '{{.Id}}', gateway], { encoding: 'utf8' }).trim(), '')
  const worker = ownedContainers[1]
  run('rename', worker, `bridge-temporary-worker-${process.pid}`)
  try {
    const missing = spawnSync('node', ['infra/scripts/create-ecs-bridge-old-map.mjs', join(directory, 'missing-worker.json'), gateway], { encoding: 'utf8' })
    assert.notEqual(missing.status, 0, 'historical worker name drift must be rejected')
  } finally { run('rename', worker, `merchant-production-${services[1]}-1`) }
  console.log('PASS: actual seven unlabeled IDs and config/network fingerprints frozen without inspect env serialization')
} finally {
  for (const id of [...ownedContainers].reverse()) {
    try { run('rm', '-f', id) } catch { console.error(`owned test container requires inspection: ${id}`) }
  }
  for (const name of [...ownedNetworks].reverse()) {
    try { run('network', 'rm', name) } catch { console.error(`owned test network requires inspection: ${name}`) }
  }
  rmSync(directory, { recursive: true })
}
