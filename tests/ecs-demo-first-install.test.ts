import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const entry = resolve('infra/scripts/start-ecs-demo-candidate.mjs')
const sha = 'a'.repeat(40)
const image = `example.invalid/app@sha256:${'b'.repeat(64)}`
const project = 'merchant-demo-check'
const services = ['postgres', 'redis', 'migrate', 'api']

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-demo-first-install-')))
  const composePath = join(dir, 'compose.json')
  const envPath = join(dir, 'candidate.env')
  const identityPath = join(dir, 'candidate-identity.txt')
  const marker = join(dir, 'docker-called')
  const dockerPath = join(dir, 'docker')
  writeFileSync(dockerPath, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
  writeFileSync(envPath, 'RELEASE_ID=release-check\n')
  writeFileSync(identityPath, `release_id=release-check\ngit_sha=${sha}\nsource_sha256=sha256:${'c'.repeat(64)}\n`)
  const compose: { services: Record<string, any>; volumes: Record<string, object> } = {
    services: Object.fromEntries(services.map(name => [name, { image, environment: {} }])),
    volumes: { pgdata: {}, redisdata: {} },
  }
  compose.services.api.environment = {
    RELEASE_ID: 'release-check', RELEASE_GIT_SHA: sha, NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs',
    RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false',
    RELEASE_MANIFEST_SHA256: 'd'.repeat(64), RELEASE_IMAGE_SET_DIGEST: `sha256:${'e'.repeat(64)}`,
    DATABASE_URL: `postgres://merchant_app:${'a'.repeat(48)}@postgres:5432/merchant`,
    OPS_DATABASE_URL: `postgres://merchant_ops:${'b'.repeat(48)}@postgres:5432/merchant`,
    ALERT_RECEIVER_DATABASE_URL: `postgres://merchant_alert_receiver:${'c'.repeat(48)}@postgres:5432/merchant`,
    REDIS_URL: 'redis://redis:6379', PLUGIN_WRITE_ENABLED: 'false',
    ASSET_STORAGE_PREFIX: 'demo-candidate/release-check',
  }
  compose.services.migrate.environment = {
    PGHOST: 'postgres',
    DATABASE_URL: compose.services.api.environment.DATABASE_URL,
    OPS_DATABASE_URL: compose.services.api.environment.OPS_DATABASE_URL,
    ALERT_RECEIVER_DATABASE_URL: compose.services.api.environment.ALERT_RECEIVER_DATABASE_URL,
  }
  compose.services.postgres.volumes = ['pgdata:/var/lib/postgresql/data']
  compose.services.redis.volumes = ['redisdata:/data']
  const run = (selected = project) => {
    writeFileSync(composePath, JSON.stringify(compose))
    return spawnSync('node', [entry, composePath, envPath, selected, identityPath], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test', VITEST: 'true', DEMO_CANDIDATE_TEST_UNPROTECTED_FILES: 'true',
        DEMO_CANDIDATE_TEST_DOCKER_BINARY: dockerPath,
      },
    })
  }
  return { compose, run, identityPath, marker }
}

describe('isolated ECS demo candidate first install', () => {
  it('rejects a production Compose project before invoking Docker', () => {
    const value = fixture()
    const result = value.run('merchant-production')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('isolated merchant-demo')
    expect(() => readFileSync(value.marker)).toThrow()
  })

  it('rejects an external database and shared data volume before invoking Docker', () => {
    const externalDb = fixture()
    externalDb.compose.services.api.environment.DATABASE_URL = 'postgres://user:password@prod-db.internal/merchant'
    const dbResult = externalDb.run()
    expect(dbResult.status).not.toBe(0)
    expect(dbResult.stderr).toContain('isolated Compose postgres')
    expect(() => readFileSync(externalDb.marker)).toThrow()

    const shared = fixture()
    shared.compose.services.api.environment.DATABASE_URL = `postgres://merchant_app:${'a'.repeat(48)}@postgres:5432/merchant`
    shared.compose.services.api.environment.OPS_DATABASE_URL = `postgres://merchant_ops:${'b'.repeat(48)}@postgres:5432/merchant`
    shared.compose.services.api.environment.ALERT_RECEIVER_DATABASE_URL = `postgres://merchant_alert_receiver:${'c'.repeat(48)}@postgres:5432/merchant`
    shared.compose.volumes.pgdata = { external: true }
    const volumeResult = shared.run()
    expect(volumeResult.status).not.toBe(0)
    expect(volumeResult.stderr).toContain('project-scoped named volume')
    expect(() => readFileSync(shared.marker)).toThrow()

    const otherShared = fixture()
    otherShared.compose.volumes.extra = { external: true }
    const otherResult = otherShared.run()
    expect(otherResult.status).not.toBe(0)
    expect(otherResult.stderr).toContain('external or shared volume')
    expect(() => readFileSync(otherShared.marker)).toThrow()
  })

  it('refuses published application ports before invoking Docker', () => {
    const value = fixture()
    value.compose.services.api.ports = ['80:80']
    const result = value.run()
    expect(result.status, result.stderr).not.toBe(0)
    expect(() => readFileSync(value.marker)).toThrow()
  })

  it('requires isolated Redis and disables writes to shared plugin and object storage', () => {
    for (const [field, value] of [
      ['REDIS_URL', 'redis://prod-redis.internal:6379'],
      ['PLUGIN_WRITE_ENABLED', 'true'],
      ['ASSET_STORAGE_PREFIX', 'production'],
    ] as const) {
      const fixtureValue = fixture()
      fixtureValue.compose.services.api.environment[field] = value
      const result = fixtureValue.run()
      expect(result.status, `${field}: ${result.stderr}`).not.toBe(0)
      expect(() => readFileSync(fixtureValue.marker)).toThrow()
    }
  })

  it('rejects candidate identity drift before invoking Docker', () => {
    const value = fixture()
    writeFileSync(value.identityPath, `release_id=release-check\ngit_sha=${'d'.repeat(40)}\nsource_sha256=sha256:${'c'.repeat(64)}\n`)
    const result = value.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('API does not match frozen candidate identity')
    expect(() => readFileSync(value.marker)).toThrow()
  })

  it('does not depend on old runtime readiness, rollback, or public cutover commands', () => {
    const source = readFileSync(entry, 'utf8')
    expect(source).not.toContain('/readyz')
    expect(source).not.toContain('rollback-ecs-compose')
    expect(source).not.toContain("docker(['stop'")
    expect(source).not.toContain("docker(['rm'")
    expect(source).toContain("const appServices = required.filter")
    expect(source).toContain("const required = ['postgres', 'redis', 'migrate', 'api']")
    expect(source).toContain("'run', '--rm', '--no-deps', 'migrate'")
  })
})
