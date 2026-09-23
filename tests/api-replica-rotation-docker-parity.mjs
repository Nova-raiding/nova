// Isolated local Docker parity experiment. Never targets a remote Docker host.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { publicPlan, preflightEngineClone, greenSpec, envValue } from '../infra/scripts/rotation/api-replica-credentials.mjs'
import { DockerEngine } from '../infra/scripts/rotation/docker-engine.mjs'

const suffix = randomBytes(4).toString('hex')
const prefix = `api-rotation-parity-${suffix}`
const networks = [`${prefix}-private`, `${prefix}-front`]
const names = [`${prefix}-api`, `${prefix}-api-replica`]
const key = randomBytes(32).toString('base64url')
const raw = JSON.stringify({ [key]: { workspaces: ['ws_parity'], roles: ['merchant_admin'], actor_id: 'parity_actor', bootstrap: false } })
const owned = []
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('LOCAL_DOCKER_COMMAND_FAILED')
  return result.stdout.trim()
}
try {
  const dockerHost = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  if (!dockerHost.startsWith('unix:///')) throw new Error('LOCAL_UNIX_SOCKET_REQUIRED')
  const socketPath = dockerHost.slice('unix://'.length)
  for (const network of networks) { docker(['network', 'create', network]); owned.push(['network', network]) }
  for (const name of names) {
    docker(['create', '--name', name, '--network', networks[0], '--network-alias', name,
      '--restart', 'unless-stopped', '--health-cmd', 'true', '--health-interval', '1s',
      '-e', `API_AUTH_TOKENS=${raw}`, 'alpine:3', 'sleep', '180'])
    owned.push(['container', name])
    docker(['network', 'connect', '--alias', name, networks[1], name])
    docker(['start', name])
  }
  const inspects = names.map(name => JSON.parse(docker(['inspect', name]))[0])
  const plan = publicPlan(inspects, raw)
  try { await preflightEngineClone(new DockerEngine(socketPath), plan) }
  catch (error) {
    const probeName = `${prefix}-diagnostic`
    const engine = new DockerEngine(socketPath)
    const id = await engine.create(probeName, plan.specs[0])
    try {
      for (const network of plan.specs[0].secondary) await engine.connect(id, network.name, network.endpoint)
      const actual = await engine.inspect(id)
      const expected = plan.snapshots[0].hostConfig
      const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual.HostConfig)])]
      const changed = keys.filter(name => JSON.stringify(expected[name]) !== JSON.stringify(actual.HostConfig[name]))
      process.stderr.write(`LOCAL_DOCKER_HOSTCONFIG_DIFFERING_KEYS: ${changed.join(',')}\n`)
      process.stderr.write(`LOCAL_DOCKER_NETWORKS: ${Object.entries(actual.NetworkSettings?.Networks ?? {}).map(([name, value]) => `${name}:${Boolean(value.NetworkID)}:${(value.Aliases ?? []).length}`).join(',')}\n`)
    } finally { await engine.remove(id) }
    throw error
  }
  const engine = new DockerEngine(socketPath)
  for (const snapshot of plan.snapshots) {
    const name = `${snapshot.name}-green`
    const spec = greenSpec(snapshot, plan.rotation.raw, name)
    const id = await engine.create(name, spec)
    owned.push(['container', name])
    for (const network of spec.secondary) await engine.connect(id, network.name, network.endpoint)
    await engine.start(id)
    await engine.waitHealthy(id, 30000)
    const live = await engine.inspect(id)
    if (live.Image !== snapshot.image || live.State.Health.Status !== 'healthy' || envValue(live.Config.Env, 'API_AUTH_TOKENS') !== plan.rotation.raw || Object.keys(live.HostConfig.PortBindings ?? {}).length !== 0) {
      throw new Error('LOCAL_GREEN_PARITY_DRIFT')
    }
  }
  process.stdout.write('LOCAL_DOCKER_CLONE_PARITY_PASSED\n')
} catch (error) {
  process.stderr.write(`LOCAL_DOCKER_CLONE_PARITY_FAILED: ${error?.message?.match(/^[A-Z_]+$/)?.[0] ?? 'UNEXPECTED_FAILURE'}\n`)
  process.exitCode = 1
} finally {
  for (const [kind, name] of owned.reverse()) {
    if (kind === 'container') spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    else spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' })
  }
}
