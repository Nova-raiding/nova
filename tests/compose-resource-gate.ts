import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

type ComposeService = {
  image?: string
  dns?: string[]
  environment?: Record<string, string | null> | string[]
  healthcheck?: { test?: string[] }
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string }; reservations?: { cpus?: string; memory?: string } } }
}

type ComposeConfig = { services?: Record<string, ComposeService> }

const composeFile = 'infra/local/docker-compose.yml'

function dockerComposeConfig(): ComposeConfig {
  const output = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--format', 'json'], { encoding: 'utf8' })
  return JSON.parse(output) as ComposeConfig
}

function environment(service: ComposeService): Record<string, string> {
  if (!service.environment) return {}
  if (!Array.isArray(service.environment)) return Object.fromEntries(Object.entries(service.environment).map(([key, value]) => [key, value ?? '']))
  return Object.fromEntries(service.environment.map(item => {
    const separator = item.indexOf('=')
    return separator === -1 ? [item, ''] : [item.slice(0, separator), item.slice(separator + 1)]
  }))
}

function assertResources(name: string, service: ComposeService, cpu: string, memory: string) {
  assert.equal(Number(service.deploy?.resources?.limits?.cpus), Number(cpu), `${name} CPU limit must be explicit`)
  assert.equal(memoryBytes(service.deploy?.resources?.limits?.memory), memoryBytes(memory), `${name} memory limit must be explicit`)
  assert.ok(service.deploy?.resources?.reservations?.cpus, `${name} CPU reservation must be explicit`)
  assert.ok(service.deploy?.resources?.reservations?.memory, `${name} memory reservation must be explicit`)
}

function memoryBytes(value: string | undefined): number {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$/i)
  if (!match) return 0
  const multiplier = { '': 1, b: 1, k: 1024, kb: 1024, ki: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mi: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gi: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, ti: 1024 ** 4, tib: 1024 ** 4 } as Record<string, number>
  return Number(match[1]) * (multiplier[match[2]?.toLowerCase() ?? ''] ?? 0)
}

const config = dockerComposeConfig()
const services = config.services ?? {}
const workerServices = ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation']
for (const name of ['api', ...workerServices, 'postgres', 'redis']) assert.ok(services[name], `Compose service ${name} is required`)

assertResources('api', services.api!, '2.0', '4G')
for (const name of workerServices) assertResources(name, services[name]!, '2.0', '4G')
assertResources('postgres', services.postgres!, '4.0', '4G')
assertResources('redis', services.redis!, '1.0', '4G')

const apiEnv = environment(services.api!)
assert.deepEqual(services.api!.dns, ['1.1.1.1', '8.8.8.8'], 'API must have explicit external DNS fallbacks')
assert.equal(apiEnv.NODE_ENV, 'production')
assert.equal(apiEnv.CONNECTOR_FIXTURE_MODE, 'false')
assert.equal(apiEnv.PLUGIN_WRITE_ENABLED, 'false')
assert.ok(apiEnv.DATABASE_URL?.startsWith('postgres://'), 'API must use PostgreSQL in Compose')
assert.ok(apiEnv.REDIS_URL?.startsWith('redis://'), 'API must use Redis in Compose')
assert.equal(apiEnv.DB_POOL_MAX, '20')
assert.equal(apiEnv.MAX_ACTIVE_JOBS_PER_WORKSPACE, '3')
assert.equal(apiEnv.REQUEST_BODY_LIMIT_BYTES, '52428800')
assert.ok(apiEnv.WORKER_API_TOKEN, 'API must expose a separately injected worker callback token')

for (const [index, name] of workerServices.entries()) {
  const workerEnv = environment(services[name]!)
  assert.deepEqual(services[name]!.dns, ['1.1.1.1', '8.8.8.8'], `${name} must have explicit external DNS fallbacks`)
  assert.equal(workerEnv.NODE_ENV, 'production')
  assert.equal(workerEnv.WORKER_ROLE, name.replace('worker-', ''))
  assert.equal(workerEnv.WORKER_WORKSPACES, 'auto')
  assert.equal(workerEnv.WORKER_DB_POOL_MAX, '5')
  assert.equal(workerEnv.WORKER_POLL_INTERVAL_MS, '500')
  assert.equal(workerEnv.WORKER_BATCH_SIZE, '100')
  assert.equal(workerEnv.WORKER_WORKSPACE_BATCH_SIZE, '10')
  assert.equal(workerEnv.WORKER_LEASE_MS, '30000')
  assert.ok(workerEnv.DATABASE_URL?.startsWith('postgres://'), `Worker ${index} must use PostgreSQL`)
  assert.ok(workerEnv.REDIS_URL?.startsWith('redis://'), `Worker ${index} must use Redis`)
}

assert.equal(services.postgres!.image, 'postgres:16-alpine')
assert.equal(services.redis!.image, 'redis:7-alpine')
assert.ok(services.postgres!.healthcheck?.test?.some(value => value.includes('pg_isready')), 'Postgres healthcheck is required')
assert.ok(services.redis!.healthcheck?.test?.some(value => value.includes('redis-cli')), 'Redis healthcheck is required')
for (const name of workerServices) assert.ok(services[name]!.healthcheck?.test?.some(value => value.includes('WORKER_ROLE')), `${name} readiness healthcheck is required`)

console.log(JSON.stringify({
  profile: 'compose_resource_gate',
  localOnly: true,
  cloudGate: false,
  services: ['api', ...workerServices, 'postgres', 'redis'],
  resources: {
    api: { cpus: 2, memory: '4G' },
    workers: Object.fromEntries(workerServices.filter(name => name !== 'worker-automation').map(name => [name, { cpus: 2, memory: '4G' }])),
    postgres: { cpus: 4, memory: '4G' },
    redis: { cpus: 1, memory: '4G' },
  },
  status: 'pass',
}))
