import { execFileSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

export const LOCAL_RUNTIME_TEST_FILES = [
  'tests/local-docker-runtime-contract.test.ts',
  'tests/local-docker-fault-acceptance.test.ts',
  'tests/local-docker-release-gate.test.ts',
  'tests/local-creative-points-seed-runtime.test.ts',
] as const

export type LocalRuntimeTestConfig = {
  runId: string; project: string; workspaceId: string; apiBaseUrl: string; apiToken: string; composeFile: string; envFile: string
}
export type RuntimeContainerInspection = {
  Id: string; Config: { Labels: Record<string, string>; Env: string[] }
  HostConfig: { NetworkMode: string; Privileged: boolean; Devices: unknown[] | null; DeviceRequests: unknown[] | null }
  Mounts: Array<{ Type: string; Name?: string; RW: boolean }>
  NetworkSettings: { Networks: Record<string, unknown>; Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> }
}
export type RuntimeVolumeInspection = { Name: string; Labels: Record<string, string>; Driver: string; Options: Record<string, string> | null }
export type RuntimeDockerProbe = (args: string[]) => string
export type LocalRuntimeTestContext = LocalRuntimeTestConfig & { dockerArgs: string[]; composeArgs: string[]; assertIsolated: () => void }

const fail = (code: 'CONFIG_REQUIRED' | 'CONFIG_INVALID' | 'TARGET_UNSAFE'): never => {
  // Never echo Compose output, environment values, URLs or credentials.
  throw new Error(`LOCAL_RUNTIME_TEST_${code}: explicit isolated runtime evidence is required; shared local/production targets are forbidden`)
}

export function readLocalRuntimeTestConfig(env: NodeJS.ProcessEnv = process.env): LocalRuntimeTestConfig {
  const required = (name: string) => env[name]?.trim() || fail('CONFIG_REQUIRED')
  const config = {
    runId: required('LOCAL_RUNTIME_TEST_RUN_ID'), project: required('LOCAL_RUNTIME_TEST_PROJECT'),
    workspaceId: required('LOCAL_RUNTIME_TEST_WORKSPACE_ID'), apiBaseUrl: required('LOCAL_RUNTIME_TEST_API_URL'),
    apiToken: required('LOCAL_RUNTIME_TEST_API_TOKEN'), composeFile: required('LOCAL_RUNTIME_TEST_COMPOSE_FILE'), envFile: required('LOCAL_RUNTIME_TEST_ENV_FILE'),
  }
  if (!/^[a-z0-9][a-z0-9-]{5,47}$/u.test(config.runId)
    || config.project !== `merchant-runtime-${config.runId}`
    || config.workspaceId !== `ws_runtime_${config.runId.replaceAll('-', '_')}`
    || /[\r\n\u0000]/u.test(config.apiToken)) fail('CONFIG_INVALID')
  const root = resolve(import.meta.dirname, '..')
  if (![config.composeFile, config.envFile].every(path => isAbsolute(path) && path === resolve(path) && !/[\r\n\u0000,]/u.test(path))
    || config.composeFile === resolve(root, 'infra/local/docker-compose.yml') || config.envFile === resolve(root, '.env')) fail('CONFIG_INVALID')
  try {
    const url = new URL(config.apiBaseUrl)
    const port = Number(url.port)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !Number.isSafeInteger(port) || port < 1024 || port > 65535
      || [8787, 8788, 18081, 18082, 54329, 6379].includes(port)) fail('CONFIG_INVALID')
    config.apiBaseUrl = url.origin
  } catch { fail('CONFIG_INVALID') }
  return config
}

function labelsMatch(config: LocalRuntimeTestConfig, labels: Record<string, string> | undefined) {
  return labels?.['com.docker.compose.project'] === config.project && labels['merchant.test.isolated'] === 'true'
    && labels['merchant.test.run_id'] === config.runId && labels['merchant.test.workspace_id'] === config.workspaceId
}

function internalDependency(value: string | undefined, host: string, port: string, protocol: string) {
  if (!value) return false
  try { const url = new URL(value); return url.protocol === protocol && url.hostname === host && (!url.port || url.port === port) && !url.search && !url.hash } catch { return false }
}

export function validateLocalRuntimeTarget(config: LocalRuntimeTestConfig, containers: RuntimeContainerInspection[], volumes: RuntimeVolumeInspection[]): void {
  try {
    if (!Array.isArray(containers) || !containers.length || !Array.isArray(volumes)) fail('TARGET_UNSAFE')
    const services = new Set<string>()
    const ids = new Set<string>()
    for (const container of containers) {
      const labels = container.Config?.Labels
      const service = labels?.['com.docker.compose.service'] ?? ''
      if (!/^[a-z][a-z0-9-]*$/u.test(service) || !/^[a-f0-9]{12,64}$/u.test(container.Id) || ids.has(container.Id)
        || !labelsMatch(config, labels) || labels['com.docker.compose.project.config_files'] !== config.composeFile) fail('TARGET_UNSAFE')
      ids.add(container.Id)
      services.add(service)
      if (!container.HostConfig?.NetworkMode?.startsWith(`${config.project}_`)
        || !Object.keys(container.NetworkSettings?.Networks ?? {}).length
        || Object.keys(container.NetworkSettings.Networks).some(name => !name.startsWith(`${config.project}_`))) fail('TARGET_UNSAFE')
      if (container.HostConfig.Privileged !== false
        || [container.HostConfig.Devices, container.HostConfig.DeviceRequests].some(devices => devices !== null && (!Array.isArray(devices) || devices.length !== 0))) fail('TARGET_UNSAFE')
      // Every published service is part of the isolation boundary, not only
      // the API URL used by this test. Unpublished internal ports stay valid.
      for (const bindings of Object.values(container.NetworkSettings.Ports ?? {})) {
        if (bindings === null) continue
        if (!Array.isArray(bindings) || bindings.length === 0 || bindings.some(binding => binding.HostIp !== '127.0.0.1'
          || !/^\d+$/u.test(binding.HostPort) || Number(binding.HostPort) < 1 || Number(binding.HostPort) > 65535)) fail('TARGET_UNSAFE')
      }
      if (!Array.isArray(container.Mounts)) fail('TARGET_UNSAFE')
      for (const mount of container.Mounts) {
        // Read-only binds can expose host secrets or a writable daemon API
        // through a socket. Isolated Compose fixtures must build/copy source
        // and configuration into their images, never mount host paths.
        if (mount.Type === 'bind') fail('TARGET_UNSAFE')
        if (mount.Type === 'volume' && (!mount.Name?.startsWith(`${config.project}_`) || !volumes.some(volume => volume.Name === mount.Name && labelsMatch(config, volume.Labels)
          && volume.Driver === 'local' && (volume.Options === null || Object.keys(volume.Options ?? {}).length === 0)))) fail('TARGET_UNSAFE')
        if (!['volume', 'tmpfs'].includes(mount.Type)) fail('TARGET_UNSAFE')
      }
      if (!Array.isArray(container.Config.Env)) fail('TARGET_UNSAFE')
      const environment = Object.fromEntries(container.Config.Env.map(entry => {
        const separator = entry.indexOf('=')
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      }))
      // An isolated container connected to a shared DB/Redis is not isolated.
      if (service === 'api' || service === 'api-replica' || service.startsWith('worker-') || service === 'migrate') {
        if (!internalDependency(environment.DATABASE_URL, 'postgres', '5432', 'postgres:')
          || environment.OPS_DATABASE_URL && !internalDependency(environment.OPS_DATABASE_URL, 'postgres', '5432', 'postgres:')
          || service !== 'migrate' && !internalDependency(environment.REDIS_URL, 'redis', '6379', 'redis:')) fail('TARGET_UNSAFE')
      }
      if (service.startsWith('worker-') && (environment.WORKER_WORKSPACES !== config.workspaceId || environment.WORKER_AUTO_DISCOVER === 'true'
        || environment.WORKER_API_BASE_URL !== 'http://api:8787')) fail('TARGET_UNSAFE')
      if (service === 'worker-scan' && (environment.CLAMAV_HOST !== 'clamav' || environment.CLAMAV_PORT !== '3310')) fail('TARGET_UNSAFE')
      if (Object.entries(environment).some(([key, value]) => value.trim() && /(?:MODEL_RELAY_API_KEY|VIDEO_MODEL_RELAY_API_KEY|OPENAI_API_KEY|DASHSCOPE_API_KEY)$/u.test(key))) fail('TARGET_UNSAFE')
      if (service === 'api' || service === 'api-replica') {
        if (!['test', 'development'].includes(environment.NODE_ENV ?? '') || environment.ALLOW_WILDCARD_WORKSPACE_GRANT === 'true') fail('TARGET_UNSAFE')
        const tokens = JSON.parse(environment.API_AUTH_TOKENS ?? '{}') as Record<string, { workspaces?: string[] }>
        const workspaces = tokens[config.apiToken]?.workspaces
        if (!Array.isArray(workspaces) || workspaces.length !== 1 || workspaces[0] !== config.workspaceId) fail('TARGET_UNSAFE')
      }
      if (service === 'api') {
        const bindings = container.NetworkSettings.Ports['8787/tcp']
        if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1'
          || bindings[0]?.HostPort !== new URL(config.apiBaseUrl).port) fail('TARGET_UNSAFE')
      }
    }
    if (!['api', 'postgres', 'redis'].every(service => services.has(service))) fail('TARGET_UNSAFE')
  } catch { return fail('TARGET_UNSAFE') }
}

const dockerProbe: RuntimeDockerProbe = args => {
  try {
    return execFileSync('docker', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }).trim()
  } catch { return fail('TARGET_UNSAFE') }
}

export function requireIsolatedLocalRuntime(env: NodeJS.ProcessEnv = process.env, probe: RuntimeDockerProbe = dockerProbe): LocalRuntimeTestContext {
  // Configuration is checked before even a read-only Docker probe, so a direct
  // invocation without isolation cannot reach HTTP writes or container control.
  const config = readLocalRuntimeTestConfig(env)
  const composeArgs = ['compose', '--env-file', config.envFile, '-p', config.project, '-f', config.composeFile]
  let dockerHost: string
  try {
    // A remote Docker daemon's loopback port does not attest this machine's
    // loopback HTTP target. Resolve once and pin all subsequent commands.
    dockerHost = env.DOCKER_HOST && !env.DOCKER_CONTEXT ? env.DOCKER_HOST
      : JSON.parse(probe(['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}'])) as string
    const endpoint = new URL(dockerHost)
    if (endpoint.protocol !== 'unix:' || endpoint.hostname || !isAbsolute(endpoint.pathname) || endpoint.search || endpoint.hash) fail('TARGET_UNSAFE')
  } catch { return fail('TARGET_UNSAFE') }
  const dockerArgs = ['--host', dockerHost]
  const targetProbe = (args: string[]) => probe([...dockerArgs, ...args])
  const assertIsolated = () => {
    try {
      const ids = targetProbe([...composeArgs, 'ps', '--all', '--quiet']).split(/\s+/u).filter(Boolean)
      if (!ids.length || ids.some(id => !/^[a-f0-9]{12,64}$/u.test(id)) || new Set(ids).size !== ids.length) fail('TARGET_UNSAFE')
      // Env is inspected only in memory to reject external dependencies/tokens;
      // neither this result nor a subprocess error is included in evidence.
      const format = '{"Id":{{json .Id}},"Config":{"Labels":{{json .Config.Labels}},"Env":{{json .Config.Env}}},"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}},"Privileged":{{json .HostConfig.Privileged}},"Devices":{{json .HostConfig.Devices}},"DeviceRequests":{{json .HostConfig.DeviceRequests}}},"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}},"Ports":{{json .NetworkSettings.Ports}}}}'
      const containers = targetProbe(['inspect', '--format', format, ...ids]).split('\n').filter(Boolean).map(line => JSON.parse(line) as RuntimeContainerInspection)
      if (containers.length !== ids.length || containers.some(container => !ids.includes(container.Id))) fail('TARGET_UNSAFE')
      const volumeNames = [...new Set(containers.flatMap(container => container.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name ?? '')))]
      if (volumeNames.some(name => !name.startsWith(`${config.project}_`))) fail('TARGET_UNSAFE')
      const volumes = volumeNames.length
        ? targetProbe(['volume', 'inspect', '--format', '{"Name":{{json .Name}},"Labels":{{json .Labels}},"Driver":{{json .Driver}},"Options":{{json .Options}}}', ...volumeNames]).split('\n').filter(Boolean).map(line => JSON.parse(line) as RuntimeVolumeInspection)
        : []
      validateLocalRuntimeTarget(config, containers, volumes)
    } catch { fail('TARGET_UNSAFE') }
  }
  assertIsolated()
  return { ...config, dockerArgs, composeArgs, assertIsolated }
}
