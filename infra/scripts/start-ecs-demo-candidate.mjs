#!/usr/bin/env node
// First-install phase one: run a frozen release on an isolated Compose project.
// This entrypoint never binds public ports, stops an existing container, or
// removes a volume. Public cutover is a separate, explicit operation.
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const fail = message => { console.error(message); process.exit(1) }
const [composePath, envPath, project, identityPath] = process.argv.slice(2)
if (process.argv.length !== 6) fail('usage: start-ecs-demo-candidate.mjs <rendered-compose.json> <candidate.env> <merchant-demo-project> <candidate-identity.txt>')
if (!/^merchant-demo-[a-z0-9][a-z0-9_-]{0,25}$/.test(project)) fail('demo candidate requires an isolated merchant-demo-* Compose project')

const testMode = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true'
const testDocker = process.env.DEMO_CANDIDATE_TEST_DOCKER_BINARY
const testFiles = process.env.DEMO_CANDIDATE_TEST_UNPROTECTED_FILES === 'true'
if ((testDocker || testFiles) && !testMode) fail('test overrides require NODE_ENV=test and VITEST=true')
const dockerBinary = testDocker || '/usr/bin/docker'
function protectedFile(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/')) fail(`${label} must be absolute`)
  try {
    if (realpathSync(path) !== path) fail(`${label} must be canonical`)
    const file = statSync(path)
    if (!file.isFile()) fail(`${label} must be a regular file`)
    if (!testFiles && (file.uid !== 0 || (file.mode & 0o400) === 0 || (file.mode & 0o177) !== 0)) fail(`${label} must be root-owned and readable only by root`)
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
      const info = statSync(parent)
      if (!info.isDirectory() || (!testFiles && (info.uid !== 0 || (info.mode & 0o022) !== 0))) fail(`${label} parent chain is unsafe`)
    }
  } catch (error) {
    if (error?.code) fail(`${label} is missing or inaccessible`)
    throw error
  }
}
for (const [path, label] of [[composePath, 'candidate Compose'], [envPath, 'candidate env'], [identityPath, 'candidate identity']]) protectedFile(path, label)

let compose
try { compose = JSON.parse(readFileSync(composePath, 'utf8')) } catch { fail('candidate Compose must be valid JSON') }
const identity = Object.fromEntries(readFileSync(identityPath, 'utf8').trim().split('\n').map(line => {
  const index = line.indexOf('=')
  return index < 1 ? [] : [line.slice(0, index), line.slice(index + 1)]
}))
const releaseId = identity.release_id
const gitSha = identity.git_sha
if (!/^[A-Za-z0-9._-]{1,40}$/.test(releaseId ?? '') || !/^[0-9a-f]{40}$/.test(gitSha ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.source_sha256 ?? '')) fail('candidate identity is incomplete')
const services = compose?.services ?? {}
const api = services.api
if (api?.environment?.RELEASE_ID !== releaseId || api?.environment?.RELEASE_GIT_SHA !== gitSha ||
    api?.environment?.NODE_ENV !== 'production' || api?.environment?.DEPLOYMENT_PROFILE !== 'ecs' ||
    api?.environment?.RUN_MIGRATIONS_ON_STARTUP !== 'false' || api?.environment?.CONNECTOR_FIXTURE_MODE !== 'false') fail('API does not match frozen candidate identity and production mode')
if (!/^[0-9a-f]{64}$/.test(api.environment.RELEASE_MANIFEST_SHA256 ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(api.environment.RELEASE_IMAGE_SET_DIGEST ?? '')) fail('API lacks frozen manifest and image-set identity')
if (api.environment.PLUGIN_WRITE_ENABLED !== 'false' ||
    api.environment.ASSET_STORAGE_PREFIX !== `demo-candidate/${releaseId}`) fail('candidate API must disable plugin writes and use a release-specific object prefix')
const required = ['postgres', 'redis', 'migrate', 'api']
const immutableImage = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/
for (const name of required) {
  const service = services[name]
  if (!service || typeof service !== 'object') fail(`candidate Compose lacks ${name}`)
  if (service.build || service.ports?.length || service.network_mode || service.container_name || service.privileged ||
      service.pid || service.ipc || service.devices?.length || service.cap_add?.length || service.extra_hosts?.length) fail(`${name} must use the isolated project network without host access`)
  if (name !== 'postgres' && name !== 'redis' && !immutableImage.test(service.image ?? '')) fail(`${name} image must be digest-pinned`)
  for (const mount of service.volumes ?? []) {
    const source = typeof mount === 'string' ? mount.split(':')[0] : mount.source
    const readOnly = typeof mount === 'string' ? mount.split(':').includes('ro') : mount.read_only === true
    const isBind = typeof mount === 'string' ? source.startsWith('/') : mount.type === 'bind'
    if (isBind && !readOnly) fail(`${name} has a writable host bind mount`)
  }
}
const databaseServices = ['api', 'migrate']
const runtimeRoles = new Map()
for (const name of databaseServices) {
  const env = services[name].environment ?? {}
  for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'ALERT_RECEIVER_DATABASE_URL']) {
    const value = env[key]
    if (!value) continue
    let url
    try { url = new URL(value) } catch { fail(`${name} ${key} is invalid`) }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' ||
        (url.port && url.port !== '5432')) fail(`${name} ${key} must target the isolated Compose postgres service`)
    if ((name === 'api' && key !== 'ALERT_RECEIVER_DATABASE_URL') || (name === 'migrate' && key === 'ALERT_RECEIVER_DATABASE_URL')) {
      const expectedRole = { DATABASE_URL: 'merchant_app', OPS_DATABASE_URL: 'merchant_ops', ALERT_RECEIVER_DATABASE_URL: 'merchant_alert_receiver' }[key]
      if (url.username !== expectedRole || !/^[0-9a-f]{48}$/.test(url.password) || url.pathname !== '/merchant') fail(`${key} must use a fresh isolated runtime role and database`)
      runtimeRoles.set(expectedRole, url.password)
    }
  }
  if (name === 'migrate' && env.PGHOST !== 'postgres') fail('migration PGHOST must target isolated Compose postgres')
}
if (runtimeRoles.size !== 3) fail('candidate API requires three isolated database roles')
for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL']) {
  if (services.migrate.environment?.[key] !== api.environment[key]) fail(`migration ${key} must match candidate API`)
}
if (JSON.stringify(services.migrate).includes('seed-demo')) fail('candidate migration must not seed demo data')
let redisUrl
try { redisUrl = new URL(api.environment.REDIS_URL) } catch { fail('API REDIS_URL is invalid') }
if (redisUrl.protocol !== 'redis:' || redisUrl.hostname !== 'redis' || (redisUrl.port && redisUrl.port !== '6379')) fail('API REDIS_URL must target isolated Compose redis')
for (const name of ['postgres', 'redis']) {
  const service = services[name]
  if (service.network_mode || service.container_name) fail(`${name} must use project-scoped network and name`)
  const volumes = service.volumes ?? []
  const dataTarget = name === 'postgres' ? '/var/lib/postgresql/data' : '/data'
  const dataMount = volumes.find(value => (typeof value === 'string' ? value.split(':')[1] : value.target) === dataTarget)
  const source = typeof dataMount === 'string' ? dataMount.split(':')[0] : dataMount?.source
  const volume = compose.volumes?.[source]
  if (!source || !volume || volume.external || (volume.name && !volume.name.startsWith(`${project}_`))) fail(`${name} data must use a new project-scoped named volume`)
}
if (compose.networks && Object.values(compose.networks).some(value => value?.external || (value?.name && !value.name.startsWith(`${project}_`)))) fail('candidate cannot attach to an external or shared network')
for (const [key, value] of Object.entries(compose.volumes ?? {})) {
  const name = value?.name ?? `${project}_${key}`
  if (value?.external || !name.startsWith(`${project}_`)) fail('candidate cannot use an external or shared volume')
}

function docker(args, { capture = false, input } = {}) {
  const result = spawnSync(dockerBinary, ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  // Docker may print interpolated secrets on error, so never echo its output.
  if (result.error || result.status !== 0) fail(`candidate Docker step failed: ${args[0]} ${args[1] ?? ''}`)
  return capture ? result.stdout.trim() : ''
}
const composeArgs = ['compose', '--project-name', project, '--env-file', envPath, '-f', composePath]
const existing = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], { capture: true })
if (existing) fail('candidate project already has containers; refusing to adopt or replace them')
const existingVolumes = new Set(docker(['volume', 'ls', '--format', '{{.Name}}'], { capture: true }).split('\n'))
for (const [key, value] of Object.entries(compose.volumes ?? {})) {
  const name = value?.name ?? `${project}_${key}`
  if (existingVolumes.has(name)) fail('candidate data volume already exists; refusing to adopt existing data')
}
const existingNetworks = new Set(docker(['network', 'ls', '--format', '{{.Name}}'], { capture: true }).split('\n'))
for (const [key, value] of Object.entries(compose.networks ?? { default: {} })) {
  const name = value?.name ?? `${project}_${key}`
  if (existingNetworks.has(name)) fail('candidate project network already exists; refusing to adopt existing network')
}
for (const name of required) {
  const ref = services[name].image
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', ref], { capture: true })
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) fail(`${name} image is unavailable`)
  if (name === 'api') {
    const labels = docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', ref], { capture: true })
    let value
    try { value = JSON.parse(labels) } catch { fail(`${name} image labels are invalid`) }
    if (value?.['com.storenova.release.id'] !== releaseId ||
        value?.['org.opencontainers.image.revision'] !== gitSha ||
        value?.['com.storenova.release.source_sha256'] !== identity.source_sha256) fail(`${name} image does not match candidate source`)
  }
}
docker([...composeArgs, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'postgres', 'redis'])
for (const name of ['postgres', 'redis']) {
  const id = docker([...composeArgs, 'ps', '-q', name], { capture: true })
  if (!/^[0-9a-f]{64}$/.test(id)) fail(`${name} has no unique full container ID`)
  const deadline = Date.now() + 180_000
  let status
  do {
    let container
    try { container = JSON.parse(docker(['inspect', '--type', 'container', id], { capture: true }))[0] } catch { fail(`${name} inspection failed`) }
    if (container?.Id !== id || container?.Config?.Labels?.['com.docker.compose.project'] !== project ||
        container?.Config?.Labels?.['com.docker.compose.service'] !== name || container?.State?.Running !== true ||
        Object.values(container?.HostConfig?.PortBindings ?? {}).some(value => value?.length)) fail(`${name} runtime identity or port binding is wrong`)
    status = container.State.Health?.Status
    if (status === 'healthy') break
    if (status !== 'starting') fail(`${name} is not healthy`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  } while (Date.now() < deadline)
  if (status !== 'healthy') fail(`${name} health timed out`)
}
const roleSql = [...runtimeRoles].map(([role, password]) =>
  `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`).join('\n')
docker([...composeArgs, 'exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'merchant', '-d', 'merchant'], { input: `${roleSql}\n` })
// This host's Compose CLI does not support `run --pull`; every image was
// resolved and inspected locally above, so run cannot fetch another image.
docker([...composeArgs, 'run', '--rm', '--no-deps', 'migrate'])
const appServices = required.filter(name => !['postgres', 'redis', 'migrate'].includes(name))
docker([...composeArgs, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...appServices])
for (const name of ['postgres', 'redis', ...appServices]) {
  const id = docker([...composeArgs, 'ps', '-q', name], { capture: true })
  if (!/^[0-9a-f]{64}$/.test(id)) fail(`${name} has no unique full container ID`)
  let container
  try { container = JSON.parse(docker(['inspect', '--type', 'container', id], { capture: true }))[0] } catch { fail(`${name} inspection failed`) }
  if (container?.Id !== id || container?.Config?.Labels?.['com.docker.compose.project'] !== project ||
      container?.Config?.Labels?.['com.docker.compose.service'] !== name || container?.State?.Running !== true ||
      container?.Image !== docker(['image', 'inspect', '--format', '{{.Id}}', services[name].image], { capture: true })) fail(`${name} runtime identity is wrong`)
  if (Object.values(container?.HostConfig?.PortBindings ?? {}).some(value => value?.length)) fail(`${name} unexpectedly publishes a host port`)
  if (name === 'api') {
    const deadline = Date.now() + 60_000
    let healthy = false
    while (Date.now() < deadline) {
      const check = spawnSync(dockerBinary, ['--host', 'unix:///var/run/docker.sock', 'exec', id,
        'wget', '-qO-', 'http://127.0.0.1:8787/healthz'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (check.status === 0) { healthy = true; break }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    if (!healthy) fail('candidate API healthz did not become healthy')
  } else if (container.State.Health) {
    const deadline = Date.now() + 180_000
    while (container.State.Health.Status === 'starting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      try { container = JSON.parse(docker(['inspect', '--type', 'container', id], { capture: true }))[0] } catch { fail(`${name} health inspection failed`) }
    }
    if (container.State.Health.Status !== 'healthy') fail(`${name} is not healthy`)
  }
}
console.log(JSON.stringify({ phase: 'isolated_candidate_running', project, release_id: releaseId, git_sha: gitSha }))
