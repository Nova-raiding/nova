import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

type ComposeService = {
  image?: string
  platform?: string
  dns?: string[]
  environment?: Record<string, string | null> | string[]
  healthcheck?: { test?: string[] }
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string }; reservations?: { cpus?: string; memory?: string } } }
  depends_on?: Record<string, { condition?: string }>
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
const workerServices = ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
for (const name of ['api', ...workerServices, 'clamav', 'postgres', 'redis']) assert.ok(services[name], `Compose service ${name} is required`)

assertResources('api', services.api!, '2.0', '4G')
for (const name of workerServices) assertResources(name, services[name]!, '2.0', '4G')
assertResources('postgres', services.postgres!, '4.0', '4G')
assertResources('redis', services.redis!, '1.0', '4G')
assertResources('clamav', services.clamav!, '2.0', '4G')

const apiEnv = environment(services.api!)
assert.deepEqual(services.api!.dns, ['1.1.1.1', '8.8.8.8'], 'API must have explicit external DNS fallbacks')
assert.equal(apiEnv.NODE_ENV, 'development')
assert.equal(apiEnv.CONNECTOR_FIXTURE_MODE, 'true')
assert.equal(apiEnv.PLUGIN_WRITE_ENABLED, 'false')
assert.equal(apiEnv.ALLOW_LOCAL_ASSET_SCAN_FIXTURE, 'false', 'real scanner must be the local default')
assert.equal(apiEnv.ASSET_SCANNER_MODE, 'clamav_worker')
assert.ok(apiEnv.ASSET_SCAN_POLICY_VERSION, 'scanner policy version must be explicit')
assert.ok(apiEnv.ASSET_SCANNER_API_TOKEN, 'API scanner callback token input must exist')
assert.ok(apiEnv.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET, 'API scanner workspace signature input must exist')
assert.ok('ASSET_SCAN_TRUSTED_PUBLIC_KEYS' in apiEnv, 'API scanner trust-root input must exist')
assert.ok(apiEnv.DATABASE_URL?.startsWith('postgres://'), 'API must use PostgreSQL in Compose')
assert.ok(apiEnv.OPS_DATABASE_URL?.startsWith('postgres://'), 'API must isolate platform control-plane tables behind a dedicated PostgreSQL role')
assert.notEqual(apiEnv.OPS_DATABASE_URL, apiEnv.DATABASE_URL, 'Ops and tenant runtime database credentials must be distinct')
assert.ok(apiEnv.REDIS_URL?.startsWith('redis://'), 'API must use Redis in Compose')
assert.equal(apiEnv.DB_POOL_MAX, '20')
assert.equal(apiEnv.MAX_ACTIVE_JOBS_PER_WORKSPACE, '3')
assert.equal(apiEnv.REQUEST_BODY_LIMIT_BYTES, '52428800')
assert.ok(apiEnv.WORKER_API_CREDENTIALS, 'API must expose the role-scoped worker credential map')
const workerCredentials = JSON.parse(apiEnv.WORKER_API_CREDENTIALS) as Record<string, { token: string; signing_secret: string }>
assert.deepEqual(Object.keys(workerCredentials).sort(), ['automation', 'generation', 'publish', 'reconcile', 'sync'])
assert.equal(new Set(Object.values(workerCredentials).map(value => value.token)).size, 5, 'worker role tokens must be distinct')
assert.equal(new Set(Object.values(workerCredentials).map(value => value.signing_secret)).size, 5, 'worker signing secrets must be distinct')

for (const [index, name] of workerServices.entries()) {
  const workerEnv = environment(services[name]!)
  assert.deepEqual(services[name]!.dns, ['1.1.1.1', '8.8.8.8'], `${name} must have explicit external DNS fallbacks`)
  assert.equal(workerEnv.NODE_ENV, 'production')
  assert.equal(workerEnv.WORKER_ROLE, name.replace('worker-', ''))
  const credential = workerCredentials[workerEnv.WORKER_ROLE!]
  if (name === 'worker-scan') {
    assert.equal(workerEnv.WORKER_API_TOKEN, workerEnv.ASSET_SCANNER_API_TOKEN, 'worker-scan must use its independent scanner token')
    assert.equal(workerEnv.WORKER_API_SIGNING_SECRET, workerEnv.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET, 'worker-scan must use its independent scanner signing secret')
  } else {
    assert.equal(workerEnv.WORKER_API_TOKEN, credential?.token, `${name} must receive only its role token`)
    assert.equal(workerEnv.WORKER_API_SIGNING_SECRET, credential?.signing_secret, `${name} must receive only its role signing secret`)
  }
  assert.equal(workerEnv.WORKER_WORKSPACES, 'auto')
  assert.equal(workerEnv.WORKER_DB_POOL_MAX, '5')
  assert.equal(workerEnv.WORKER_POLL_INTERVAL_MS, '500')
  assert.equal(workerEnv.STORAGE_RECONCILIATION_INTERVAL_MS, '900000')
  assert.equal(workerEnv.WORKER_BATCH_SIZE, '100')
  assert.equal(workerEnv.WORKER_WORKSPACE_BATCH_SIZE, '10')
  assert.equal(workerEnv.WORKER_LEASE_MS, '900000')
  assert.equal(workerEnv.WORKER_API_TIMEOUT_MS, '360000')
  assert.equal(workerEnv.WORKER_DEPENDENCY_CHECK_INTERVAL_MS, '10000')
  assert.ok(workerEnv.DATABASE_URL?.startsWith('postgres://'), `Worker ${index} must use PostgreSQL`)
  assert.ok(workerEnv.REDIS_URL?.startsWith('redis://'), `Worker ${index} must use Redis`)
}

const scannerEnv = environment(services['worker-scan']!)
assert.equal(scannerEnv.WORKER_ROLE, 'scan')
assert.equal(scannerEnv.CLAMAV_HOST, 'clamav')
assert.equal(scannerEnv.CLAMAV_PORT, '3310')
assert.equal(scannerEnv.CLAMAV_MAX_FILE_BYTES, '52428800')
assert.equal(scannerEnv.ASSET_SCANNER_TIMEOUT_MS, '90000')
assert.equal(scannerEnv.WORKER_SCAN_MAX_ATTEMPTS, '12')
assert.equal(scannerEnv.WORKER_SCAN_RETRY_BASE_MS, '5000')
assert.equal(scannerEnv.WORKER_SCAN_RETRY_MAX_MS, '900000')
assert.ok(scannerEnv.ASSET_SCANNER_API_TOKEN, 'scanner callback token must be injected independently')
assert.ok(scannerEnv.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET, 'scanner workspace signing secret must be injected independently')
assert.ok(scannerEnv.ASSET_SCAN_RECEIPT_KEY_ID, 'scanner receipt key id must be explicit')
assert.ok('ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM' in scannerEnv, 'scanner receipt signing key input must exist')
assert.ok(Object.values(workerCredentials).every(value => value.token !== scannerEnv.ASSET_SCANNER_API_TOKEN), 'scanner must not share a normal worker token')
assert.ok(Object.values(workerCredentials).every(value => value.signing_secret !== scannerEnv.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET), 'scanner must not share a normal worker signing secret')
assert.equal(services['worker-scan']!.depends_on?.clamav?.condition, 'service_healthy', 'scan worker must wait for fresh and reachable ClamAV')
assert.ok(services.clamav!.healthcheck?.test?.some(value => value.includes('clamdscan --ping')), 'ClamAV PING healthcheck is required')
assert.ok(services.clamav!.healthcheck?.test?.some(value => value.includes('clamdscan --version')), 'ClamAV freshness must inspect the running daemon, not only files on disk')
assert.ok(services.clamav!.healthcheck?.test?.some(value => value.includes('86400')), 'ClamAV running definitions older than 24 hours must fail closed')
assert.match(services.clamav!.image ?? '', /^clamav\/clamav-debian@sha256:[0-9a-f]{64}$/u, 'ClamAV must use the official multi-arch Debian image at an immutable digest')
assert.equal(services.clamav!.platform, undefined, 'local ClamAV must select the native host architecture instead of forcing QEMU')
const clamavEnv = environment(services.clamav!)
assert.equal(clamavEnv.FRESHCLAM_CHECKS, '24', 'ClamAV must check signatures hourly before the 24-hour freshness gate')
const clamavSupervisor = readFileSync('infra/local/clamav-supervisor.sh', 'utf8')
assert.match(clamavSupervisor, /wait -n "\$freshclam_pid" "\$clamd_pid"/u, 'ClamAV PID 1 must observe either daemon exiting')
assert.match(clamavSupervisor, /shutdown_children/u, 'ClamAV PID 1 must stop the sibling daemon before exiting')

assert.equal(services.postgres!.image, 'postgres:16-alpine')
assert.equal(services.redis!.image, 'redis:7-alpine')
assert.ok(services.postgres!.healthcheck?.test?.some(value => value.includes('pg_isready')), 'Postgres healthcheck is required')
assert.ok(services.redis!.healthcheck?.test?.some(value => value.includes('redis-cli')), 'Redis healthcheck is required')
for (const name of workerServices) {
  assert.ok(services[name]!.healthcheck?.test?.some(value => value.includes('WORKER_ROLE')), `${name} readiness healthcheck is required`)
  assert.equal(services[name]!.depends_on?.api?.condition, 'service_healthy', `${name} must wait for API readiness`)
}

console.log(JSON.stringify({
  profile: 'compose_resource_gate',
  localOnly: true,
  cloudGate: false,
  services: ['api', ...workerServices, 'clamav', 'postgres', 'redis'],
  resources: {
    api: { cpus: 2, memory: '4G' },
    workers: Object.fromEntries(workerServices.filter(name => name !== 'worker-automation').map(name => [name, { cpus: 2, memory: '4G' }])),
    postgres: { cpus: 4, memory: '4G' },
    redis: { cpus: 1, memory: '4G' },
    clamav: { cpus: 2, memory: '4G', immutableDigestRequiredForProduction: true },
  },
  status: 'pass',
}))
