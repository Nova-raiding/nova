import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { assertIsolatedMigrationChain, disposeIsolatedContainers, ISOLATED_POSTGRES_IMAGE, isolatedContainerRunArgs, isolatedFixtureSpawnEnvironment, verifyIsolatedContainer } from './isolated-ops-fixture.js'

const runId = '00000000-0000-4000-8000-000000000163'
const plan = isolatedContainerRunArgs({ runId, kind: 'postgres', image: ISOLATED_POSTGRES_IMAGE })
const owned = { id: 'a'.repeat(64), name: plan.name, runId, kind: 'postgres' as const, image: ISOLATED_POSTGRES_IMAGE }
const inspection = () => ({
  id: owned.id, name: `/${owned.name}`, image: owned.image, autoRemove: true, running: true,
  labels: { 'merchant.fixture.purpose': 'isolated-ops-oidc-acceptance', 'merchant.fixture.run-id': runId, 'merchant.fixture.kind': 'postgres' },
  mounts: [{ Type: 'tmpfs', Destination: '/var/lib/postgresql/data' }],
  tmpfs: { '/var/lib/postgresql/data': 'rw,nosuid,size=512m' },
  ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49163' }] },
})

describe('isolated Ops fixture safety boundary', () => {
  it('does not inherit database, Docker, model, shell, or node environment controls', () => {
    const poisoned = { DATABASE_URL: 'postgres://shared', OPS_DATABASE_URL: 'postgres://shared-ops', DOCKER_HOST: 'tcp://remote', DOCKER_CONTEXT: 'production', DOCKER_CONFIG: '/shared', NODE_OPTIONS: '--import /shared/hook.js', HTTP_PROXY: 'http://shared', OPENAI_API_KEY: 'existing-secret' }
    const previous = { ...process.env }
    try {
      Object.assign(process.env, poisoned)
      const environment = isolatedFixtureSpawnEnvironment({ POSTGRES_PASSWORD: 'new-fixture-only' })
      expect(environment).toEqual({ PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', POSTGRES_PASSWORD: 'new-fixture-only' })
      for (const key of Object.keys(poisoned)) expect(environment).not.toHaveProperty(key)
    } finally {
      for (const key of Object.keys(poisoned)) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
    expect(() => isolatedFixtureSpawnEnvironment({ DATABASE_URL: 'postgres://shared' })).toThrow('ISOLATED_FIXTURE_ENV_NOT_ALLOWED')
  })

  it.each(['postgres', 'redis'] as const)('plans a new, pinned, loopback-only, auto-removed %s container without a volume or copied config', kind => {
    const image = kind === 'postgres' ? ISOLATED_POSTGRES_IMAGE : `redis@sha256:${'b'.repeat(64)}`
    const planned = isolatedContainerRunArgs({ runId, kind, image })
    expect(planned.name).toBe(`merchant-ops-fixture-${kind}-${runId}`)
    expect(planned.args.slice(0, 4)).toEqual(['run', '--detach', '--rm', '--pull=never'])
    expect(planned.args).toContain(`127.0.0.1::${kind === 'postgres' ? 5432 : 6379}`)
    expect(planned.args).toContain(`merchant.fixture.run-id=${runId}`)
    expect(planned.args).toContain(image)
    for (const forbidden of ['--volume', '-v', '--mount', '--volumes-from', '--env-file', '--network=host', '--privileged']) expect(planned.args).not.toContain(forbidden)
    expect(planned.args.join(' ')).not.toContain('existing-secret')
  })

  it('rejects unpinned images and invalid run identifiers before Docker is invoked', () => {
    expect(() => isolatedContainerRunArgs({ runId, kind: 'postgres', image: 'postgres:17-alpine' })).toThrow('ISOLATED_FIXTURE_IDENTITY_INVALID')
    expect(() => isolatedContainerRunArgs({ runId: '../existing', kind: 'postgres', image: ISOLATED_POSTGRES_IMAGE })).toThrow('ISOLATED_FIXTURE_IDENTITY_INVALID')
  })

  it('accepts only exact created ID, name, run labels, loopback port, and ephemeral storage', () => {
    expect(verifyIsolatedContainer(inspection(), owned)).toMatchObject({ id: owned.id, name: owned.name, runId, hostPort: 49163, autoRemove: true, dataStorage: 'tmpfs' })
  })

  it.each([
    ['reused name with different ID', () => ({ ...inspection(), id: 'b'.repeat(64) })],
    ['renamed container', () => ({ ...inspection(), name: '/existing-business-container' })],
    ['different image', () => ({ ...inspection(), image: 'postgres:17' })],
    ['different run', () => ({ ...inspection(), labels: { ...inspection().labels, 'merchant.fixture.run-id': 'another-run' } })],
    ['different purpose', () => ({ ...inspection(), labels: { ...inspection().labels, 'merchant.fixture.purpose': 'business' } })],
    ['different service kind', () => ({ ...inspection(), labels: { ...inspection().labels, 'merchant.fixture.kind': 'redis' } })],
    ['no labels', () => ({ ...inspection(), labels: null })],
    ['persistent container', () => ({ ...inspection(), autoRemove: false })],
    ['stopped state', () => ({ ...inspection(), running: false })],
    ['shared volume', () => ({ ...inspection(), mounts: [{ Type: 'volume', Destination: '/var/lib/postgresql/data' }] })],
    ['host bind mount', () => ({ ...inspection(), mounts: [{ Type: 'bind', Destination: '/config' }] })],
    ['no tmpfs', () => ({ ...inspection(), tmpfs: null })],
    ['public binding', () => ({ ...inspection(), ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '49163' }] } })],
    ['invalid port', () => ({ ...inspection(), ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '65536' }] } })],
    ['extra binding', () => ({ ...inspection(), ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49163' }, { HostIp: '::', HostPort: '49163' }] } })],
    ['extra exposed service', () => ({ ...inspection(), ports: { ...inspection().ports, '1234/tcp': [{ HostIp: '127.0.0.1', HostPort: '49164' }] } })],
  ])('refuses cleanup for %s and never invokes stop', async (_name, altered) => {
    const stop = vi.fn(async () => undefined)
    const result = await disposeIsolatedContainers([owned], { inspect: async () => (altered as typeof inspection)(), stop })
    expect(stop).not.toHaveBeenCalled()
    expect(result.stopped).toEqual([])
    expect(result.leftRunning).toEqual([{ id: owned.id, reason: expect.stringContaining('identity verification') }])
  })

  it('stops only the fully verified exact ID and records it', async () => {
    const stop = vi.fn(async () => undefined)
    const inspect = vi.fn(async () => inspection())
    const result = await disposeIsolatedContainers([owned], { inspect, stop })
    expect(inspect).toHaveBeenCalledExactlyOnceWith(owned)
    expect(stop).toHaveBeenCalledExactlyOnceWith(owned)
    expect(result).toEqual({ stopped: [owned.id], leftRunning: [] })
  })

  it('never broadens cleanup when inspect or exact-ID stop fails', async () => {
    const stop = vi.fn(async () => { throw new Error('stop failed') })
    const missing = await disposeIsolatedContainers([owned], { inspect: async () => { throw new Error('not found') }, stop })
    expect(stop).not.toHaveBeenCalled()
    expect(missing.leftRunning).toHaveLength(1)
    const failed = await disposeIsolatedContainers([owned], { inspect: async () => inspection(), stop })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(failed.stopped).toEqual([])
    expect(failed.leftRunning).toHaveLength(1)
  })

  it('keeps the real migration/role seed and secret-free evidence path in the fixture implementation', () => {
    const source = readFileSync(new URL('./isolated-ops-fixture.ts', import.meta.url), 'utf8')
    expect(source).toContain('new MigrationRunner(admin, migrations).run()')
    expect(source).toContain("new URL('../release-metadata.json', import.meta.url)")
    expect(source).not.toMatch(/migrations\.length !== \d+/u)
    expect(source).toContain('new PostgresAuthorizationRepository(ops)')
    expect(source).toContain("new URL('../infra/local/ensure-app-role.sql', import.meta.url)")
    expect(source).not.toContain('...process.env')
    expect(source).not.toContain('.Config.Env')
    expect(source).not.toContain('docker-compose')
    expect(source).not.toContain('OPS_E2E_SOURCE_CONTAINER')
    expect(source).not.toContain("docker(['rm'")
    expect(source).not.toContain('prune')
    expect(source).toContain('adminDatabaseUrl: adminUrl.toString()')
    for (const line of source.split('\n').filter(line => line.includes('writeFile('))) {
      expect(line).not.toMatch(/adminDatabaseUrl|adminUrl|appUrl|opsUrl|postgresPassword|appPassword|opsPassword|redisPassword/u)
    }
  })

  it('binds the isolated database migration chain to release metadata instead of a stale literal', () => {
    const current = Array.from({ length: 171 }, (_, index) => ({ version: index + 1 }))
    expect(() => assertIsolatedMigrationChain(current, 171)).not.toThrow()
    expect(() => assertIsolatedMigrationChain(current, 169)).toThrow('ISOLATED_FIXTURE_MIGRATION_CHAIN_MISMATCH')
    expect(() => assertIsolatedMigrationChain(current.filter(item => item.version !== 170), 170)).toThrow('ISOLATED_FIXTURE_MIGRATION_CHAIN_MISMATCH')
    expect(() => assertIsolatedMigrationChain(current, Number.NaN)).toThrow('ISOLATED_FIXTURE_MIGRATION_CHAIN_MISMATCH')
  })
})
