#!/usr/bin/env node
// Launch a one-off API from the frozen production Compose without publishing a
// host port. The only successful stdout is the full Docker container ID.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const fail = message => { console.error(message); process.exit(1) }
const [action, composePath, envPath, project, imageRef, releaseId, stopId] = process.argv.slice(2)
if (!['start', 'stop'].includes(action)) fail('action must be start or stop')
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(project ?? '')) fail('Compose project is invalid')
if (!/^[A-Za-z0-9._-]{1,40}$/.test(releaseId ?? '')) fail('release ID is invalid')
if (!/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(imageRef ?? '')) fail('API image must be an immutable repository digest')

const testDocker = process.env.CANDIDATE_SIDECAR_TEST_DOCKER_BINARY
const testUnprotected = process.env.CANDIDATE_SIDECAR_TEST_UNPROTECTED_FILES === 'true'
if ((testDocker || testUnprotected) && (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true')) fail('candidate test overrides are test-only')
const dockerBinary = testDocker || '/usr/bin/docker'
function docker(args) {
  const result = spawnSync(dockerBinary, ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Docker/Compose may echo resolved environment values on error. Do not relay
  // their stdout/stderr into release logs.
  if (result.error || result.status !== 0) fail('candidate Docker operation failed')
  return result.stdout.trim()
}
function inspect(id) {
  let value
  try { value = JSON.parse(docker(['inspect', '--type', 'container', id]))?.[0] }
  catch { fail('candidate container inspection failed') }
  if (!value || !/^[0-9a-f]{64}$/.test(value.Id ?? '')) fail('candidate container has no full Docker ID')
  return value
}
function assertProtectedFile(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/') || realpathSync(path) !== path) fail(`${label} must be a canonical absolute path`)
  const info = statSync(path)
  if (testUnprotected) { if (!info.isFile()) fail(`${label} is not a file`); return }
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600) fail(`${label} must be root-owned mode 0600`)
  let parent = dirname(path)
  while (parent !== '/') {
    const dir = statSync(parent)
    if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o022) !== 0) fail(`${label} parent chain is not protected`)
    parent = dirname(parent)
  }
}
function assertOneOff(container, expectedImageId) {
  const labels = container.Config?.Labels ?? {}
  const name = container.Name?.replace(/^\//, '') ?? ''
  if (!name.startsWith(`merchant-candidate-api-${releaseId}-`) || labels['com.docker.compose.project'] !== project ||
      labels['com.docker.compose.service'] !== 'api' || labels['com.docker.compose.oneoff'] !== 'True' ||
      container.Image !== expectedImageId) throw new Error('container is not the reviewed one-off candidate API')
  const bindings = container.HostConfig?.PortBindings ?? {}
  if (Object.values(bindings).some(value => value !== null && value !== undefined && value.length !== 0)) throw new Error('candidate API unexpectedly publishes a host port')
}

const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', imageRef])
if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) fail('candidate image has no valid local image ID')

if (action === 'stop') {
  if (!/^[0-9a-f]{64}$/.test(stopId ?? '')) fail('stop requires the full candidate container ID')
  const container = inspect(stopId)
  if (container.Id !== stopId) fail('candidate container ID mismatch')
  try { assertOneOff(container, imageId) } catch { fail('container is not the reviewed one-off candidate API') }
  if (container.State?.Running === true) docker(['stop', '--time', '30', stopId])
  console.log(stopId)
} else {
  if (stopId !== undefined) fail('start takes no container ID')
  try { assertProtectedFile(composePath, 'rendered Compose'); assertProtectedFile(envPath, 'candidate environment') }
  catch { fail('rendered Compose and candidate environment must be protected canonical files') }
  let compose
  try { compose = JSON.parse(readFileSync(composePath, 'utf8')) }
  catch { fail('rendered Compose is invalid JSON') }
  const api = compose?.services?.api
  const environment = api?.environment ?? {}
  if (api?.image !== imageRef || environment.RELEASE_ID !== releaseId ||
      api?.pull_policy !== 'never' ||
      environment.NODE_ENV !== 'production' || environment.DEPLOYMENT_PROFILE !== 'ecs' ||
      environment.RUN_MIGRATIONS_ON_STARTUP !== 'false' ||
      environment.CONNECTOR_FIXTURE_MODE !== 'false' ||
      !environment.DATABASE_URL || !environment.OPS_DATABASE_URL) fail('candidate API does not match the frozen production configuration')
  const name = `merchant-candidate-api-${releaseId}-${randomBytes(5).toString('hex')}`
  docker(['compose', '--project-name', project, '--env-file', envPath, '-f', composePath,
    // Compose v2.27 on the ECS host has no `run --no-tty` flag. This command
    // is detached and launched over non-interactive SSH, so no TTY is allocated.
    'run', '--no-deps', '--detach', '--name', name, 'api'])
  const container = inspect(name)
  try {
    assertOneOff(container, imageId)
    if (container.State?.Running !== true) fail('candidate API did not remain running')
  } catch {
    // An unexpected container must not remain reachable. Stop the exact new
    // container; retain it for diagnosis and preserve every volume/data file.
    if (container.State?.Running === true) docker(['stop', '--time', '30', container.Id])
    fail('candidate API identity or port inspection failed')
  }
  console.log(container.Id)
}
