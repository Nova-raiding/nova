import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertBridgeDockerEnvironment, bridgeDockerInvocation, createBridgeDockerClient, discoverBridgeDockerSocket } from './bridge-docker-target.mjs'

test('pins Docker commands to one discovered local socket and isolated empty config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-docker-policy-test-'))
  let client
  try {
    client = await createBridgeDockerClient({
      environment: {}, directory: root,
      candidates: ['/local/docker.sock'],
      inspect: async () => ({ isSocket: () => true }),
    })
    assert.equal(client.socket, '/local/docker.sock')
    assert.deepEqual(client.args, ['--host', 'unix:///local/docker.sock', '--config', client.configPath])
    assert.deepEqual(client.environment, { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' })
    assert.deepEqual(await readdir(client.configPath), [])
    assert.equal((await stat(client.configPath)).mode & 0o777, 0o700)
  } finally {
    await client?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects remote Docker host, context, or user config before socket probing', async () => {
  const overrides = [
    { DOCKER_HOST: 'tcp://production.example:2376' },
    { DOCKER_CONTEXT: 'production' },
    { DOCKER_CONFIG: '/shared/docker-config' },
  ]
  for (const environment of overrides) {
    let probes = 0
    const inspect = async () => { probes += 1; return { isSocket: () => true } }
    assert.throws(() => assertBridgeDockerEnvironment(environment), /DOCKER_OVERRIDE_FORBIDDEN/u)
    await assert.rejects(discoverBridgeDockerSocket({ environment, candidates: ['/local/docker.sock'], inspect }), /DOCKER_OVERRIDE_FORBIDDEN/u)
    assert.equal(probes, 0)
  }
})

test('fails closed when local Docker socket discovery is missing or ambiguous', async () => {
  const noSocket = async () => ({ isSocket: () => false })
  const socket = async () => ({ isSocket: () => true })
  await assert.rejects(discoverBridgeDockerSocket({ environment: {}, candidates: ['/missing.sock'], inspect: noSocket }), /SOCKET_AMBIGUOUS_OR_MISSING/u)
  await assert.rejects(discoverBridgeDockerSocket({ environment: {}, candidates: ['/a.sock', '/b.sock'], inspect: socket }), /SOCKET_AMBIGUOUS_OR_MISSING/u)
})

test('Docker invocation has no user context selector and internal network creation is explicit', async () => {
  assert.deepEqual(bridgeDockerInvocation('/var/run/docker.sock', '/tmp/isolated-config'), {
    args: ['--host', 'unix:///var/run/docker.sock', '--config', '/tmp/isolated-config'],
    environment: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' },
  })
  for (const path of ['bridge-254-image-smoke.mjs', 'bridge-254-compose-chain-smoke.mjs']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /createBridgeDockerClient/u)
    assert.match(source, /\[\.\.\.dockerClient\.args, \.\.\.args\]/u)
    assert.match(source, /'network', 'create', '--internal', network/u)
    assert.match(source, /networkInfo\.Internal !== true/u)
    assert.doesNotMatch(source, /env:\s*process\.env/u)
  }
})
