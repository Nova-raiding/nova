import { describe, expect, it, vi } from 'vitest'
import { readLocalRuntimeTestConfig, requireIsolatedLocalRuntime, validateLocalRuntimeTarget, type RuntimeContainerInspection, type RuntimeVolumeInspection } from './local-runtime-test-safety.js'

const env = () => ({
  LOCAL_RUNTIME_TEST_RUN_ID: 'run-20260907-a1',
  LOCAL_RUNTIME_TEST_PROJECT: 'merchant-runtime-run-20260907-a1',
  LOCAL_RUNTIME_TEST_WORKSPACE_ID: 'ws_runtime_run_20260907_a1',
  LOCAL_RUNTIME_TEST_API_URL: 'http://127.0.0.1:28787',
  LOCAL_RUNTIME_TEST_API_TOKEN: 'isolated-runtime-test-token',
  LOCAL_RUNTIME_TEST_COMPOSE_FILE: '/tmp/merchant-runtime-run-20260907-a1/compose.yml',
  LOCAL_RUNTIME_TEST_ENV_FILE: '/tmp/merchant-runtime-run-20260907-a1/runtime.env',
})

function fixture() {
  const config = readLocalRuntimeTestConfig(env())
  const labels = {
    'com.docker.compose.project': config.project,
    'com.docker.compose.project.config_files': config.composeFile,
    'merchant.test.isolated': 'true', 'merchant.test.run_id': config.runId, 'merchant.test.workspace_id': config.workspaceId,
  }
  const containers = ['api', 'postgres', 'redis', 'worker-scan'].map<RuntimeContainerInspection>((service, index) => ({
    Id: String(index + 1).repeat(64),
    Config: { Labels: { ...labels, 'com.docker.compose.service': service }, Env: service === 'api' ? [
      'NODE_ENV=test', 'DATABASE_URL=postgres://test:test@postgres:5432/merchant', 'REDIS_URL=redis://redis:6379',
      `API_AUTH_TOKENS=${JSON.stringify({ [config.apiToken]: { workspaces: [config.workspaceId] } })}`,
    ] : service.startsWith('worker-') ? ['DATABASE_URL=postgres://test:test@postgres:5432/merchant', 'REDIS_URL=redis://redis:6379', `WORKER_WORKSPACES=${config.workspaceId}`, 'WORKER_API_BASE_URL=http://api:8787', 'CLAMAV_HOST=clamav', 'CLAMAV_PORT=3310'] : [] },
    HostConfig: { NetworkMode: `${config.project}_default`, Privileged: false, Devices: [], DeviceRequests: null },
    Mounts: service === 'postgres' ? [{ Type: 'volume', Name: `${config.project}_postgres`, RW: true }] : [],
    NetworkSettings: { Networks: { [`${config.project}_default`]: {} }, Ports: { '8787/tcp': service === 'api' ? [{ HostIp: '127.0.0.1', HostPort: '28787' }] : null } },
  }))
  const volumes: RuntimeVolumeInspection[] = [{ Name: `${config.project}_postgres`, Labels: labels, Driver: 'local', Options: null }]
  return { config, containers, volumes }
}

describe('local runtime test isolation guard (mock Docker evidence only)', () => {
  it('accepts only a fully explicit, consistently bound isolated target', () => {
    const { config, containers, volumes } = fixture()
    expect(config.workspaceId).not.toBe('ws_demo')
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).not.toThrow()
  })

  it.each(Object.keys(env()))('requires %s before any Docker probe', key => {
    const input: NodeJS.ProcessEnv = env()
    delete input[key]
    const probe = vi.fn()
    expect(() => requireIsolatedLocalRuntime(input, probe)).toThrow(/LOCAL_RUNTIME_TEST_CONFIG_REQUIRED/u)
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    { LOCAL_RUNTIME_TEST_PROJECT: 'local' }, { LOCAL_RUNTIME_TEST_PROJECT: 'merchant-runtime-other-run' },
    { LOCAL_RUNTIME_TEST_WORKSPACE_ID: 'ws_demo' }, { LOCAL_RUNTIME_TEST_WORKSPACE_ID: "ws_runtime_a'; DROP TABLE x;--" },
    { LOCAL_RUNTIME_TEST_API_URL: 'http://127.0.0.1:8787' }, { LOCAL_RUNTIME_TEST_API_URL: 'https://production.example:28787' },
    { LOCAL_RUNTIME_TEST_API_URL: 'http://user:secret@127.0.0.1:28787' }, { LOCAL_RUNTIME_TEST_API_URL: 'http://127.0.0.1:28787/path' },
    { LOCAL_RUNTIME_TEST_COMPOSE_FILE: 'infra/local/docker-compose.yml' }, { LOCAL_RUNTIME_TEST_ENV_FILE: '.env' },
  ])('rejects shared, malformed or remotely routed configuration: %j', override => {
    const probe = vi.fn()
    expect(() => requireIsolatedLocalRuntime({ ...env(), ...override }, probe)).toThrow(/LOCAL_RUNTIME_TEST_CONFIG_INVALID/u)
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not treat a confirmation boolean as isolation proof', () => {
    const probe = vi.fn()
    expect(() => requireIsolatedLocalRuntime({ CONFIRM: 'true', LOCAL_RUNTIME_TEST_CONFIRM: 'true' }, probe)).toThrow(/LOCAL_RUNTIME_TEST_CONFIG_REQUIRED/u)
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    ['Redis', 2, '6379/tcp', '0.0.0.0'],
    ['PostgreSQL', 1, '5432/tcp', '::'],
    ['worker diagnostics', 3, '9090/tcp', '192.0.2.10'],
    ['additional API listener', 0, '9090/tcp', '0.0.0.0'],
  ] as const)('rejects a non-loopback published %s port', (_service, index, port, address) => {
    const { config, containers, volumes } = fixture()
    containers[index]!.NetworkSettings.Ports[port] = [{ HostIp: address, HostPort: '26379' }]
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
  })

  it.each(['Privileged', 'Devices', 'DeviceRequests'])('fails closed when %s device-isolation evidence is missing', key => {
    const { config, containers, volumes } = fixture()
    Reflect.deleteProperty(containers[0]!.HostConfig, key)
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
  })

  it.each(['0', '65536', 'not-a-port', ''])('rejects malformed dependency port evidence: %s', port => {
    const { config, containers, volumes } = fixture()
    containers[2]!.NetworkSettings.Ports['6379/tcp'] = [{ HostIp: '127.0.0.1', HostPort: port }]
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
  })

  it.each([
    ['/var/run/docker.sock', '/var/run/docker.sock'],
    ['/run/containerd/containerd.sock', '/run/containerd/containerd.sock'],
    ['/dev/sda', '/dev/fixture-device'],
    ['/shared/business/.env', '/run/config.env'],
    ['/isolated/source', '/app/source'],
  ])('rejects every read-only host bind, including %s', (source, destination) => {
    const { config, containers, volumes } = fixture()
    containers[0]!.Mounts.push(Object.assign({ Type: 'bind', RW: false }, { Source: source, Destination: destination }))
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
  })

  it('retains private labeled volumes, tmpfs, and explicit loopback dependency ports', () => {
    const { config, containers, volumes } = fixture()
    containers[1]!.NetworkSettings.Ports['5432/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '25432' }]
    containers[2]!.NetworkSettings.Ports['6379/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '26379' }]
    containers[2]!.Mounts.push({ Type: 'tmpfs', RW: true })
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).not.toThrow()
  })

  it.each([
    { Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/fixture-device', CgroupPermissions: 'r' }] },
    { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] },
    { Privileged: true },
  ])('rejects native host-device exposure even without a bind mount: %j', exposed => {
    const { config, containers, volumes } = fixture()
    Object.assign(containers[0]!.HostConfig, exposed)
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
  })

  it.each(['project', 'run', 'workspace', 'isolated', 'compose source', 'API port', 'public bind', 'host network', 'shared network', 'RW host bind', 'shared volume', 'volume labels', 'bind-backed volume', 'NFS volume', 'external database', 'DB query override', 'OPS DB query override', 'external Redis', 'worker wildcard', 'worker auto-discovery', 'worker shared API', 'external ClamAV', 'token wildcard', 'production API', 'provider key'] as const)('rejects unsafe inspected evidence: %s', failure => {
    const { config, containers, volumes } = fixture()
    const api = containers[0]!
    if (failure === 'project') api.Config.Labels['com.docker.compose.project'] = 'local'
    if (failure === 'run') api.Config.Labels['merchant.test.run_id'] = 'other-run'
    if (failure === 'workspace') api.Config.Labels['merchant.test.workspace_id'] = 'ws_demo'
    if (failure === 'isolated') delete api.Config.Labels['merchant.test.isolated']
    if (failure === 'compose source') api.Config.Labels['com.docker.compose.project.config_files'] = '/shared/compose.yml'
    if (failure === 'API port') api.NetworkSettings.Ports['8787/tcp']![0]!.HostPort = '8787'
    if (failure === 'public bind') api.NetworkSettings.Ports['8787/tcp']![0]!.HostIp = '0.0.0.0'
    if (failure === 'host network') api.HostConfig.NetworkMode = 'host'
    if (failure === 'shared network') api.NetworkSettings.Networks = { local_default: {} }
    if (failure === 'RW host bind') api.Mounts.push({ Type: 'bind', RW: true })
    if (failure === 'shared volume') containers[1]!.Mounts[0]!.Name = 'local_merchant-postgres'
    if (failure === 'volume labels') volumes[0]!.Labels = { 'com.docker.compose.project': 'local' }
    if (failure === 'bind-backed volume') volumes[0]!.Options = { type: 'none', o: 'bind', device: '/shared/postgres' }
    if (failure === 'NFS volume') volumes[0]!.Driver = 'nfs'
    if (failure === 'external database') api.Config.Env.push('DATABASE_URL=postgres://private:secret@shared-db:5432/merchant')
    if (failure === 'DB query override') api.Config.Env.push('DATABASE_URL=postgres://test:test@postgres:5432/merchant?host=host.docker.internal&port=54329')
    if (failure === 'OPS DB query override') api.Config.Env.push('OPS_DATABASE_URL=postgres://test:test@postgres:5432/merchant?host=shared-db')
    if (failure === 'external Redis') api.Config.Env.push('REDIS_URL=redis://shared-redis:6379')
    if (failure === 'worker wildcard') containers[3]!.Config.Env.push('WORKER_WORKSPACES=auto')
    if (failure === 'worker auto-discovery') containers[3]!.Config.Env.push('WORKER_AUTO_DISCOVER=true')
    if (failure === 'worker shared API') containers[3]!.Config.Env.push('WORKER_API_BASE_URL=http://host.docker.internal:8787')
    if (failure === 'external ClamAV') containers[3]!.Config.Env.push('CLAMAV_HOST=shared-clamav')
    if (failure === 'token wildcard') api.Config.Env.push(`API_AUTH_TOKENS=${JSON.stringify({ [config.apiToken]: { workspaces: ['*'] } })}`)
    if (failure === 'production API') api.Config.Env.push('NODE_ENV=production')
    if (failure === 'provider key') api.Config.Env.push('MODEL_RELAY_API_KEY=secret-provider-key')
    expect(() => validateLocalRuntimeTarget(config, containers, volumes)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
  })

  it('fails closed on missing or malformed Docker evidence without echoing credentials', () => {
    for (const output of ['', 'not-json-secret-provider-key']) {
      const probe = vi.fn((args: string[]) => args[0] === 'context' ? JSON.stringify('unix:///tmp/isolated-docker.sock') : args[2] === 'compose' ? 'a'.repeat(64) : output)
      let message = ''
      try { requireIsolatedLocalRuntime(env(), probe) } catch (error) { message = (error as Error).message }
      expect(message).toMatch(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
      expect(message).not.toContain('secret-provider-key')
    }
  })

  it('attests Docker labels/ports/volumes and re-checks them immediately before a mutation', () => {
    const { config, containers, volumes } = fixture()
    const probe = vi.fn((args: string[]) => {
      if (args[0] === 'context') return JSON.stringify('unix:///tmp/isolated-docker.sock')
      expect(args.slice(0, 2)).toEqual(['--host', 'unix:///tmp/isolated-docker.sock'])
      if (args[2] === 'compose') return containers.map(container => container.Id).join('\n')
      if (args[2] === 'inspect') return containers.map(container => JSON.stringify(container)).join('\n')
      if (args[2] === 'volume') return volumes.map(volume => JSON.stringify(volume)).join('\n')
      throw new Error('unexpected Docker command')
    })
    const runtime = requireIsolatedLocalRuntime(env(), probe)
    expect(runtime.composeArgs).toEqual(['compose', '--env-file', config.envFile, '-p', config.project, '-f', config.composeFile])
    expect(runtime.dockerArgs).toEqual(['--host', 'unix:///tmp/isolated-docker.sock'])
    expect(probe.mock.calls.map(([args]) => args[0] === 'context' ? 'context' : args[2])).toEqual(['context', 'compose', 'inspect', 'volume'])
    expect(probe.mock.calls[1]![0].slice(-3)).toEqual(['ps', '--all', '--quiet'])
    containers[0]!.Config.Labels['merchant.test.run_id'] = 'replacement-container'
    const write = vi.fn()
    expect(() => { runtime.assertIsolated(); write() }).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects subprocess failures without copying stdout/stderr or secrets', () => {
    const probe = vi.fn(() => { throw new Error('Docker failed: api-token=private-secret') })
    expect(() => requireIsolatedLocalRuntime(env(), probe)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
    try { requireIsolatedLocalRuntime(env(), probe) } catch (error) { expect((error as Error).message).not.toContain('private-secret') }
  })

  it.each(['ssh://remote-host', 'tcp://127.0.0.1:2375', 'tcp://production:2376'])('rejects a remote or unproven Docker endpoint before inspecting containers: %s', endpoint => {
    const probe = vi.fn((_args: string[]) => JSON.stringify(endpoint))
    expect(() => requireIsolatedLocalRuntime(env(), probe)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]![0][0]).toBe('context')
    probe.mockClear()
    expect(() => requireIsolatedLocalRuntime({ ...env(), DOCKER_HOST: endpoint }, probe)).toThrow(/LOCAL_RUNTIME_TEST_TARGET_UNSAFE/u)
    expect(probe).not.toHaveBeenCalled()
  })
})
