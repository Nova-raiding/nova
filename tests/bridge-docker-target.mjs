// Docker client policy shared by review-only Bridge 254 smoke tests.
// Pin the daemon to a discovered local Unix socket and never load user contexts.
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const SOCKETS = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock'), join(homedir(), '.colima/default/docker.sock'), join(homedir(), '.orbstack/run/docker.sock')]
const OVERRIDES = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']

export function assertBridgeDockerEnvironment(environment = process.env) {
  if (OVERRIDES.some(name => typeof environment[name] === 'string' && environment[name].trim() !== '')) {
    throw new Error('BRIDGE_REVIEW_DOCKER_OVERRIDE_FORBIDDEN')
  }
}

export async function discoverBridgeDockerSocket({ environment = process.env, candidates = SOCKETS, inspect = stat } = {}) {
  assertBridgeDockerEnvironment(environment)
  const found = []
  for (const path of candidates) {
    try { if ((await inspect(path)).isSocket()) found.push(path) } catch { /* candidate not present or not a socket */ }
  }
  if (found.length !== 1) throw new Error('BRIDGE_REVIEW_LOCAL_DOCKER_SOCKET_AMBIGUOUS_OR_MISSING')
  return found[0]
}

export function bridgeDockerInvocation(socket, configPath) {
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.includes('\0')
    || typeof configPath !== 'string' || !configPath.startsWith('/') || configPath.includes('\0')) {
    throw new Error('BRIDGE_REVIEW_DOCKER_TARGET_INVALID')
  }
  return {
    args: ['--host', `unix://${socket}`, '--config', configPath],
    environment: { PATH, LANG: 'C.UTF-8' },
  }
}

export async function createBridgeDockerClient({ environment = process.env, directory = tmpdir(), candidates = SOCKETS, inspect = stat } = {}) {
  const socket = await discoverBridgeDockerSocket({ environment, candidates, inspect })
  const configPath = await mkdtemp(join(directory, 'bridge-docker-config-'))
  await chmod(configPath, 0o700)
  // Ensure a newly-created, empty Docker configuration. It cannot select a
  // user context, registry credential helper, or remote endpoint.
  if ((await readdir(configPath)).length !== 0) {
    await rm(configPath, { recursive: true, force: true })
    throw new Error('BRIDGE_REVIEW_DOCKER_CONFIG_NOT_EMPTY')
  }
  const invocation = bridgeDockerInvocation(socket, configPath)
  return {
    socket,
    configPath,
    args: invocation.args,
    environment: invocation.environment,
    async dispose() { await rm(configPath, { recursive: true, force: true }) },
  }
}
